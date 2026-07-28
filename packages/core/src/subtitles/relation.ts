/**
 * Relation classification and scoring for a subtitle candidate against the
 * stream actually playing (subtitle-match spec §2, §4, §5, §6).
 *
 * The central idea is that diffing runs on PARSED METADATA FIELDS, never on raw
 * filename tokens. Tokenising a release name produces noise that looks like
 * signal (`H264` vs `H.264`) and misses signal that doesn't look like a token
 * (`AMZN` buried between dots), so every comparison here goes through the same
 * `FileParser` the stream list already uses.
 *
 * Each field belongs to exactly one tier, ordered by how much it can affect
 * whether the subtitle's timing lines up:
 *
 *   ID  identity  — a mismatch is a REJECT, not a low score
 *   H   high      — different master or edit; caps the score below 100
 *   M   medium    — different lineage, so possible framerate/telecine drift
 *   Z   zero      — cosmetic; never reduces the score
 */
import { appConfig } from '../utils/index.js';
import { settingsStore } from '../config/index.js';
import FileParser from '../parser/file.js';
import type { ParsedFile } from '../db/schemas.js';
import { normaliseReleaseName } from './release-name.js';

export type Relation = 'IDENTICAL' | 'COSMETIC' | 'MATERIAL' | 'UNRELATED';

export type DurationState =
  | 'EQUAL'
  | 'UNEQUAL'
  | 'UNKNOWN_BOTH'
  | 'UNKNOWN_SUB'
  | 'UNKNOWN_STREAM';

export type Tier = 'H' | 'M' | 'Z';

export interface FieldDiff {
  tier: Tier;
  field: string;
  /**
   * `+` is the subtitle's value (it differs, or the stream has none); `-` is a
   * value the stream has that the subtitle lacks entirely. The stream's
   * competing value is never printed — it is already visible in the row above.
   */
  sign: '+' | '-';
  value: string;
}

export interface RelationResult {
  /** Identity contradiction: drop the candidate, never render it. */
  rejected: boolean;
  relation: Relation;
  diffs: FieldDiff[];
  /** `season` present, `episode` absent — a whole-season container (§4.1). */
  seasonPack: boolean;
  /** Zero-padded season, for the `(S01)` marker. */
  seasonLabel?: string;
}

/** Field priority inside each tier, for the description's sort order (§7.2). */
const H_FIELDS = [
  'network',
  'editionTag',
  'revisionTag',
  'releaseGroup',
] as const;
const M_FIELDS = ['sourceType'] as const;
const Z_FIELDS = [
  'resolution',
  'videoCodec',
  'visualTags',
  'audioTags',
  'bitDepth',
  'container',
] as const;

/**
 * IMAX is an EDITION, not a visual tag: an IMAX cut has different
 * aspect-ratio-driven scene lengths, which is a sync concern rather than a
 * cosmetic one. The parser reports it among the visual tags, so it is rerouted
 * here (spec §2, note).
 */
const EDITION_VISUAL_TAGS = new Set(['imax', 'open matte', 'remux']);

export interface ReleaseMeta {
  /** Tier ID */
  title?: string;
  year?: string;
  season?: number;
  episode?: number;
  /** Tier H */
  network?: string;
  editionTag: string[];
  revisionTag: string[];
  releaseGroup?: string;
  /** Tier M */
  sourceType?: string;
  /** Tier Z */
  resolution?: string;
  videoCodec?: string;
  visualTags: string[];
  audioTags: string[];
  container?: string;
  /** True when the name describes a whole season rather than one episode. */
  seasonPack: boolean;
  /** False when the filename was absent or parsed to nothing usable. */
  parseable: boolean;
}

function norm(v?: string): string | undefined {
  const s = v?.trim().toLowerCase();
  return s ? s : undefined;
}

