/**
 * Embedded-subtitle extraction (spec §4.2). Points ffprobe/ffmpeg at the same
 * internally-served, Range-capable playback URL the player uses (spec §3.2), so
 * there's no second download and no separate staging store — ffmpeg range-reads
 * the container and demuxes a single text subtitle track out.
 *
 * This only runs on an explicit user click of the corresponding slot (spec
 * §3.1) — never speculatively across unselected streams.
 *
 * Text tracks only. If the sole embedded track is bitmap-based (PGS/VobSub) the
 * extraction fails with {@link BitmapOnlySubtitleError}; OCR is out of scope.
 */
import { spawn } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { appConfig, normaliseLanguage } from '../utils/index.js';
import { settingsStore } from '../config/index.js';
import {
  BitmapOnlySubtitleError,
  type ProbedSubtitleTrack,
  type ProbedMediaInfo,
} from './types.js';

const logger = createLogger('subtitles');

/** ffmpeg codec names we can convert to SRT. */
const TEXT_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'text',
  'stl',
  'subviewer',
  'subviewer1',
]);

/** Bitmap codecs we explicitly cannot handle (reported, not silently skipped). */
const BITMAP_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
]);

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

/** Parse ffprobe's rational frame rate ("24000/1001") into a decimal. */
function parseFps(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  const fps = num / den;
  return fps > 0 && Number.isFinite(fps)
    ? Math.round(fps * 1000) / 1000
    : undefined;
}

function ffmpegBin(): string {
  return appConfig.bootstrap.ffmpegPath ?? 'ffmpeg';
}
function ffprobeBin(): string {
  return appConfig.bootstrap.ffprobePath ?? 'ffprobe';
}

