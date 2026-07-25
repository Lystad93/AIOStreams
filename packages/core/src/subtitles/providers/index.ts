/**
 * External subtitle lookup (spec §4.5): search every configured provider for
 * the release being played, score each result against it, and return the best
 * few. This is the cheap half of the feature — no video is downloaded, so it
 * can run where full extraction is gated off.
 */
import { createLogger } from '../../logging/logger.js';
import { appConfig, normaliseLanguage } from '../../utils/index.js';
import { scoreRelease, durationsMatch, type MatchTier } from '../match.js';
import { normaliseReleaseName } from '../release-name.js';
import type { ReleaseDurationIndex } from '../release-lookup.js';
import { subsourceClient } from './subsource.js';
import { subdlClient } from './subdl.js';
import type {
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  ExternalProviderId,
  SubtitleProviderClient,
} from './types.js';

const logger = createLogger('subtitles');

const CLIENTS: SubtitleProviderClient[] = [subsourceClient, subdlClient];

export interface ScoredSubtitle {
  candidate: ExternalSubtitleCandidate;
  score: number;
  tier: MatchTier;
  /** The claimed release runs for the same time as the one being played. */
  durationMatched?: boolean;
}

/**
 * Runtime context for correlating by duration: what the playing release runs
 * for, and the runtimes of every other release offered for this title (so a
 * subtitle claiming a DIFFERENT release can still be recognised as compatible).
 */
export interface DurationContext {
  ourDurationMs?: number;
  index: ReleaseDurationIndex;
  toleranceSeconds: number;
  tolerancePercent: number;
}

export function getProviderClient(
  id: ExternalProviderId
): SubtitleProviderClient | undefined {
  return CLIENTS.find((c) => c.id === id);
}

/** Providers that are switched on and have a key. */
export function configuredProviders(): SubtitleProviderClient[] {
  if (!appConfig.subtitles.externalEnabled) return [];
  return CLIENTS.filter((c) => c.isConfigured());
}

/**
 * Search all configured providers in parallel and rank the results against the
 * playing release. A failing provider is logged and skipped rather than
 * failing the whole lookup — partial results are still useful.
 */
export async function findExternalSubtitles(
  query: ExternalSearchQuery,
  opts: {
    minScore?: number;
    limit?: number;
    duration?: DurationContext;
  } = {}
): Promise<ScoredSubtitle[]> {
  const clients = configuredProviders();
  if (clients.length === 0) return [];

  // Results are already constrained to the right title/season/episode by the
  // query, so the score measures how closely the RELEASE matches — i.e. how
  // likely the timing lines up — not whether it's the right content. A
  // different release of the same episode is still often usable (and is a fine
  // translation source), so the floor only drops results that barely resemble
  // ours at all.
  const minScore = opts.minScore ?? 30;
  const limit = opts.limit ?? 3;

  const results = await Promise.all(
    clients.map(async (client) => {
      try {
        return await client.search(query);
      } catch (err) {
        logger.debug(
          {
            provider: client.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'external subtitle provider search failed'
        );
        return [] as ExternalSubtitleCandidate[];
      }
    })
  );

  const wantedLangs = new Set(
    query.languages.map((l) => (normaliseLanguage(l) ?? l).toLowerCase())
  );

  const scored: ScoredSubtitle[] = [];
  for (const candidate of results.flat()) {
    // Language is a hard filter: a perfectly-matched release in a language the
    // user can't read is not a result.
    if (wantedLangs.size > 0) {
      const lang = (
        normaliseLanguage(candidate.lang) ?? candidate.lang
      ).toLowerCase();
      if (!wantedLangs.has(lang)) continue;
    }
    // A season pack that doesn't cover our episode can't be used.
    if (
      !candidate.fullSeason &&
      query.episode != null &&
      candidate.episode != null &&
      candidate.episode !== query.episode
    ) {
      continue;
    }
    const { score, tier } = scoreRelease(
      query.filename,
      candidate.releaseNames
    );

    // Does any release this subtitle claims run for the same time as ours? The
    // runtimes come from the stream list, so this resolves even when the
    // claimed release is a different one than we're playing.
    let durationMatched = false;
    const d = opts.duration;
    if (d?.ourDurationMs) {
      for (const claimed of candidate.releaseNames) {
        const claimedKey = normaliseReleaseName(claimed);
        const claimedDuration = claimedKey ? d.index[claimedKey] : undefined;
        if (
          durationsMatch(d.ourDurationMs, claimedDuration, {
            toleranceSeconds: d.toleranceSeconds,
            tolerancePercent: d.tolerancePercent,
          })
        ) {
          durationMatched = true;
          break;
        }
      }
    }

    // A matching runtime is strong evidence on its own, so such a candidate is
    // kept even when its NAME barely resembles ours — that's exactly the case
    // the score alone gets wrong.
    if (score < minScore && !durationMatched) continue;
    scored.push({ candidate, score, tier, durationMatched });
  }

  scored.sort(
    (a, b) =>
      // Runtime agreement outranks name similarity — it speaks to whether the
      // timing will actually line up.
      Number(b.durationMatched ?? false) - Number(a.durationMatched ?? false) ||
      b.score - a.score ||
      // Prefer a subtitle written for one episode over a whole-season pack,
      // then fall back to popularity.
      Number(a.candidate.fullSeason) - Number(b.candidate.fullSeason) ||
      (b.candidate.downloads ?? 0) - (a.candidate.downloads ?? 0)
  );

  // One entry per provider+language pair keeps the player's list readable.
  const seen = new Set<string>();
  const deduped: ScoredSubtitle[] = [];
  for (const s of scored) {
    const key = `${s.candidate.provider}|${s.candidate.lang}|${s.candidate.hearingImpaired ? 'hi' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
    if (deduped.length >= limit) break;
  }

  logger.debug(
    { found: scored.length, returned: deduped.length },
    'external subtitle search complete'
  );
  return deduped;
}

export { subsourceClient, subdlClient };
export * from './types.js';
export { readZipEntries, subtitleEntries } from './zip.js';