/** Parse a release name into the tiered shape this module compares on. */
export function parseReleaseMeta(filename?: string): ReleaseMeta {
  const empty: ReleaseMeta = {
    editionTag: [],
    revisionTag: [],
    visualTags: [],
    audioTags: [],
    seasonPack: false,
    parseable: false,
  };
  if (!filename?.trim()) return empty;

  let parsed: ParsedFile;
  try {
    parsed = FileParser.parse(filename);
  } catch {
    return empty;
  }
  return fromParsedFile(parsed);
}

/** Build the tiered shape from an already-parsed file (the stream-list case). */
export function fromParsedFile(parsed: ParsedFile): ReleaseMeta {
  const visual = (parsed.visualTags ?? []).map((t) => t.toLowerCase());
  const editions = (parsed.editions ?? []).map((e) => e.toLowerCase());
  // Route IMAX-like tags out of Tier Z and into the edition set.
  const reroutedEditions = visual.filter((t) => EDITION_VISUAL_TAGS.has(t));

  const revision: string[] = [];
  if (parsed.proper) revision.push('proper');
  if (parsed.repack) revision.push('repack');

  const season = parsed.seasons?.length === 1 ? parsed.seasons[0] : undefined;
  const episode =
    parsed.episodes?.length === 1 ? parsed.episodes[0] : undefined;

  return {
    title: norm(parsed.title),
    year: norm(parsed.year),
    season,
    episode,
    network: norm(parsed.network),
    editionTag: [...new Set([...editions, ...reroutedEditions])].sort(),
    revisionTag: revision.sort(),
    releaseGroup: norm(parsed.releaseGroup),
    sourceType: norm(parsed.quality),
    resolution: norm(parsed.resolution),
    videoCodec: norm(parsed.encode),
    visualTags: visual.filter((t) => !EDITION_VISUAL_TAGS.has(t)).sort(),
    audioTags: (parsed.audioTags ?? []).map((t) => t.toLowerCase()).sort(),
    container: norm(parsed.container),
    // A pack is a season with no single episode — either a real archive or an
    // entry that simply hasn't been expanded yet.
    seasonPack: !!parsed.seasonPack || (season != null && episode == null),
    parseable: !!(parsed.title || parsed.releaseGroup || parsed.resolution),
  };
}

/**
 * Tier-ID gate. Only a field PRESENT ON BOTH sides and different rejects —
 * absent is unknown, not contradictory.
 *
 * That asymmetry is what admits season packs: a pack named `…S01…` carries no
 * episode, so against `S01E05` it survives rather than being rejected on a null.
 */
function identityContradicts(a: ReleaseMeta, b: ReleaseMeta): boolean {
  if (a.title && b.title && a.title !== b.title) return true;
  if (a.year && b.year && a.year !== b.year) return true;
  if (a.season != null && b.season != null && a.season !== b.season)
    return true;
  if (a.episode != null && b.episode != null && a.episode !== b.episode) {
    return true;
  }
  return false;
}

/** Diff one scalar field, emitting at most one group. */
function diffScalar(
  tier: Tier,
  field: string,
  sub?: string,
  stream?: string
): FieldDiff[] {
  if (sub && stream && sub !== stream) {
    return [{ tier, field, sign: '+', value: sub }];
  }
  if (sub && !stream) return [{ tier, field, sign: '+', value: sub }];
  if (!sub && stream) return [{ tier, field, sign: '-', value: stream }];
  return [];
}

/** Diff a set-valued field, emitting one group per differing member. */
function diffSet(
  tier: Tier,
  field: string,
  sub: string[],
  stream: string[]
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const v of sub)
    if (!stream.includes(v)) out.push({ tier, field, sign: '+', value: v });
  for (const v of stream)
    if (!sub.includes(v)) out.push({ tier, field, sign: '-', value: v });
  return out;
}

