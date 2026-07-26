/**
 * Job orchestration for the exact-file translate path (spec §4.2 → §4.4):
 * resolve the play URL → extract a text track → translate → store the result,
 * updating job state as it goes. Runs in the background; the request path never
 * blocks on it (spec §5). A slot that has nothing to say returns empty (§3.4).
 */
import { createLogger } from '../logging/logger.js';
import { normaliseLanguage } from '../utils/index.js';
import { SubtitleJobRepository } from '../db/index.js';
import { extractBestSubtitle } from './extract.js';
import { findReusableSource, storeExtractedSource } from './sources.js';
import { downloadExternalSubtitle } from './providers/index.js';
import type {
  ExternalProviderId,
  ProviderCredentials,
} from './providers/types.js';
import { parseSrt, serializeSrt } from './srt.js';
import {
  translateCues,
  getTranslationProvider,
  type TranslationProvider,
} from './translate.js';
import {
  getJob,
  putJob,
  putResult,
  resultId,
  jobId,
  createJobIfAbsent,
} from './job-store.js';
import { BitmapOnlySubtitleError, type SubtitleJob } from './types.js';

const logger = createLogger('subtitles');

/** Cold-start translation throughput seed (spec §6): 2 minutes. */
const TRANSLATION_SEED_SECONDS = 120;
/**
 * Fallback backbone throughput when no measured provider speed is available
 * (spec §6 wants the dashboard's tracked speed; until that's threaded in, this
 * conservative default keeps ETAs sane). ~15 MB/s.
 */
const DEFAULT_BYTES_PER_SEC = 15 * 1024 * 1024;

/**
 * Precompute the ETA baked into the slot label (spec §6). Extraction transits
 * the file on the backbone, so its dominant term is filesize ÷ speed; the
 * translation term is seeded until we track real per-provider throughput.
 */
export function estimateEtaSeconds(opts: {
  fileSizeBytes?: number;
  bytesPerSec?: number;
  /** A stored source subtitle exists, so nothing has to be downloaded. */
  reuseSource?: boolean;
}): number {
  if (opts.reuseSource) return TRANSLATION_SEED_SECONDS;
  const speed =
    opts.bytesPerSec && opts.bytesPerSec > 0
      ? opts.bytesPerSec
      : DEFAULT_BYTES_PER_SEC;
  const downloadSeconds = opts.fileSizeBytes ? opts.fileSizeBytes / speed : 60;
  return Math.round(downloadSeconds + TRANSLATION_SEED_SECONDS);
}

export interface RunJobInput {
  job: SubtitleJob;
  /**
   * Range-capable play URL of the exact release (from release-lookup). Not
   * needed when `externalSource` is set — that path never touches the video.
   */
  playbackUrl?: string;
  /**
   * Translate an externally-sourced subtitle instead of extracting one. This
   * is the cheap path: no file transit, just a small download and the LLM call.
   */
  externalSource?: {
    provider: ExternalProviderId;
    ref: string;
    lang: string;
    season?: number;
    episode?: number;
    releaseKey?: string;
    creds?: ProviderCredentials;
  };
  /** Ordered preferred source languages for track selection (§4.4). */
  sourceLanguages: string[];
  /**
   * Track kinds the user accepts. Unset means both, matching the provider-side
   * default — these are ordinary subtitles, only skipped when asked.
   */
  allowTracks?: { forced?: boolean; hearingImpaired?: boolean };
  targetLanguage: string;
  apiKey: string;
  providerId: string;
  model?: string;
  /** Original release filename/size, recorded in the durable dashboard store. */
  filename?: string;
  videoSize?: number;
  /** Runtime of the release, used to reuse a subtitle from a variant release. */
  durationMs?: number;
  now: number;
}

/**
 * Start the exact-translate job unless one already exists for the tuple. Fire
 * and forget: returns the (possibly pre-existing) job immediately; the actual
 * work runs detached so the subtitle request can return a placeholder now.
 */
export async function startExactJob(
  input: RunJobInput
): Promise<{ job: SubtitleJob; started: boolean }> {
  const { job, created } = await createJobIfAbsent(input.job);
  if (!created) return { job, started: false };

  // Durable dashboard record (best-effort; must not block the job).
  void persistMeta(input.job, input, 'pending').catch(() => {});

  // Detach: never block the subtitle request on extraction/translation.
  setImmediate(() => {
    runExactJob(input).catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'subtitle job crashed'
      );
    });
  });
  return { job, started: true };
}

/** Write the job's metadata to the durable dashboard store (best-effort). */
async function persistMeta(
  job: SubtitleJob,
  input: RunJobInput,
  status: SubtitleJob['status'],
  extra?: { sourceLang?: string; error?: string; completedAt?: number }
): Promise<void> {
  try {
    await SubtitleJobRepository.saveMeta({
      id: jobId(job),
      uuid: job.uuid,
      contentId: job.contentId,
      releaseHash: job.releaseHash,
      sourcePath: job.sourcePath,
      targetLang: job.targetLang,
      sourceLang: extra?.sourceLang ?? job.sourceLang,
      status,
      filename: input.filename,
      videoSize: input.videoSize,
      releaseDurationMs: input.durationMs,
      provider: input.providerId,
      model: input.model,
      error: extra?.error,
      createdAt: job.createdAt,
      updatedAt: Date.now(),
      completedAt: extra?.completedAt,
    });
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to persist subtitle job meta'
    );
  }
}

