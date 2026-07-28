/**
 * SubSource client (https://api.subsource.net/api/v1, header `X-API-Key`).
 *
 * Verified against the live API: subtitle rows carry `releaseInfo` as an ARRAY
 * of scene-style release names, which is the best matching input of any
 * provider — our canonical key compares against it directly. Downloads are
 * ZIPs; for a series the archive holds one file per episode, named with the
 * full release, so a season pack still resolves to the right episode.
 */
import { createLogger } from '../../logging/logger.js';
import { appConfig, normaliseLanguage } from '../../utils/index.js';
import { readZipEntries, subtitleEntries } from './zip.js';
import { parseUploaderComment } from '../comment-parse.js';
import { matchesEpisode, scoreRelease } from '../match.js';
import type {
  DownloadedSubtitle,
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  ProviderCredentials,
  SubtitleProviderClient,
} from './types.js';

const logger = createLogger('subtitles');
const BASE = 'https://api.subsource.net/api/v1';
const TIMEOUT_MS = 15_000;
/** Cap the language fan-out so a long preference list can't storm the API. */
const MAX_LANGUAGE_REQUESTS = 4;

interface SsMovie {
  movieId: number;
  season?: number | null;
  type?: string;
}
interface SsSubtitle {
  subtitleId: number;
  language: string;
  releaseInfo?: string[] | null;
  /**
   * Uploader notes. The exact key isn't documented, and different endpoints
   * have used different names, so every plausible one is accepted — reading a
   * key that turns out not to exist costs nothing, missing the one that does
   * loses a stated runtime.
   */
  comment?: string | null;
  comments?: string | null;
  note?: string | null;
  description?: string | null;
  hearingImpaired?: boolean;
  foreignParts?: boolean;
  framerate?: string | null;
  downloads?: number;
  rating?: { good?: number; bad?: number; total?: number };
  files?: number | null;
}

function apiKey(creds: ProviderCredentials): string | undefined {
  const key = creds.subsource?.trim() || appConfig.subtitles.subsourceApiKey;
  return key && key.trim() ? key.trim() : undefined;
}

async function get<T>(
  path: string,
  params: Record<string, string>,
  creds: ProviderCredentials
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey(creds) ?? '', accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`SubSource ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const subsourceClient: SubtitleProviderClient = {
  id: 'subsource',

  isConfigured(creds) {
    return !!apiKey(creds);
  },

  async search(query: ExternalSearchQuery, creds: ProviderCredentials) {
    if (!query.imdbId) return [];
    // TV titles resolve to one movieId per season, so pick the right one.
    const movies = await get<{ data?: SsMovie[] }>(
      '/movies/search',
      { searchType: 'imdb', imdb: query.imdbId },
      creds
    );
    const candidatesForTitle = movies.data ?? [];
    if (candidatesForTitle.length === 0) return [];
    const movie =
      query.season != null
        ? (candidatesForTitle.find((m) => m.season === query.season) ??
          candidatesForTitle[0])
        : candidatesForTitle[0];

    // The API filters by ONE language per request, so fan out over the user's
    // list — otherwise only their top preference would ever come back, and the
    // source languages they'd accept for translation would be silently lost.
    const languages =
      query.languages.length > 0 ? query.languages : [undefined];
    const pages = await Promise.all(
      languages.slice(0, MAX_LANGUAGE_REQUESTS).map(async (lang) => {
        const params: Record<string, string> = {
          movieId: String(movie.movieId),
          limit: '30',
        };
        if (lang) params.language = lang.toLowerCase();
        try {
          const subs = await get<{ data?: SsSubtitle[] }>(
            '/subtitles',
            params,
            creds
          );
          return subs.data ?? [];
        } catch (err) {
          logger.debug(
            { lang, err: err instanceof Error ? err.message : String(err) },
            'SubSource language query failed'
          );
          return [];
        }
      })
    );

    const byId = new Map<number, SsSubtitle>();
    for (const s of pages.flat()) {
      if (!byId.has(s.subtitleId)) byId.set(s.subtitleId, s);
    }

    return [...byId.values()].map((s): ExternalSubtitleCandidate => {
      const fps = Number(s.framerate);
      // Uploaders state the runtime in prose far more often than any provider
      // exposes it as a field.
      const mined = parseUploaderComment(
        s.comment ?? s.comments ?? s.note ?? s.description ?? undefined
      );
      return {
        provider: 'subsource',
        id: String(s.subtitleId),
        lang: normaliseLanguage(s.language) ?? s.language,
        releaseNames: [
          ...new Set([
            // SubSource lists every release a subtitle is synced to, which is
            // the single most useful field any provider gives us.
            ...(s.releaseInfo ?? []).filter(Boolean),
            ...mined.releaseNames,
          ]),
        ],
        statedDurationMs: mined.durationMs,
        hearingImpaired: !!s.hearingImpaired,
        foreignPartsOnly: !!s.foreignParts,
        fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
        downloads: s.downloads,
        rating: s.rating?.good,
        // A multi-file entry is a pack; the archive is resolved per episode.
        fullSeason: (s.files ?? 1) > 1,
        season: movie.season ?? query.season,
        downloadRef: String(s.subtitleId),
      };
    });
  },

  async download(candidate, wantEpisode, creds) {
    const res = await fetch(
      `${BASE}/subtitles/${encodeURIComponent(candidate.downloadRef)}/download`,
      {
        headers: { 'X-API-Key': apiKey(creds) ?? '' },
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      }
    );
    if (!res.ok) {
      throw new Error(`SubSource download failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return pickFromArchive(buf, wantEpisode, 'SubSource');
  },
};

/**
 * Choose the right subtitle file out of a downloaded archive: the requested
 * episode first, then whichever inner filename best matches the release we're
 * playing (pack members carry the full release name).
 */
export function pickFromArchive(
  buf: Buffer,
  want: { season?: number; episode?: number; releaseKey?: string } | undefined,
  providerLabel: string
): DownloadedSubtitle {
  const files = subtitleEntries(readZipEntries(buf));
  if (files.length === 0) {
    throw new Error(`${providerLabel} archive contained no subtitle file`);
  }

  let pool = files;
  if (want?.season != null && want?.episode != null) {
    const episodeMatches = files.filter((f) => matchesEpisode(f.name, want));
    if (episodeMatches.length > 0) pool = episodeMatches;
    else if (files.length > 1) {
      throw new Error(
        `${providerLabel} archive has no file for S${want.season}E${want.episode}`
      );
    }
  }

  const best =
    pool.length === 1
      ? pool[0]
      : [...pool].sort(
          (a, b) =>
            scoreRelease(want?.releaseKey, [b.name]).score -
            scoreRelease(want?.releaseKey, [a.name]).score
        )[0];

  logger.debug(
    { provider: providerLabel, chosen: best.name, of: files.length },
    'picked subtitle from archive'
  );
  return { srt: decodeSubtitle(best.read()), filename: best.name };
}

/**
 * Decode a subtitle body to text. Files are commonly UTF-8 (often with a BOM)
 * but legacy uploads are frequently Windows-1252 — decoding those as UTF-8
 * mangles accented characters, so fall back when the result looks broken.
 */
export function decodeSubtitle(body: Buffer): string {
  const utf8 = body.toString('utf8').replace(/^﻿/, '');
  // U+FFFD is what invalid UTF-8 sequences decode to.
  if (!utf8.includes('�')) return utf8;
  return body.toString('latin1').replace(/^﻿/, '');
}
