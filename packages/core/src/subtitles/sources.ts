/**
 * The reusable source-subtitle pool. An extraction depends only on the release
 * and the track — not on who asked, and not on the language they want it
 * translated into. So before downloading and demuxing a file we check whether
 * anyone has already extracted a usable subtitle for it.
 *
 * This is what lets a Spanish-speaking user translate from an English track
 * someone else extracted, without touching the file at all — and it's the same
 * shape externally-sourced subtitles (§4.5) will land in.
 */
import { createLogger } from '../logging/logger.js';
import { appConfig, normaliseLanguage } from '../utils/index.js';
import {
  SubtitleSourceRepository,
  sourceId,
  type SubtitleSource,
  type SubtitleSourceMeta,
} from '../db/index.js';
import { parseSrt } from './srt.js';
import type { ProbedMediaInfo, ProbedSubtitleTrack } from './types.js';

const logger = createLogger('subtitles');

/**
 * Owner scope for pool lookups: `undefined` means "any user's sources"
 * (shared), otherwise restrict to this user's own.
 */
export function sourceScope(uuid: string): string | undefined {
  return appConfig.subtitles.shareSources ? undefined : uuid;
}

/**
 * Rank stored sources for a release against the user's preferred source
 * languages. Mirrors {@link pickTrack}: preferred language first, then plain
 * tracks over forced/SDH (a forced track only covers foreign dialogue, and SDH
 * is cluttered with sound cues — neither makes a good translation input).
 */
export function pickSource(
  sources: SubtitleSourceMeta[],
  preferredLangs: string[]
): SubtitleSourceMeta | undefined {
  if (sources.length === 0) return undefined;
  const preferred = preferredLangs.map((p) => normaliseLanguage(p) ?? p);

  const langRank = (s: SubtitleSourceMeta): number => {
    const name = normaliseLanguage(s.lang) ?? s.lang;
    const i = preferred.findIndex((p) => p === name);
    return i === -1 ? preferred.length : i;
  };

  return [...sources].sort((a, b) => {
    const byLang = langRank(a) - langRank(b);
    if (byLang !== 0) return byLang;
    const forced = Number(a.forced) - Number(b.forced);
    if (forced !== 0) return forced;
    const sdh = Number(a.hearingImpaired) - Number(b.hearingImpaired);
    if (sdh !== 0) return sdh;
    return b.createdAt - a.createdAt;
  })[0];
}

/**
 * A stored source subtitle usable as translation input for this release, if one
 * exists. A hit means the whole download+demux step can be skipped.
 */
export async function findReusableSource(
  filename: string | undefined,
  preferredLangs: string[],
  uuid: string,
  runtime?: { contentId: string; durationMs?: number }
): Promise<{ srt: string; meta: SubtitleSourceMeta } | undefined> {
  if (!filename) return undefined;
  const sources = await collectCandidateSources(filename, uuid, runtime);
  const best = pickSource(sources, preferredLangs);
  if (!best) return undefined;
  const srt = await SubtitleSourceRepository.getSrt(best.id);
  if (!srt) return undefined;
  return { srt, meta: best };
}

/**
 * Whether a usable source subtitle already exists, without fetching its body.
 * Used to keep the slot's ETA honest: with a hit there's no download, so the
 * job is translation-time only rather than filesize ÷ backbone speed.
 */
export async function hasReusableSource(
  filename: string | undefined,
  preferredLangs: string[],
  uuid: string,
  runtime?: { contentId: string; durationMs?: number }
): Promise<boolean> {
  if (!filename) return false;
  const sources = await collectCandidateSources(filename, uuid, runtime);
  return !!pickSource(sources, preferredLangs);
}

/**
 * Stored sources usable for this release: the ones extracted from this exact
 * release, plus — when we know how long it runs — any whose measured runtime
 * agrees. Runtime agreement is what makes a subtitle from a cosmetically
 * different release (extra `HDR` token, different encode, 60fps remux) valid,
 * and reusing one there avoids re-downloading the whole file.
 */
async function collectCandidateSources(
  filename: string,
  uuid: string,
  runtime?: { contentId: string; durationMs?: number }
): Promise<SubtitleSourceMeta[]> {
  const scope = sourceScope(uuid);
  const exact = await SubtitleSourceRepository.findByFilename(filename, scope);
  if (!runtime?.durationMs) return exact;

  const toleranceMs = Math.max(
    appConfig.subtitles.durationToleranceSeconds * 1000,
    (runtime.durationMs * appConfig.subtitles.durationTolerancePercent) / 100
  );
  const byDuration = await SubtitleSourceRepository.findByDuration(
    runtime.contentId,
    runtime.durationMs,
    toleranceMs,
    scope
  );

  const seen = new Set(exact.map((s) => s.id));
  const merged = [...exact];
  for (const s of byDuration) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      merged.push(s);
    }
  }
  if (merged.length > exact.length) {
    logger.debug(
      {
        filename,
        durationMs: runtime.durationMs,
        extra: merged.length - exact.length,
      },
      'found additional source subtitles by matching runtime'
    );
  }
  return merged;
}

/**
 * Record a freshly extracted subtitle in the pool, with the measured properties
 * that make it matchable against other releases later.
 */
export async function storeExtractedSource(args: {
  contentId: string;
  filename?: string;
  videoSize?: number;
  srt: string;
  track: ProbedSubtitleTrack;
  media: ProbedMediaInfo;
  createdBy: string;
  now: number;
}): Promise<void> {
  if (!args.filename) return; // filename is the release identity; no key without it
  const lang =
    normaliseLanguage(args.track.language ?? '') ??
    args.track.language ??
    'Unknown';

  const cues = parseSrt(args.srt);
  const source: SubtitleSource = {
    id: sourceId({ filename: args.filename, lang, origin: 'extracted' }),
    contentId: args.contentId,
    filename: args.filename,
    videoSize: args.videoSize,
    lang,
    origin: 'extracted',
    trackIndex: args.track.index,
    trackCodec: args.track.codec,
    forced: !!args.track.forced,
    hearingImpaired: !!args.track.hearingImpaired,
    trackTitle: args.track.title,
    durationMs: args.media.durationMs,
    fps: args.media.fps,
    width: args.media.width,
    height: args.media.height,
    videoCodec: args.media.videoCodec,
    cueCount: cues.length,
    firstCueMs: cues[0]?.startMs,
    lastCueMs: cues[cues.length - 1]?.endMs,
    srt: args.srt,
    createdBy: args.createdBy,
    createdAt: args.now,
  };

  try {
    await SubtitleSourceRepository.put(source);
    logger.debug(
      { filename: args.filename, lang, durationMs: source.durationMs },
      'stored source subtitle for reuse'
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to store source subtitle'
    );
  }
}