async function runExactJob(input: RunJobInput): Promise<void> {
  const { job, playbackUrl } = input;
  const provider: TranslationProvider = getTranslationProvider(
    input.providerId
  );

  const id = jobId(job);
  // Real wall-clock start; the passed-in `now` is only the creation stamp.
  const startedMs = Date.now();
  const mark = async (patch: Partial<SubtitleJob>) => {
    const current = (await getJob(job)) ?? job;
    await putJob({ ...current, ...patch, updatedAt: Date.now() });
  };

  try {
    await mark({ status: 'running' });
    await persistMeta(job, input, 'running');

    let srt: string;
    let sourceLang: string | undefined;

    if (input.externalSource) {
      // Externally-sourced: nothing to extract, so the job is just the
      // translation. This is what makes a matched subtitle cheap to translate.
      logger.info(
        {
          contentId: job.contentId,
          provider: input.externalSource.provider,
          lang: input.externalSource.lang,
        },
        'translating externally-sourced subtitle — no extraction needed'
      );
      srt = await downloadExternalSubtitle(input.externalSource);
      sourceLang = input.externalSource.lang;
      return await finishTranslation({
        input,
        id,
        job,
        srt,
        sourceLang,
        provider,
        mark,
        startedMs,
      });
    }

    // Reuse an already-extracted subtitle for this release if one exists —
    // an extraction depends only on the release, not on who wants it or which
    // language they're translating into. A hit skips the entire download+demux.
    const reusable = await findReusableSource(
      input.filename,
      input.sourceLanguages,
      job.uuid,
      { contentId: job.contentId, durationMs: input.durationMs }
    );

    if (reusable) {
      logger.info(
        {
          contentId: job.contentId,
          lang: reusable.meta.lang,
          origin: reusable.meta.origin,
        },
        'reusing stored source subtitle — skipping extraction'
      );
      srt = reusable.srt;
      sourceLang = reusable.meta.lang;
    } else {
      logger.info(
        { contentId: job.contentId, target: job.targetLang },
        'extracting subtitle for translation'
      );
      if (!playbackUrl) {
        throw new Error('No playback URL available to extract from');
      }
      const extracted = await extractBestSubtitle(
        playbackUrl,
        input.sourceLanguages,
        input.allowTracks ?? {}
      );
      srt = extracted.srt;
      sourceLang = extracted.track.language;
      // Add it to the pool so the next user/target language reuses it.
      await storeExtractedSource({
        contentId: job.contentId,
        filename: input.filename,
        videoSize: input.videoSize,
        srt: extracted.srt,
        track: extracted.track,
        media: extracted.media,
        createdBy: job.uuid,
        now: Date.now(),
      });
    }

    await finishTranslation({
      input,
      id,
      job,
      srt,
      sourceLang,
      provider,
      mark,
      startedMs,
    });
  } catch (err) {
    const message =
      err instanceof BitmapOnlySubtitleError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    logger.warn({ message }, 'subtitle job failed');
    await mark({ status: 'failed', error: message });
    await persistMeta(job, input, 'failed', { error: message });
  }
}

/**
 * Shared tail of every job: translate the source cues and store the result.
 * Both paths converge here — the only difference between them is how the source
 * subtitle was obtained (demuxed from the video, reused from the pool, or
 * downloaded from a provider).
 */
async function finishTranslation(args: {
  input: RunJobInput;
  id: string;
  job: SubtitleJob;
  srt: string;
  sourceLang: string | undefined;
  provider: TranslationProvider;
  mark: (patch: Partial<SubtitleJob>) => Promise<void>;
  startedMs: number;
}): Promise<void> {
  const { input, id, job, srt, sourceLang, provider, mark, startedMs } = args;

  const cues = parseSrt(srt);
  if (cues.length === 0) throw new Error('Source subtitle had no cues');
  await mark({ status: 'running', sourceLang });
  // Keep the untranslated source for dashboard download/inspection.
  await SubtitleJobRepository.setExtractedSrt(
    id,
    srt,
    cues.length,
    Date.now()
  ).catch(() => {});
  await persistMeta(job, input, 'running', { sourceLang });

  logger.info(
    { cues: cues.length, source: sourceLang, target: job.targetLang },
    'translating subtitle'
  );
  const translated = await translateCues(
    {
      cues,
      sourceLang: sourceLang
        ? (normaliseLanguage(sourceLang) ?? sourceLang)
        : undefined,
      targetLang: input.targetLanguage,
      apiKey: input.apiKey,
      model: input.model,
    },
    provider
  );

  const outSrt = serializeSrt(translated);
  const rid = resultId(job);
  const completedMs = Date.now();
  const durationMs = completedMs - startedMs;
  await putResult(rid, outSrt);
  await mark({ status: 'done', resultKey: rid, sourceLang });
  await SubtitleJobRepository.setTranslatedSrt(
    id,
    outSrt,
    completedMs,
    durationMs
  ).catch(() => {});
  await persistMeta(job, input, 'done', {
    sourceLang,
    completedAt: completedMs,
  });
  logger.info(
    { contentId: job.contentId, target: job.targetLang, durationMs },
    'subtitle translation complete'
  );
}