/** Run a binary, resolve with stdout, reject on non-zero exit / timeout. */
function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; maxStdoutBytes?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let killedForSize = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (opts.maxStdoutBytes && outLen > opts.maxStdoutBytes) {
        killedForSize = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      // ffmpeg is chatty on stderr; keep only a bounded tail for diagnostics.
      err.push(d);
      if (err.length > 40) err.shift();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn ${bin} (${e.message}). Is it installed / is FFMPEG_PATH correct?`
        )
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(new Error(`${bin} output exceeded size cap`));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
        return;
      }
      const tail = Buffer.concat(err).toString('utf8').slice(-800);
      reject(new Error(`${bin} exited ${code}: ${tail}`));
    });
  });
}

function toTrack(s: FfprobeStream): ProbedSubtitleTrack {
  const codec = (s.codec_name ?? '').toLowerCase();
  return {
    index: s.index,
    codec,
    isText: TEXT_CODECS.has(codec),
    language: s.tags?.language ?? s.tags?.LANGUAGE,
    title: s.tags?.title ?? s.tags?.TITLE,
    forced: s.disposition?.forced === 1,
    hearingImpaired: s.disposition?.hearing_impaired === 1,
  };
}

/**
 * Enumerate embedded subtitle tracks. Reads only the container header/index,
 * not the whole file. `timeoutMs` bounds the probe.
 */
export async function probeSubtitleTracks(
  url: string,
  timeoutMs = 45_000
): Promise<ProbedSubtitleTrack[]> {
  return (await probeMedia(url, timeoutMs)).tracks;
}

/**
 * Single ffprobe pass returning both the subtitle tracks and the file's
 * measured properties. Reads only the container header/index, not the payload,
 * so capturing the extra metadata costs nothing beyond what the track probe
 * already did.
 */
export async function probeMedia(
  url: string,
  timeoutMs = 45_000
): Promise<{ tracks: ProbedSubtitleTrack[]; media: ProbedMediaInfo }> {
  const json = await run(
    ffprobeBin(),
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ],
    { timeoutMs, maxStdoutBytes: 8 * 1024 * 1024 }
  );
  let parsed: {
    streams?: FfprobeStream[];
    format?: { duration?: string | number };
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('ffprobe returned unparseable output');
  }

  const streams = parsed.streams ?? [];
  const tracks = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map(toTrack);

  const video = streams.find((s) => s.codec_type === 'video');
  const durationSec = Number(parsed.format?.duration);
  const media: ProbedMediaInfo = {
    durationMs:
      Number.isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec * 1000)
        : undefined,
    fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name?.toLowerCase(),
  };

  return { tracks, media };
}

/**
 * Rank text tracks for a preferred source language. Non-forced, matching-lang,
 * non-SDH tracks win; forced/SDH are demoted (they're partial or cluttered).
 *
 * `allow.preferHearingImpaired` reverses the SDH half of that: a viewer who
 * needs sound cues wants the cluttered track, and wants a translation made
 * from it. Forced stays demoted either way — it is partial for everyone.
 */
export function pickTrack(
  tracks: ProbedSubtitleTrack[],
  preferredLangs: string[],
  allow: {
    forced?: boolean;
    hearingImpaired?: boolean;
    preferHearingImpaired?: boolean;
  } = {}
): ProbedSubtitleTrack | undefined {
  // Demotion isn't enough when a kind is unwanted: on a release whose only
  // track is forced, sorting still returns it. Excluding means "no subtitle"
  // rather than the wrong one.
  const text = tracks.filter(
    (t) =>
      t.isText &&
      !(allow.forced === false && t.forced) &&
      !(allow.hearingImpaired === false && t.hearingImpaired)
  );
  if (text.length === 0) return undefined;

  // Compare via canonical display names so a UI selection ("Norwegian") matches
  // an ffprobe ISO-639-2 track tag ("nor"). Unknown/untagged tracks rank last.
  const preferredNames = preferredLangs.map((p) => normaliseLanguage(p) ?? p);
  const langRank = (t: ProbedSubtitleTrack): number => {
    const name = normaliseLanguage(t.language ?? '');
    if (!name) return preferredNames.length + 1;
    const i = preferredNames.findIndex((p) => p === name);
    return i === -1 ? preferredNames.length : i;
  };

  return [...text].sort((a, b) => {
    const byLang = langRank(a) - langRank(b);
    if (byLang !== 0) return byLang;
    // `!!` matters: these dispositions are optional, and `Number(undefined)` is
    // NaN, which is never `!== 0`-false — so an unflagged pair used to return
    // NaN here and skip every tiebreak below it.
    const forced = Number(!!a.forced) - Number(!!b.forced);
    if (forced !== 0) return forced;
    const sdh = Number(!!a.hearingImpaired) - Number(!!b.hearingImpaired);
    if (sdh !== 0) return allow.preferHearingImpaired ? -sdh : sdh;
    return a.index - b.index;
  })[0];
}

/**
 * Does the file already carry a subtitle the viewer would actually watch in
 * `lang`?
 *
 * This asks a different question from {@link pickTrack} and so filters
 * differently. `pickTrack` looks for a track to *extract and translate*, so it
 * needs text it can convert to SRT. This asks whether the language is already
 * available in the player, and a player renders an embedded bitmap track
 * (PGS/VobSub) as readily as a text one — so the codec is irrelevant here and
 * `isText` is deliberately not checked.
 *
 * A forced track never counts: it covers only foreign-language dialogue, so a
 * release carrying one still needs a full subtitle. An SDH track does count,
 * because it covers all dialogue — unless the user excluded SDH, in which case
 * it isn't something they would watch and so doesn't satisfy the need.
 */
export function hasSubtitleInLanguage(
  tracks: ProbedSubtitleTrack[],
  lang: string,
  allow: { hearingImpaired?: boolean } = {}
): boolean {
  const want = normaliseLanguage(lang) ?? lang;
  return tracks.some((t) => {
    if (t.forced) return false;
    if (allow.hearingImpaired === false && t.hearingImpaired) return false;
    const name = normaliseLanguage(t.language ?? '');
    return !!name && name === want;
  });
}

/**
 * Extract one text subtitle track to SRT text. `trackIndex` is the ffmpeg
 * stream index from {@link probeSubtitleTracks}. Bitmap codecs are refused
 * before spawning (they can't be `-f srt`'d).
 */
export async function extractTrackToSrt(
  url: string,
  track: ProbedSubtitleTrack,
  timeoutMs = extractionTimeoutMs()
): Promise<string> {
  if (!track.isText) {
    throw new BitmapOnlySubtitleError([track.codec]);
  }
  logger.debug(
    { index: track.index, codec: track.codec, lang: track.language },
    'extracting subtitle track to SRT'
  );
  const srt = await run(
    ffmpegBin(),
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      url,
      '-map',
      `0:${track.index}`,
      '-f',
      'srt',
      'pipe:1',
    ],
    { timeoutMs, maxStdoutBytes: 32 * 1024 * 1024 }
  );
  if (!srt.trim()) {
    throw new Error('Extraction produced an empty subtitle');
  }
  return srt;
}

/**
 * Convenience: probe, pick the best text track for `preferredLangs`, extract.
 * Throws {@link BitmapOnlySubtitleError} if only bitmap tracks exist.
 */
/**
 * Operator-configured ceiling for one extraction. Read lazily so the module
 * still imports before `initialiseConfig()` (tests, CLI paths).
 */
function extractionTimeoutMs(): number {
  if (!settingsStore.initialised) return 30 * 60_000;
  return Math.max(appConfig.subtitles.extractionTimeoutSeconds, 30) * 1000;
}

export async function extractBestSubtitle(
  url: string,
  preferredLangs: string[],
  allow: {
    forced?: boolean;
    hearingImpaired?: boolean;
    preferHearingImpaired?: boolean;
  } = {}
): Promise<{
  srt: string;
  track: ProbedSubtitleTrack;
  media: ProbedMediaInfo;
}> {
  let tracks: ProbedSubtitleTrack[];
  let media: ProbedMediaInfo;
  try {
    ({ tracks, media } = await probeMedia(url));
  } catch (err) {
    // ffprobe couldn't open the file at all — usually the release is
    // unavailable/dead on the backbone rather than lacking subtitles.
    throw new Error(
      `Could not read the release to extract subtitles — it may be unavailable or dead on the backbone. (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  const picked = pickTrack(tracks, preferredLangs, allow);
  if (!picked) {
    const bitmap = tracks.filter((t) => BITMAP_CODECS.has(t.codec));
    if (bitmap.length > 0) {
      throw new BitmapOnlySubtitleError(bitmap.map((t) => t.codec));
    }
    throw new Error(
      'No embedded text subtitle track found — the release may have none, or its subtitle data may be missing on the backbone (e.g. a partially dead NZB).'
    );
  }
  const srt = await extractTrackToSrt(url, picked);
  return { srt, track: picked, media };
}
