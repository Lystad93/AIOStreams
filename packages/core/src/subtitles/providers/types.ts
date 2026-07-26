/**
 * Common shape for externally-sourced subtitles (spec §4.5).
 *
 * Each provider reports releases differently — SubSource gives an array of
 * scene names, SubDL a single one, OpenSubtitles a often-non-scene string — so
 * clients normalise into this one shape and the matcher works against it alone.
 */

export type ExternalProviderId = 'subsource' | 'subdl' | 'opensubtitles';

export interface ExternalSearchQuery {
  /** `tt`-prefixed IMDb id of the title. */
  imdbId?: string;
  season?: number;
  episode?: number;
  /** Canonical display names of acceptable languages, in priority order. */
  languages: string[];
  /** The release we're matching against, for providers that can filter on it. */
  filename?: string;
  /** OpenSubtitles-style hash of the video, when the player supplied one. */
  movieHash?: string;
}

export interface ExternalSubtitleCandidate {
  provider: ExternalProviderId;
  /** Provider-scoped id, used to download. */
  id: string;
  /** Canonical display language name (e.g. "English"). */
  lang: string;
  /** Release names this subtitle claims to be synced to. */
  releaseNames: string[];
  hearingImpaired?: boolean;
  foreignPartsOnly?: boolean;
  fps?: number;
  /** Popularity/quality signals, used only to break ties. */
  downloads?: number;
  rating?: number;
  /** True when the entry covers a whole season rather than one episode. */
  fullSeason?: boolean;
  season?: number;
  episode?: number;
  /** Opaque download reference (URL or id) — provider-specific. */
  downloadRef: string;
  /** The provider matched this against the video's own hash: exact file. */
  moviehashMatched?: boolean;
}

/**
 * API keys in effect for one request. A user may supply their own; otherwise
 * the instance-wide keys apply, so a self-hoster configures them once.
 */
export interface ProviderCredentials {
  subsource?: string;
  subdl?: string;
  /** App-level key: enough to SEARCH OpenSubtitles. */
  opensubtitlesApiKey?: string;
  /** Per-user login: required to DOWNLOAD (quota is per account). */
  opensubtitlesUsername?: string;
  opensubtitlesPassword?: string;
}

/**
 * What a user is willing to be offered, independent of how well it matches.
 *
 * Kept apart from credentials because these are preferences rather than access:
 * a provider switched off here is skipped even though a key exists for it.
 */
export interface ExternalFilters {
  /** Providers to search. Omitted or empty means all of them. */
  providers?: ExternalProviderId[];
  /** Keep SDH/hearing-impaired tracks (speaker labels, [sound descriptions]). */
  hearingImpaired?: boolean;
  /** Keep forced tracks — foreign dialogue only, not a full transcript. */
  forced?: boolean;
}

export interface SubtitleProviderClient {
  readonly id: ExternalProviderId;
  /** False when no API key is available; the provider is then skipped. */
  isConfigured(creds: ProviderCredentials): boolean;
  search(
    query: ExternalSearchQuery,
    creds: ProviderCredentials
  ): Promise<ExternalSubtitleCandidate[]>;
  /**
   * Fetch the subtitle body as SRT text. `wantEpisode` lets a season pack
   * resolve to the right file inside the archive.
   */
  download(
    candidate: ExternalSubtitleCandidate,
    wantEpisode:
      | { season?: number; episode?: number; releaseKey?: string }
      | undefined,
    creds: ProviderCredentials
  ): Promise<string>;
}
