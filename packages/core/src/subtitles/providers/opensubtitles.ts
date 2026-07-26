/**
 * OpenSubtitles client (https://api.opensubtitles.com/api/v1).
 *
 * Two different credentials, verified against the live API:
 *  - the **app** `Api-Key` identifies the integration and is enough to SEARCH,
 *  - **downloads** consume a per-account daily quota, so they need that user's
 *    own username/password, exchanged for a short-lived JWT.
 *
 * That split is why the key is an instance setting while the login is per-user:
 * an instance owner must not spend their own download quota on everyone.
 *
 * Its `release` field is frequently NOT scene-style (e.g.
 * `From (2022) - S01E08 - … (1080p AMZN WEB-DL x265 t3nzin)_Track03`), so exact
 * name equality rarely fires here — `moviehash_match` is the strong signal
 * instead, and it's the only thing that earns the `exact-file` tier.
 */
import { createLogger } from '../../logging/logger.js';
import { appConfig, normaliseLanguage, Cache } from '../../utils/index.js';
import { decodeSubtitle } from './subsource.js';
import type {
  ExternalSearchQuery,
  ExternalSubtitleCandidate,
  ProviderCredentials,
  SubtitleProviderClient,
} from './types.js';

const logger = createLogger('subtitles');
const BASE = 'https://api.opensubtitles.com/api/v1';
const TIMEOUT_MS = 15_000;
/** Identifies this integration to OpenSubtitles, as their docs require. */
const USER_AGENT = 'AIOStreams-Subtitles/1.0';

interface OsAttributes {
  language?: string;
  release?: string;
  fps?: number;
  hearing_impaired?: boolean;
  foreign_parts_only?: boolean;
  download_count?: number;
  ratings?: number;
  from_trusted?: boolean;
  ai_translated?: boolean;
  machine_translated?: boolean;
  moviehash_match?: boolean;
  files?: { file_id?: number; file_name?: string }[];
}

function appKey(creds: ProviderCredentials): string | undefined {
  const key =
    creds.opensubtitlesApiKey?.trim() ||
    appConfig.subtitles.opensubtitlesApiKey;
  return key && key.trim() ? key.trim() : undefined;
}

function headers(creds: ProviderCredentials, token?: string) {
  return {
    'Api-Key': appKey(creds) ?? '',
    'User-Agent': USER_AGENT,
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Per-user login tokens. OpenSubtitles asks integrations not to log in on every
 * request, and the token is valid for hours, so it's cached per username.
 */
const tokenCache = () =>
  Cache.getInstance<string, string>('opensubtitles-tokens', 200);
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

async function login(creds: ProviderCredentials): Promise<string | undefined> {
  const { opensubtitlesUsername: username, opensubtitlesPassword: password } =
    creds;
  if (!username || !password) return undefined;

  const cached = await tokenCache().get(username);
  if (cached) return cached;

  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { ...headers(creds), 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `OpenSubtitles login failed (${res.status}) — check the username and password.`
    );
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error('OpenSubtitles login returned no token');
  await tokenCache().set(username, json.token, TOKEN_TTL_SECONDS);
  return json.token;
}

export const opensubtitlesClient: SubtitleProviderClient = {
  id: 'opensubtitles',

  isConfigured(creds) {
    // Searching needs only the app key; a missing user login is reported when a
    // download is actually attempted, so matches still show in the list.
    return !!appKey(creds);
  },

  async search(query: ExternalSearchQuery, creds: ProviderCredentials) {
    if (!query.imdbId) return [];
    const url = new URL(`${BASE}/subtitles`);
    // Their API wants the numeric id, without the `tt`.
    url.searchParams.set('imdb_id', query.imdbId.replace(/^tt/, ''));
    if (query.season != null) {
      url.searchParams.set('season_number', String(query.season));
    }
    if (query.episode != null) {
      url.searchParams.set('episode_number', String(query.episode));
    }
    if (query.languages.length > 0) {
      const codes = query.languages
        .map((l) => LANGUAGE_CODES[l.toLowerCase()])
        .filter(Boolean);
      if (codes.length > 0) {
        url.searchParams.set('languages', [...new Set(codes)].join(','));
      }
    }
    // The strongest signal available: an exact match on the video's own hash.
    if (query.movieHash) url.searchParams.set('moviehash', query.movieHash);

    const res = await fetch(url, {
      headers: headers(creds),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OpenSubtitles search failed (${res.status})`);
    const json = (await res.json()) as {
      data?: { id?: string; attributes?: OsAttributes }[];
    };

    return (json.data ?? [])
      .filter((d) => d.attributes?.files?.[0]?.file_id)
      .map((d): ExternalSubtitleCandidate => {
        const a = d.attributes!;
        const fileId = a.files![0].file_id!;
        return {
          provider: 'opensubtitles',
          id: String(fileId),
          lang: normaliseLanguage(a.language ?? '') ?? a.language ?? '',
          // Both the release string and the stored filename are worth matching
          // against — the filename is often the more scene-like of the two.
          releaseNames: [a.release, a.files?.[0]?.file_name].filter(
            (v): v is string => !!v
          ),
          hearingImpaired: !!a.hearing_impaired,
          foreignPartsOnly: !!a.foreign_parts_only,
          fps: a.fps && a.fps > 0 ? a.fps : undefined,
          downloads: a.download_count,
          rating: a.ratings,
          moviehashMatched: !!a.moviehash_match,
          // Their entries are per-file, never season packs.
          fullSeason: false,
          season: query.season,
          episode: query.episode,
          downloadRef: String(fileId),
        };
      });
  },

  async download(candidate, _wantEpisode, creds) {
    const token = await login(creds);
    if (!token) {
      throw new Error(
        'OpenSubtitles downloads need your own username and password — downloads count against your account quota, so the instance key cannot be used.'
      );
    }
    // Downloads are two-step: ask for a link, then fetch it.
    const res = await fetch(`${BASE}/download`, {
      method: 'POST',
      headers: { ...headers(creds, token), 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: Number(candidate.downloadRef) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `OpenSubtitles download failed (${res.status})${
          res.status === 406 ? ' — daily download quota exhausted' : ''
        }: ${body.slice(0, 200)}`
      );
    }
    const json = (await res.json()) as { link?: string; remaining?: number };
    if (!json.link) throw new Error('OpenSubtitles returned no download link');
    logger.debug(
      { remaining: json.remaining },
      'fetched OpenSubtitles download link'
    );

    const file = await fetch(json.link, {
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
    if (!file.ok) {
      throw new Error(`OpenSubtitles file fetch failed (${file.status})`);
    }
    // Unlike the other providers this is the subtitle itself, not an archive.
    return decodeSubtitle(Buffer.from(await file.arrayBuffer()));
  },
};

/** Display name → ISO code OpenSubtitles expects. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  norwegian: 'no',
  danish: 'da',
  swedish: 'sv',
  german: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt-pt',
  'portuguese (brazil)': 'pt-br',
  dutch: 'nl',
  polish: 'pl',
  finnish: 'fi',
  russian: 'ru',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh-cn',
  arabic: 'ar',
  turkish: 'tr',
  czech: 'cs',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  romanian: 'ro',
  ukrainian: 'uk',
  vietnamese: 'vi',
  indonesian: 'id',
  thai: 'th',
};
