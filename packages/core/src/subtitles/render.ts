/**
 * Label and description grammar for subtitle rows (subtitle-match spec §7).
 *
 *   label:       <KIND><TARGET><ARROW><SOURCE> <SCORE>%[ (<ETA>)]
 *   description: <pack><duration><differences><source>
 *
 * Parenthesised groups concatenate with NO separator. A `-` between groups
 * would collide with the `-` that marks "the stream has this, the subtitle
 * doesn't", and `(X-1h53m28s)-(-DV)-(SubDL)` is unreadable. Empty groups are
 * omitted entirely — never `()`.
 */
import { appConfig } from '../utils/index.js';
import { settingsStore } from '../config/index.js';
import { languageToCode } from '../utils/languages.js';
import type { DurationState, FieldDiff, ScoredCandidate } from './relation.js';

export type DiffVerbosity = 'minimal' | 'normal' | 'full';

/**
 * ISO 639-1 → 639-2/B, for the codes the label uses.
 *
 * Deliberately explicit rather than derived: 639-2/B is the *bibliographic*
 * set, where several codes (ger not deu, fre not fra, dut not nld, chi not zho)
 * differ from the terminology set a generic converter would return.
 */
const ISO_639_2B: Record<string, string> = {
  no: 'NOR',
  nb: 'NOR',
  nn: 'NNO',
  en: 'ENG',
  sv: 'SWE',
  da: 'DAN',
  fi: 'FIN',
  is: 'ICE',
  de: 'GER',
  fr: 'FRE',
  es: 'SPA',
  it: 'ITA',
  nl: 'DUT',
  pt: 'POR',
  pl: 'POL',
  ru: 'RUS',
  ja: 'JPN',
  ko: 'KOR',
  zh: 'CHI',
  ar: 'ARA',
  tr: 'TUR',
  he: 'HEB',
  hi: 'HIN',
  cs: 'CZE',
  el: 'GRE',
  hu: 'HUN',
  ro: 'RUM',
  uk: 'UKR',
  vi: 'VIE',
  th: 'THA',
  id: 'IND',
};

/** Uppercase 3-letter code for a display language name, e.g. "Norwegian" → NOR. */
export function langCode3(language?: string): string {
  if (!language) return '???';
  const two = languageToCode(language)?.toLowerCase();
  if (two && ISO_639_2B[two]) return ISO_639_2B[two];
  const raw = language.trim().toLowerCase();
  if (ISO_639_2B[raw]) return ISO_639_2B[raw];
  // Already a 3-letter code, or an unmapped language: fall back to its own
  // first three letters rather than printing nothing.
  return raw.slice(0, 3).toUpperCase();
}

function cfg<T>(read: () => T, fallback: T): T {
  return settingsStore.initialised ? read() : fallback;
}

function arrow(): string {
  return cfg(() => appConfig.subtitles.unicodeArrow, false) ? '←' : '<';
}

/** `1h53m28s`, `53m28s` under an hour, `28s` under a minute. No colons. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatSignedDelta(deltaMs: number): string {
  const sign = deltaMs >= 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.abs(deltaMs))}`;
}

export interface LabelParts {
  /** Present for a translation row; absent for direct use. */
  targetLang?: string;
  /** The subtitle's own language. Omitted when it equals the target. */
  sourceLang?: string;
  /**
   * Position in the ranked candidate list, shared between the "use" and
   * "translate" rows for one candidate so the two lists line up. Omitted when
   * there is only one candidate — a lone `1#` is noise.
   */
  rank?: number;
}

/**
 * The language header Stremio shows: rank and languages only.
 *
 * Everything quantitative (score, ETA, differences, source) lives in the detail
 * line instead — the header is what the player renders largest, and at that
 * size the languages are the only part worth reading at a glance.
 */
export function buildLabel(parts: LabelParts): string {
  const prefix = parts.rank && parts.rank > 0 ? `${parts.rank}# ` : '';
  if (parts.targetLang) {
    const target = langCode3(parts.targetLang);
    const source = parts.sourceLang ? langCode3(parts.sourceLang) : undefined;
    return source && source !== target
      ? `${prefix}${target}${arrow()}${source}`
      : `${prefix}${target}`;
  }
  return `${prefix}${langCode3(parts.sourceLang)}`;
}

/**
 * Canonical network name (as the parser resolves it) → the scene token that
 * actually appears in release names.
 *
 * The parser expands `AMZN` to `amazon` so that every spelling maps to one
 * value, which is right for comparison and wrong for display: the description
 * has to read like the filename the user is looking at.
 */
