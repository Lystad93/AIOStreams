/**
 * External subtitle lookup (spec §4.5): search every configured provider for
 * the release being played, score each result against it, and return the best
 * few. This is the cheap half of the feature — no video is downloaded, so it
 * can run where full extraction is gated off.
 */
import { createLogger } from '../../logging/logger.js';
import {
  appConfig,
  normaliseLanguage,
  Cache,
  getSimpleTextHash,
} from '../../utils/index.js';
import { scoreRelease, durationsMatch, type MatchTier } from '../match.js';
import { normaliseReleaseName } from '../release-name.js';
import type { ReleaseDurationIndex } from '../release-lookup.js';
import { subsourceClient } from './subsource.js';
import { subdlClient } from './subdl.js';
import { opensubtitlesClient } from './opensubtitles.js';
import type {
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  ExternalProviderId,
  ExternalFilters,
  ProviderCredentials,
  SubtitleProviderClient,
} from './types.js';

const logger = createLogger('subtitles');

const CLIENTS: SubtitleProviderClient[] = [
  subsourceClient,
  subdlClient,
  opensubtitlesClient,
];

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

/**
 * Providers that are switched on and have a key (per-user or instance).
 *
 * The user's switch is checked before the key, because the two are independent:
 * an instance-wide key legitimately falls back in when someone has none of
 * their own, so clearing a key is not a way to opt out of a provider.
 */
export function configuredProviders(
  creds: ProviderCredentials = {},
  enabled?: ExternalProviderId[]
): SubtitleProviderClient[] {
  if (!appConfig.subtitles.externalEnabled) return [];
  const allowed = enabled && enabled.length > 0 ? new Set(enabled) : undefined;
  return CLIENTS.filter(
    (c) => (!allowed || allowed.has(c.id)) && c.isConfigured(creds)
  );
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
    creds?: ProviderCredentials;
    filters?: ExternalFilters;
  } = {}
): Promise<ScoredSubtitle[]> {
  const creds = opts.creds ?? {};
  const filters = opts.filters ?? {};
  const clients = configuredProviders(creds, filters.providers);
  if (clients.length === 0) return [];

  // No floor by default. Every result is already constrained to the right
  // title (and episode) by the query, so a low score never means "wrong
  // content" — only "a different release, so the timing may differ". Hiding
  // those was wrong: subtitle sites routinely carry entirely different releases
  // than a usenet/debrid stream list (e.g. only 1080p WEB-DL entries when you
  // are playing a 2160p one), which scored every candidate below the old floor
  // and left the menu empty. Rank them honestly instead.
  const minScore = opts.minScore ?? 0;
  const limit = opts.limit ?? 3;

  const results = await Promise.all(
    clients.map(async (client) => {
      try {
        return await client.search(query, creds);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An auth failure is a configuration mistake the user can fix, not a
        // transient blip — and silently returning [] makes a dead provider look
        // like one that simply had no matches. Say so at a level that shows up.
        const authFailure = /\((401|403)\)/.test(message);
        logger[authFailure ? 'warn' : 'debug'](
          { provider: client.id, err: message },
          authFailure
            ? `${client.id} rejected the API key (check the key in your user settings, or the instance-wide key in .env) — no ${client.id} results will appear`
            : 'external subtitle provider search failed'
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
    // Track-kind preferences. Both default to on: these are ordinary subtitles
    // that many people want, so they're only dropped when asked for.
    if (filters.hearingImpaired === false && candidate.hearingImpaired)
      continue;
    if (filters.forced === false && candidate.foreignPartsOnly) continue;

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
      candidate.releaseNames,
      { moviehashMatched: candidate.moviehashMatched }
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

/**
 * Downloaded external subtitle bodies, bounded by count.
 *
 * Deliberately its own store: extracted and translated subtitles live
 * permanently in the `subtitle_sources` / `subtitle_jobs` tables because they
 * cost a full file transit and an LLM call to produce. These are cheap to
 * re-fetch, so they're the ones allowed to be evicted under pressure.
 */
const fileCache = () =>
  Cache.getInstance<string, string>(
    'subtitle-external-files',
    () => appConfig.subtitles.externalCacheSize
  );
/** Long-lived: eviction is by count, not age. */
const FILE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Fetch one external subtitle, reusing the cached body when we've already
 * pulled it. Keyed by everything that changes the output, including the episode
 * picked out of a season pack.
 */
export async function downloadExternalSubtitle(args: {
  provider: ExternalProviderId;
  ref: string;
  lang: string;
  season?: number;
  episode?: number;
  releaseKey?: string;
  creds?: ProviderCredentials;
}): Promise<string> {
  const client = getProviderClient(args.provider);
  if (!client) throw new Error(`Unknown subtitle provider: ${args.provider}`);

  const cacheKey = getSimpleTextHash(
    [
      args.provider,
      args.ref,
      args.season ?? '',
      args.episode ?? '',
      args.releaseKey ?? '',
    ]
      .map((v) => encodeURIComponent(String(v)))
      .join('|')
  );

  const caching = appConfig.subtitles.externalCacheSize > 0;
  if (caching) {
    const hit = await fileCache().get(cacheKey);
    if (hit) {
      logger.debug(
        { provider: args.provider },
        'served external subtitle from cache'
      );
      return hit;
    }
  }

  const srt = await client.download(
    {
      provider: client.id,
      id: args.ref,
      downloadRef: args.ref,
      lang: args.lang,
      releaseNames: [],
    },
    {
      season: args.season,
      episode: args.episode,
      releaseKey: args.releaseKey,
    },
    args.creds ?? {}
  );

  if (caching) await fileCache().set(cacheKey, srt, FILE_TTL_SECONDS);
  return srt;
}

export { subsourceClient, subdlClient, opensubtitlesClient };
export * from './types.js';
export { readZipEntries, subtitleEntries } from './zip.js';
