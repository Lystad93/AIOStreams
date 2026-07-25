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

export type MatchTier = 'exact-file' | 'exact-release' | 'similar';

export interface MatchResult {
  /** 0–100, what we show the user. */
  score: number;
  tier: MatchTier;
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

function tokenise(name: string): Set<string> {
  const canonical = normaliseReleaseName(name);
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
    if (normaliseReleaseName(claimed) === ourKey) {
      return { score: 100, tier: 'exact-release' };
    }
  }

  const ourTokens = tokenise(ourFilename ?? '');
  let best = 0;
  for (const claimed of claimedReleaseNames) {
    best = Math.max(best, diceScore(ourTokens, tokenise(claimed)));
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