const NETWORK_TOKENS: Record<string, string> = {
  amazon: 'AMZN',
  itunes: 'iT',
  netflix: 'NF',
  disney: 'DSNP',
  'disney+': 'DSNP',
  max: 'HMAX',
  hbo: 'HMAX',
  'hbo max': 'HMAX',
  'apple tv+': 'ATVP',
  appletv: 'ATVP',
  peacock: 'PCOK',
  hulu: 'HULU',
  stan: 'STAN',
  paramount: 'PMTP',
  'paramount+': 'PMTP',
  crunchyroll: 'CR',
};

/** Display form of one diff value: scene token where we know it. */
function diffValue(d: FieldDiff): string {
  if (d.field === 'network') {
    const token = NETWORK_TOKENS[d.value.toLowerCase()];
    if (token) return token;
  }
  return d.value.toUpperCase();
}

/** Provider → the short token used in the source group. */
const SOURCE_TOKENS: Record<string, string> = {
  subdl: 'SubDL',
  subsource: 'SubSource',
  opensubtitles: 'OpenSub',
  podnapisi: 'Podnapisi',
  embedded: 'Embedded',
};

/**
 * Provider name in its own casing, suffixed with the candidate's rank so the
 * source group and the row's `N#` prefix refer to the same thing.
 */
export function sourceToken(
  provider?: string,
  rank?: number
): string | undefined {
  if (!provider) return undefined;
  const name = SOURCE_TOKENS[provider.toLowerCase()] ?? provider;
  return rank && rank > 0 ? `${name}-${rank}` : name;
}

function durationGroup(
  state: DurationState,
  subDurationMs?: number,
  streamDurationMs?: number
): string {
  switch (state) {
    case 'EQUAL':
      return '(✓)';
    case 'UNKNOWN_STREAM':
      // The subtitle's runtime is known and the stream's isn't — show what we
      // actually have rather than a bare question mark.
      return subDurationMs ? `(${formatDuration(subDurationMs)})` : '(?)';
    case 'UNEQUAL': {
      if (!subDurationMs) return '(?)';
      const delta =
        cfg(() => appConfig.subtitles.durationDeltaMode, false) &&
        streamDurationMs
          ? formatSignedDelta(subDurationMs - streamDurationMs)
          : formatDuration(subDurationMs);
      return `(X ${delta})`;
    }
    // UNKNOWN_SUB renders as `(?)`, never as the stream's runtime: the stream's
    // figure says nothing about the subtitle, and printing it would imply a
    // comparison that never happened.
    default:
      return '(?)';
  }
}

function diffGroups(diffs: FieldDiff[]): string {
  const verbosity = cfg(
    () => appConfig.subtitles.diffVerbosity as DiffVerbosity,
    'normal'
  );
  const maxTokens = cfg(() => appConfig.subtitles.maxDiffTokens, 6);
  const render = (d: FieldDiff) => `(${d.sign}${diffValue(d)})`;

  if (verbosity === 'minimal') {
    return diffs
      .filter((d) => d.tier !== 'Z')
      .map(render)
      .join('');
  }

  if (verbosity === 'full') {
    const shown = diffs.slice(0, maxTokens).map(render).join('');
    return diffs.length > maxTokens ? `${shown}(…)` : shown;
  }

  // normal: Tier H and M individually, all of Tier Z collapsed to one marker.
  // A Tier-Z difference is by definition information that cannot affect sync —
  // worth one character, not five groups.
  const material = diffs.filter((d) => d.tier !== 'Z');
  const hasCosmetic = diffs.some((d) => d.tier === 'Z');
  return material.map(render).join('') + (hasCosmetic ? '(≠enc)' : '');
}

/**
 * The full description line: pack, duration, differences, source.
 */
export function buildDescription(
  candidate: Pick<
    ScoredCandidate,
    'duration' | 'diffs' | 'seasonPack' | 'seasonLabel' | 'subDurationMs'
  > & { score?: number },
  opts: {
    provider?: string;
    streamDurationMs?: number;
    rank?: number;
    etaText?: string;
    /** Already machine output — worth a warning before translating it again. */
    machineSource?: boolean;
  } = {}
): string {
  const groups: string[] = [];
  // Leads the detail line: the score is the single number the user is
  // choosing on, and the ETA qualifies it for translation rows.
  if (candidate.score != null) {
    groups.push(
      `${Math.round(candidate.score)}%${opts.etaText ? ` (${opts.etaText})` : ''}`
    );
  }
  // Leads, because "this is a whole-season file" is the caveat that most
  // changes how everything after it should be read.
  if (candidate.seasonPack && candidate.seasonLabel) {
    groups.push(`(${candidate.seasonLabel})`);
  }
  groups.push(
    durationGroup(
      candidate.duration,
      candidate.subDurationMs,
      opts.streamDurationMs
    )
  );
  const diffs = diffGroups(candidate.diffs);
  if (diffs) groups.push(diffs);
  if (opts.machineSource) groups.push('(MT)');
  const source = sourceToken(opts.provider, opts.rank);
  if (source) groups.push(`(${source})`);
  return groups.join('');
}
