/**
 * SubDL client (https://api.subdl.com/api/v1, `api_key` query param).
 *
 * Verified against the live API: rows carry a scene-style `release_name`, and
 * the search endpoint uniquely accepts `file_name` — so we can ask directly for
 * the release we're playing. Downloads are ZIPs served from `dl.subdl.com`;
 * season packs hold one file per episode.
 */
import { appConfig, normaliseLanguage } from '../../utils/index.js';
import { pickFromArchive } from './subsource.js';
import type {
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  SubtitleProviderClient,
} from './types.js';

const API = 'https://api.subdl.com/api/v1/subtitles';
const DL_BASE = 'https://dl.subdl.com';
const TIMEOUT_MS = 15_000;

interface SdSubtitle {
  release_name?: string | null;
  name?: string | null;
  lang?: string | null;
  language?: string | null;
  url?: string | null;
  season?: number | null;
  episode?: number | null;
  framerate?: number | null;
  fps?: string | number | null;
  hi?: boolean;
  full_season?: boolean;
  author?: string | null;
}

function apiKey(): string | undefined {
  const key = appConfig.subtitles.subdlApiKey;
  return key && key.trim() ? key.trim() : undefined;
}

export const subdlClient: SubtitleProviderClient = {
  id: 'subdl',

  isConfigured() {
    return !!apiKey();
  },

  async search(query: ExternalSearchQuery) {
    const key = apiKey();
    if (!key || !query.imdbId) return [];

    const buildUrl = (exactFilename?: string): URL => {
      const url = new URL(API);
      url.searchParams.set('api_key', key);
      url.searchParams.set('imdb_id', query.imdbId!);
      url.searchParams.set('subs_per_page', '30');
      if (query.season != null) {
        url.searchParams.set('season_number', String(query.season));
      }
      if (query.episode != null) {
        url.searchParams.set('episode_number', String(query.episode));
      }
      if (query.languages.length > 0) {
        // SubDL wants 2-letter-ish codes; it accepts the common uppercase forms.
        const codes = query.languages
          .map((l) => LANGUAGE_CODES[l.toLowerCase()] ?? l.slice(0, 2))
          .map((c) => c.toUpperCase());
        url.searchParams.set('languages', [...new Set(codes)].join(','));
      }
      if (exactFilename) url.searchParams.set('file_name', exactFilename);
      return url;
    };

    const fetchPage = async (url: URL): Promise<SdSubtitle[]> => {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`SubDL search failed (${res.status})`);
      const json = (await res.json()) as {
        status?: boolean;
        subtitles?: SdSubtitle[];
      };
      return json.status ? (json.subtitles ?? []) : [];
    };

    // `file_name` is an EXACT filter — passing our release returns nothing
    // unless SubDL happens to hold that precise release. So run the broad
    // episode query for candidates, and the exact one only as a bonus lookup;
    // a hit there is the strongest possible signal from this provider.
    const [broad, exact] = await Promise.all([
      fetchPage(buildUrl()),
      query.filename
        ? fetchPage(buildUrl(query.filename)).catch(() => [])
        : Promise.resolve([] as SdSubtitle[]),
    ]);

    const byUrl = new Map<string, SdSubtitle>();
    for (const s of [...exact, ...broad]) {
      if (s.url && !byUrl.has(s.url)) byUrl.set(s.url, s);
    }

    return [...byUrl.values()]
      .filter((s) => s.url)
      .map((s): ExternalSubtitleCandidate => {
        const fpsNum = Number(s.fps);
        const rawLang = s.lang || s.language || '';
        return {
          provider: 'subdl',
          id: s.url!,
          lang: normaliseLanguage(rawLang) ?? rawLang,
          releaseNames: [s.release_name, s.name]
            .filter((v): v is string => !!v)
            .map((v) => v.replace(/^SUBDL::/, '')),
          hearingImpaired: !!s.hi,
          fps: Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : undefined,
          fullSeason: !!s.full_season,
          season: s.season ?? undefined,
          episode: s.episode ?? undefined,
          downloadRef: s.url!,
        };
      });
  },

  async download(candidate, wantEpisode) {
    // `url` is a site-relative path that already carries the api_key.
    const href = candidate.downloadRef.startsWith('http')
      ? candidate.downloadRef
      : `${DL_BASE}${candidate.downloadRef}`;
    const res = await fetch(href, {
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
    if (!res.ok) throw new Error(`SubDL download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return pickFromArchive(buf, wantEpisode, 'SubDL');
  },
};

/** Display name → the code SubDL expects, for the languages that differ. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'EN',
  norwegian: 'NO',
  danish: 'DA',
  swedish: 'SV',
  german: 'DE',
  french: 'FR',
  spanish: 'ES',
  italian: 'IT',
  portuguese: 'PT',
  dutch: 'NL',
  polish: 'PL',
  finnish: 'FI',
  russian: 'RU',
  japanese: 'JA',
  korean: 'KO',
  chinese: 'ZH',
  arabic: 'AR',
  turkish: 'TR',
  czech: 'CS',
  greek: 'EL',
  hebrew: 'HE',
  hindi: 'HI',
  hungarian: 'HU',
  romanian: 'RO',
  ukrainian: 'UK',
  vietnamese: 'VI',
  indonesian: 'ID',
  thai: 'TH',
};
