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
import { matchesEpisode, scoreRelease } from '../match.js';
import type {
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  SubtitleProviderClient,
} from './types.js';

const logger = createLogger('subtitles');
const BASE = 'https://api.subsource.net/api/v1';
const TIMEOUT_MS = 15_000;

interface SsMovie {
  movieId: number;
  season?: number | null;
  type?: string;
}
interface SsSubtitle {
  subtitleId: number;
  language: string;
  releaseInfo?: string[] | null;
  hearingImpaired?: boolean;
  foreignParts?: boolean;
  framerate?: string | null;
  downloads?: number;
  rating?: { good?: number; bad?: number; total?: number };
  files?: number | null;
}

function apiKey(): string | undefined {
  const key = appConfig.subtitles.subsourceApiKey;
  return key && key.trim() ? key.trim() : undefined;
}

async function get<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey() ?? '', accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`SubSource ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const subsourceClient: SubtitleProviderClient = {
  id: 'subsource',

  isConfigured() {
    return !!apiKey();
  },

  async search(query: ExternalSearchQuery) {
    if (!query.imdbId) return [];
    // TV titles resolve to one movieId per season, so pick the right one.
    const movies = await get<{ data?: SsMovie[] }>('/movies/search', {
      searchType: 'imdb',
      imdb: query.imdbId,
    });
    const candidatesForTitle = movies.data ?? [];
    if (candidatesForTitle.length === 0) return [];
    const movie =
      query.season != null
        ? (candidatesForTitle.find((m) => m.season === query.season) ??
          candidatesForTitle[0])
        : candidatesForTitle[0];

    const params: Record<string, string> = {
      movieId: String(movie.movieId),
      limit: '30',
    };
    // The API filters by a single language name; ask for the top preference and
    // let the matcher rank what comes back.
    if (query.languages[0]) params.language = query.languages[0].toLowerCase();

    const subs = await get<{ data?: SsSubtitle[] }>('/subtitles', params);
    return (subs.data ?? []).map((s): ExternalSubtitleCandidate => {
      const fps = Number(s.framerate);
      return {
        provider: 'subsource',
        id: String(s.subtitleId),
        lang: normaliseLanguage(s.language) ?? s.language,
        releaseNames: (s.releaseInfo ?? []).filter(Boolean),
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

  async download(candidate, wantEpisode) {
    const res = await fetch(
      `${BASE}/subtitles/${encodeURIComponent(candidate.downloadRef)}/download`,
      {
        headers: { 'X-API-Key': apiKey() ?? '' },
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
): string {
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
  return decodeSubtitle(best.read());
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