export function fieldDiff(sub: ReleaseMeta, stream: ReleaseMeta): FieldDiff[] {
  return [
    ...diffScalar('H', 'network', sub.network, stream.network),
    ...diffSet('H', 'editionTag', sub.editionTag, stream.editionTag),
    ...diffSet('H', 'revisionTag', sub.revisionTag, stream.revisionTag),
    ...diffScalar('H', 'releaseGroup', sub.releaseGroup, stream.releaseGroup),
    ...diffScalar('M', 'sourceType', sub.sourceType, stream.sourceType),
    ...diffScalar('Z', 'resolution', sub.resolution, stream.resolution),
    ...diffScalar('Z', 'videoCodec', sub.videoCodec, stream.videoCodec),
    ...diffSet('Z', 'visualTags', sub.visualTags, stream.visualTags),
    ...diffSet('Z', 'audioTags', sub.audioTags, stream.audioTags),
    // Only when both sides have one: a release name written without an
    // extension is not a different release, and normalisation strips
    // extensions regardless.
    ...(sub.container && stream.container
      ? diffScalar('Z', 'container', sub.container, stream.container)
      : []),
  ];
}

/** Order diffs H → M → Z, then by the fixed within-tier priority (§7.2). */
export function sortDiffs(diffs: FieldDiff[]): FieldDiff[] {
  const tierRank: Record<Tier, number> = { H: 0, M: 1, Z: 2 };
  const fieldRank = (f: string): number => {
    const all = [...H_FIELDS, ...M_FIELDS, ...Z_FIELDS] as readonly string[];
    const i = all.indexOf(f);
    return i === -1 ? all.length : i;
  };
  return [...diffs].sort(
    (a, b) =>
      tierRank[a.tier] - tierRank[b.tier] ||
      fieldRank(a.field) - fieldRank(b.field) ||
      a.value.localeCompare(b.value)
  );
}

export function classifyRelation(
  subFilename: string | undefined,
  streamFilename: string | undefined,
  opts: { subMeta?: ReleaseMeta; streamMeta?: ReleaseMeta } = {}
): RelationResult {
  const sub = opts.subMeta ?? parseReleaseMeta(subFilename);
  const stream = opts.streamMeta ?? parseReleaseMeta(streamFilename);

  const seasonLabel =
    sub.seasonPack && sub.season != null
      ? `S${String(sub.season).padStart(2, '0')}`
      : undefined;

  if (identityContradicts(sub, stream)) {
    return {
      rejected: true,
      relation: 'UNRELATED',
      diffs: [],
      seasonPack: sub.seasonPack,
      seasonLabel,
    };
  }

  // No usable filename (typical of OpenSubtitles entries that carry no release
  // name): only the duration path can lift this above the floor.
  if (!subFilename?.trim() || !sub.parseable) {
    return {
      rejected: false,
      relation: 'UNRELATED',
      diffs: [],
      seasonPack: sub.seasonPack,
      seasonLabel,
    };
  }

  const identical =
    !!normaliseReleaseName(subFilename) &&
    normaliseReleaseName(subFilename) === normaliseReleaseName(streamFilename);

  const diffs = sortDiffs(fieldDiff(sub, stream));
  // A pack's key always differs from an episode's by the episode marker alone,
  // so the key test can never call it identical. Judge it on its other fields:
  // a pack from the identical release is exactly the case §4.1 wants scored
  // high before the flat penalty applies.
  if (sub.seasonPack && diffs.length === 0) {
    return {
      rejected: false,
      relation: 'IDENTICAL',
      diffs,
      seasonPack: true,
      seasonLabel,
    };
  }
  if (identical) {
    return {
      rejected: false,
      relation: 'IDENTICAL',
      diffs,
      seasonPack: sub.seasonPack,
      seasonLabel,
    };
  }

  const hasMaterial = diffs.some((d) => d.tier === 'H' || d.tier === 'M');
  return {
    rejected: false,
    // An empty diff set with differing keys means ordering or junk we couldn't
    // attribute — stay cautious rather than claiming identity.
    relation: hasMaterial ? 'MATERIAL' : 'COSMETIC',
    diffs,
    seasonPack: sub.seasonPack,
    seasonLabel,
  };
}

function toleranceMs(): number {
  if (!settingsStore.initialised) return 2000;
  return appConfig.subtitles.durationToleranceMs;
}

/**
 * Exact equality never fires in practice — addons round differently and encodes
 * pad the tail — so a small tolerance is the working definition of "same cut".
 */
