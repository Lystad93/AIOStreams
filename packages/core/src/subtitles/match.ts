/**
 * Scoring an externally-sourced subtitle against the release actually playing
 * (spec §4.5). Produces the confidence shown to the user, so it has to be
 * honest: 100% is reserved for evidence, not for a good-looking guess.
 *
 * Tiers, strongest first:
 *   `exact-file`    — the provider matched on the video's hash. Definitive.
 *   `exact-release` — a claimed release name canonicalises to ours (§ addon
 *                     spellings already normalised by `normaliseReleaseName`).
 *   `similar`       — token overlap, reported as its real percentage.
 */
import { normaliseReleaseName } from './release-name.js';
import { normaliseLanguage } from '../utils/languages.js';

/**
 * A subtitle site's copy of a release name, with its own language tag removed
 * (`…-CiNEPHiLES.dan` on SubSource, `….eng` on others).
 *
 * Applied only to the CLAIMED name, never to ours: `normaliseReleaseName` is a
 * storage key (duration index, stored-subtitle lookup) and has to stay
 * conservative, whereas this is purely a matching concession. Gated on the
 * token really being a language, since a bare 2–3 letter suffix is otherwise
 * indistinguishable from a short release group.
 */
function claimedKey(name: string): string {
  const key = normaliseReleaseName(name);
  const match = key.match(/\s([a-z]{2,3})$/);
  if (!match) return key;
  return normaliseLanguage(match[1]) ? key.slice(0, -match[0].length) : key;
}

export type MatchTier = 'exact-file' | 'exact-release' | 'similar';

export interface MatchResult {
  /** 0–100, what we show the user. */
  score: number;
  tier: MatchTier;
  /**
   * The candidate's release is known to run for the same time as the one being
   * played. Reported separately from `score` rather than folded into it: a name
   * can look unlike ours (an extra `HDR` token, a 60fps AI-interpolated remux)
   * while the runtime — and therefore the subtitle timing — is identical.
   */
  durationMatched?: boolean;
}

/**
 * Runtime tolerance, as the spec's `max(N seconds, X% of runtime)` (§4.5).
 * A fixed floor alone is wrong because recap/credit differences scale with
 * nothing, while a pure percentage under-shoots short episodes and over-shoots
 * long films. Durations parsed from addon descriptions are usually
 * minute-granular, so the floor also absorbs rounding.
 */
export function durationsMatch(
  a: number | undefined,
  b: number | undefined,
  opts: { toleranceSeconds: number; tolerancePercent: number }
): boolean {
  if (!a || !b || a <= 0 || b <= 0) return false;
  const tolerance = Math.max(
    opts.toleranceSeconds * 1000,
    (Math.max(a, b) * opts.tolerancePercent) / 100
  );
  return Math.abs(a - b) <= tolerance;
}

/**
 * Tokens that say nothing about which release this is — every release has a
 * title and most share container/codec noise — so they'd inflate similarity
 * between unrelated releases.
 */
const NOISE_TOKENS = new Set([
  'the',
  'a',
  'an',
  'and',
  'of',
  'srt',
  'ass',
  'ssa',
  'sub',
  'subs',
  'en',
  'eng',
  'english',
]);

function tokenise(name: string, claimed = false): Set<string> {
  const canonical = claimed ? claimedKey(name) : normaliseReleaseName(name);
  if (!canonical) return new Set();
  return new Set(
    canonical
      .split(/[\s.\-_]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !NOISE_TOKENS.has(t))
  );
}

/** Sørensen–Dice overlap of two token sets, as a 0–100 integer. */
function diceScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return Math.round((200 * shared) / (a.size + b.size));
}

/**
 * Best match between the playing release and the release names a candidate
 * claims. `moviehashMatched` short-circuits to the definitive tier.
 */
export function scoreRelease(
  ourFilename: string | undefined,
  claimedReleaseNames: string[],
  opts: { moviehashMatched?: boolean } = {}
): MatchResult {
  if (opts.moviehashMatched) return { score: 100, tier: 'exact-file' };

  const ourKey = normaliseReleaseName(ourFilename);
  if (!ourKey) return { score: 0, tier: 'similar' };

  // An exact canonical match is real evidence: both sides went through the same
  // normalisation, so extension/separator/re-upload noise is already gone.
  for (const claimed of claimedReleaseNames) {
    if (claimedKey(claimed) === ourKey) {
      return { score: 100, tier: 'exact-release' };
    }
  }

  const ourTokens = tokenise(ourFilename ?? '');
  let best = 0;
  for (const claimed of claimedReleaseNames) {
    best = Math.max(best, diceScore(ourTokens, tokenise(claimed, true)));
  }
  // Never let a token overlap claim 100 — that tier means verified identity.
  return { score: Math.min(best, 99), tier: 'similar' };
}

/** Does this filename look like the season/episode we're watching? */
export function matchesEpisode(
  name: string,
  want: { season?: number; episode?: number }
): boolean {
  if (want.season == null || want.episode == null) return true;
  const s = String(want.season);
  const e = String(want.episode);
  const patterns = [
    new RegExp(`s0*${s}[._\\s-]*e0*${e}(?!\\d)`, 'i'),
    new RegExp(`(?<!\\d)0*${s}x0*${e}(?!\\d)`, 'i'),
  ];
  return patterns.some((re) => re.test(name));
}
