/**
 * Subtitle extraction + translation pipeline (§4.2 / §4.4 of the subtitle spec).
 *
 * Everything here is keyed off the identity fields Stremio/Nuvio echo back on a
 * subtitle request (`videoHash`/`videoSize`/`filename`) — the same fields the
 * addon already sets on the served stream's `behaviorHints`. No speculative
 * fetch of any release happens here (spec §3.1); a job only starts when the user
 * explicitly clicks the corresponding subtitle slot.
 */

/** Which release the subtitle is (or will be) sourced from. */
export type SubtitleSourcePath = 'exact' | 'fast' | 'external';

/** Lifecycle of a single extract+translate job. */
export type SubtitleJobStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * The tuple that uniquely identifies a job (spec §5, §10). `releaseHash` pins
 * the exact playing release so two different releases of the same episode don't
 * collide, and `targetLang` + `sourcePath` separate the distinct outputs a user
 * might request for one file.
 */
export interface SubtitleJobKey {
  /** Owner's config uuid — jobs are per-user (their API key, their langs). */
  uuid: string;
  /** Stremio content id, e.g. `tt1234567` or `tt1234567:1:2`. */
  contentId: string;
  /** Stable hash of the exact release being played. */
  releaseHash: string;
  sourcePath: SubtitleSourcePath;
  /** BCP-47-ish target language code the user wants (e.g. `nor`, `en`). */
  targetLang: string;
}

export interface SubtitleJob extends SubtitleJobKey {
  status: SubtitleJobStatus;
  /** Precomputed once, baked into the slot label (spec §6). Seconds. */
  etaSeconds: number;
  /** Epoch ms; passed in (Date.now() is unavailable in some contexts). */
  createdAt: number;
  updatedAt: number;
  /** Detected source language of the extracted track, once known. */
  sourceLang?: string;
  /** Cache key of the finished translated SRT, set when `status==='done'`. */
  resultKey?: string;
  /** Human-readable failure reason when `status==='failed'`. */
  error?: string;
  /** Original release filename, for the dashboard record. */
  filename?: string;
  /** Original release size in bytes, for the dashboard record. */
  videoSize?: number;
  /** Translation provider id (e.g. `gemini`), for the dashboard record. */
  provider?: string;
  /** Model used, for the dashboard record. */
  model?: string;
}

/** A raw subtitle track as reported by ffprobe, before we decide to extract. */
export interface ProbedSubtitleTrack {
  /** ffmpeg stream index (used with `-map 0:index`). */
  index: number;
  codec: string;
  /** True for text codecs we can extract (`subrip`, `ass`, `webvtt`, …). */
  isText: boolean;
  language?: string;
  title?: string;
  /** ffmpeg disposition flags we care about for ranking. */
  forced?: boolean;
  hearingImpaired?: boolean;
}

/**
 * Measured properties of the file a subtitle came from. All of it falls out of
 * the ffprobe we already run, and it's what makes a subtitle reusable against
 * OTHER releases: `durationMs` is the primary matching key (spec §4.5/§8), and
 * `fps` decides whether cues can be reused as-is or need retiming (23.976 vs
 * 25 PAL is the classic silent-drift failure).
 */
export interface ProbedMediaInfo {
  /** Measured container duration in ms (NOT a TMDB/filename-derived runtime). */
  durationMs?: number;
  /** Frame rate as a decimal, e.g. 23.976. */
  fps?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
}

/** Error thrown when the only embedded track(s) are bitmap-based (spec §2, §4.2). */
export class BitmapOnlySubtitleError extends Error {
  constructor(codecs: string[]) {
    super(
      `The embedded subtitle track(s) are bitmap-based (${codecs.join(
        ', '
      )}) and cannot be extracted as text. OCR is out of scope.`
    );
    this.name = 'BitmapOnlySubtitleError';
  }
}