export function compareDuration(
  subMs: number | undefined,
  streamMs: number | undefined
): DurationState {
  const hasSub = !!subMs && subMs > 0;
  const hasStream = !!streamMs && streamMs > 0;
  if (!hasSub && !hasStream) return 'UNKNOWN_BOTH';
  if (!hasSub) return 'UNKNOWN_SUB';
  if (!hasStream) return 'UNKNOWN_STREAM';
  return Math.abs(subMs! - streamMs!) <= toleranceMs() ? 'EQUAL' : 'UNEQUAL';
}

/** The §6 matrix. `UNKNOWN_*` all share the UNKNOWN column. */
const SCORES: Record<
  Relation,
  { EQUAL: number; UNKNOWN: number; UNEQUAL: number }
> = {
  IDENTICAL: { EQUAL: 100, UNKNOWN: 100, UNEQUAL: 90 },
  COSMETIC: { EQUAL: 100, UNKNOWN: 95, UNEQUAL: 60 },
  MATERIAL: { EQUAL: 90, UNKNOWN: 70, UNEQUAL: 50 },
  UNRELATED: { EQUAL: 90, UNKNOWN: 50, UNEQUAL: 40 },
};

export function scoreFor(relation: Relation, duration: DurationState): number {
  const col =
    duration === 'EQUAL'
      ? 'EQUAL'
      : duration === 'UNEQUAL'
        ? 'UNEQUAL'
        : 'UNKNOWN';
  return SCORES[relation][col];
}

export interface ScoredCandidate {
  score: number;
  relation: Relation;
  duration: DurationState;
  diffs: FieldDiff[];
  seasonPack: boolean;
  seasonLabel?: string;
  /** The subtitle's own runtime, for the description's duration group. */
  subDurationMs?: number;
  rejected: boolean;
}

/**
 * Full evaluation of one candidate: gate, relation, duration, score.
 *
 * An unresolved season pack has its duration forced to UNKNOWN (a container has
 * no meaningful runtime) and then takes a flat penalty — scoring it on its own
 * non-episode fields first is the point, because a pack from the identical
 * release is strong evidence the episode inside will sync (§4.1).
 */
export function evaluateCandidate(args: {
  subFilename?: string;
  streamFilename?: string;
  subDurationMs?: number;
  streamDurationMs?: number;
  /** Extraction from the playing file bypasses the matrix entirely. */
  embedded?: boolean;
}): ScoredCandidate {
  if (args.embedded) {
    return {
      score: 100,
      relation: 'IDENTICAL',
      duration: 'EQUAL',
      diffs: [],
      seasonPack: false,
      rejected: false,
      subDurationMs: args.subDurationMs,
    };
  }

  const rel = classifyRelation(args.subFilename, args.streamFilename);
  if (rel.rejected) {
    return {
      score: 0,
      relation: rel.relation,
      duration: 'UNKNOWN_BOTH',
      diffs: [],
      seasonPack: rel.seasonPack,
      seasonLabel: rel.seasonLabel,
      rejected: true,
    };
  }

  const duration = rel.seasonPack
    ? 'UNKNOWN_SUB'
    : compareDuration(args.subDurationMs, args.streamDurationMs);

  let score = scoreFor(rel.relation, duration);
  if (rel.seasonPack) {
    score = Math.max(score - seasonPackPenalty(), minDisplayScore());
  }

  return {
    score,
    relation: rel.relation,
    duration,
    diffs: rel.diffs,
    seasonPack: rel.seasonPack,
    seasonLabel: rel.seasonLabel,
    subDurationMs: rel.seasonPack ? undefined : args.subDurationMs,
    rejected: false,
  };
}

export function seasonPackPenalty(): number {
  if (!settingsStore.initialised) return 10;
  return appConfig.subtitles.seasonPackPenalty;
}

export function minDisplayScore(): number {
  if (!settingsStore.initialised) return 50;
  return appConfig.subtitles.minDisplayScore;
}
