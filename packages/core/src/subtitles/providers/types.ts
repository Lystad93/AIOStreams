/**
 * Common shape for externally-sourced subtitles (spec §4.5).
 *
 * Each provider reports releases differently — SubSource gives an array of
 * scene names, SubDL a single one, OpenSubtitles a often-non-scene string — so
 * clients normalise into this one shape and the matcher works against it alone.
 */

export type ExternalProviderId = 'subsource' | 'subdl';

export interface ExternalSearchQuery {
  /** `tt`-prefixed IMDb id of the title. */
  imdbId?: string;
  season?: number;
  episode?: number;
  /** Canonical display names of acceptable languages, in priority order. */
  languages: string[];
  /** The release we're matching against, for providers that can filter on it. */
  filename?: string;
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
}

export interface SubtitleProviderClient {
  readonly id: ExternalProviderId;
  /** False when no API key is configured; the provider is then skipped. */
  isConfigured(): boolean;
  search(query: ExternalSearchQuery): Promise<ExternalSubtitleCandidate[]>;
  /**
   * Fetch the subtitle body as SRT text. `wantEpisode` lets a season pack
   * resolve to the right file inside the archive.
   */
  download(
    candidate: ExternalSubtitleCandidate,
    wantEpisode?: { season?: number; episode?: number; releaseKey?: string }
  ): Promise<string>;
}
