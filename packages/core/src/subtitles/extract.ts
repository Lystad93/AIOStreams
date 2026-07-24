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
import {
  BitmapOnlySubtitleError,
  type ProbedSubtitleTrack,
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
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
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
  const json = await run(
    ffprobeBin(),
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      's',
      url,
    ],
    { timeoutMs, maxStdoutBytes: 4 * 1024 * 1024 }
  );
  let parsed: { streams?: FfprobeStream[] };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('ffprobe returned unparseable output');
  }
  return (parsed.streams ?? [])
    .filter((s) => s.codec_type === 'subtitle')
    .map(toTrack);
}

/**
 * Rank text tracks for a preferred source language. Non-forced, matching-lang,
 * non-SDH tracks win; forced/SDH are demoted (they're partial or cluttered).
 */
export function pickTrack(
  tracks: ProbedSubtitleTrack[],
  preferredLangs: string[]
): ProbedSubtitleTrack | undefined {
  const text = tracks.filter((t) => t.isText);
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
    const forced = Number(a.forced) - Number(b.forced);
    if (forced !== 0) return forced;
    const sdh = Number(a.hearingImpaired) - Number(b.hearingImpaired);
    if (sdh !== 0) return sdh;
    return a.index - b.index;
  })[0];
}

/**
 * Extract one text subtitle track to SRT text. `trackIndex` is the ffmpeg
 * stream index from {@link probeSubtitleTracks}. Bitmap codecs are refused
 * before spawning (they can't be `-f srt`'d).
 */
export async function extractTrackToSrt(
  url: string,
  track: ProbedSubtitleTrack,
  timeoutMs = 5 * 60_000
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
export async function extractBestSubtitle(
  url: string,
  preferredLangs: string[]
): Promise<{ srt: string; track: ProbedSubtitleTrack }> {
  let tracks: ProbedSubtitleTrack[];
  try {
    tracks = await probeSubtitleTracks(url);
  } catch (err) {
    // ffprobe couldn't open the file at all — usually the release is
    // unavailable/dead on the backbone rather than lacking subtitles.
    throw new Error(
      `Could not read the release to extract subtitles — it may be unavailable or dead on the backbone. (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  const picked = pickTrack(tracks, preferredLangs);
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
  return { srt, track: picked };
}
