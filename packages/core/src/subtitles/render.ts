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
import {
  DEFAULT_DETAIL,
  DEFAULT_HEADER,
  type HeaderToken,
} from './display-tokens.js';
export * from './display-tokens.js';

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

// ---------------------------------------------------------------------------
// Token-driven rendering
// ---------------------------------------------------------------------------

/**
 * Pieces a user can switch on and reorder for each of the two lines.
 *
 * `langCode` is the Stremio-standard one: the SDK expects `lang` to be an
 * ISO 639-2 code, and players that resolve it strictly will show a row whose
 * `lang` is decorated text as "Unknown". Keeping it a token means a user can
 * choose readability or compatibility per line rather than us guessing.
 */
/**
 * What the row will do if clicked, or what has already happened to it.
 *
 * Without this every row renders identically — the score and source say nothing
 * about whether a translation exists, is running, or has yet to be started.
 */
export type RowState = 'offer' | 'running' | 'done' | 'failed' | 'ready';

export interface RenderContext {
  state?: RowState;
  /** `25→23.976` when the subtitle had to be retimed to fit. */
  fpsConversion?: string;
  targetLang?: string;
  sourceLang?: string;
  rank?: number;
  score?: number;
  etaText?: string;
  provider?: string;
  machineSource?: boolean;
  duration?: DurationState;
  diffs?: FieldDiff[];
  seasonPack?: boolean;
  seasonLabel?: string;
  subDurationMs?: number;
  streamDurationMs?: number;
}

/** Lowercase ISO 639-2 — the form the Stremio SDK documents for `lang`. */
export function standardLangCode(language?: string): string {
  return langCode3(language).toLowerCase();
}

function renderToken(token: string, ctx: RenderContext): string {
  switch (token) {
    case 'rank':
      return ctx.rank && ctx.rank > 0 ? `${ctx.rank}#` : '';
    case 'langCode':
      return standardLangCode(ctx.targetLang ?? ctx.sourceLang);
    case 'languages': {
      if (ctx.targetLang) {
        const target = langCode3(ctx.targetLang);
        const source = ctx.sourceLang ? langCode3(ctx.sourceLang) : undefined;
        return source && source !== target
          ? `${target}${arrow()}${source}`
          : target;
      }
      return langCode3(ctx.sourceLang);
    }
    case 'score':
      return ctx.score != null ? `${Math.round(ctx.score)}%` : '';
    case 'state': {
      const embedded = ctx.provider === 'embedded';
      switch (ctx.state) {
        case 'offer':
          // Names the origin here because an embedded translation is the one
          // that costs a full download — worth stating before the click.
          return embedded ? '(Translate Embedded)' : '(Translate)';
        case 'running':
          return '(…in progress)';
        case 'done':
          return '(Finished translation)';
        case 'failed':
          return '(Retry translation)';
        case 'ready':
          return '(Ready to use)';
        default:
          return '';
      }
    }
    case 'eta':
      return ctx.etaText ? `(${ctx.etaText})` : '';
    case 'pack':
      return ctx.seasonPack && ctx.seasonLabel ? `(${ctx.seasonLabel})` : '';
    case 'duration':
      return ctx.duration
        ? durationGroup(ctx.duration, ctx.subDurationMs, ctx.streamDurationMs)
        : '';
    case 'diffs':
      return diffGroups(ctx.diffs ?? []);
    case 'mt':
      return ctx.machineSource ? '(MT)' : '';
    case 'fps':
      // Only ever present on a rescued row, so its absence is meaningful:
      // no marker means the subtitle fit without being touched.
      return ctx.fpsConversion ? `(${ctx.fpsConversion})` : '';
    case 'source': {
      const s = sourceToken(ctx.provider, ctx.rank);
      return s ? `(${s})` : '';
    }
    default:
      return '';
  }
}

/**
 * The header line. Tokens are space-separated because this is prose-like text
 * the player renders large; empty tokens vanish rather than leaving gaps.
 */
export function renderHeader(
  tokens: readonly string[] | undefined,
  ctx: RenderContext
): string {
  const parts = (tokens?.length ? tokens : DEFAULT_HEADER)
    .map((tok) => renderToken(tok, ctx))
    .filter(Boolean);
  // Never return an empty header: a row with no `lang` is invalid, and a
  // player would rather show a language code than nothing.
  return parts.join(' ') || standardLangCode(ctx.targetLang ?? ctx.sourceLang);
}

/**
 * The detail line. Parenthesised groups concatenate with no separator; the
 * score and ETA are bare, so a space joins only those.
 */
export function renderDetail(
  tokens: readonly string[] | undefined,
  ctx: RenderContext
): string {
  const list = tokens?.length ? tokens : DEFAULT_DETAIL;
  let out = '';
  for (const tok of list) {
    const piece = renderToken(tok, ctx);
    if (!piece) continue;
    // A bare token (score) followed by a parenthesised one needs no space;
    // two bare tokens do.
    const needsSpace =
      out.length > 0 && !piece.startsWith('(') && !out.endsWith(' ');
    out += (needsSpace ? ' ' : '') + piece;
  }
  return out;
}
