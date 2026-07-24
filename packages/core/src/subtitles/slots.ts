/**
 * The Stremio/Nuvio subtitle-slot surface (spec §5). Given a subtitle request,
 * decides which AIOStreams-generated entries to return — resolved synchronously,
 * server-side, from the request's own identity fields (spec §3.3). A slot with
 * nothing to say is simply omitted (spec §3.4).
 *
 * This pass implements the exact-file path only: the "Translate Exact",
 * "not ready" and "FINISHED" trio from the §5 table. Fast/External/Resync slots
 * are follow-on work.
 *
 * The `id` field carries the distinguishing slot label so it surfaces as
 * Nuvio's third line (spec §5.1); `lang` carries the human-facing text Stremio
 * shows, except on the finished subtitle where `lang` is the real target
 * language so the player treats the track correctly.
 */
import { createLogger } from '../logging/logger.js';
import { appConfig } from '../utils/index.js';
import type { Subtitle, UserData } from '../db/schemas.js';
import { ExtrasParser } from '../utils/extras.js';
import { getJob, resultId, getResult } from './job-store.js';
import { lookupServedRelease, releaseHash } from './release-lookup.js';
import { estimateEtaSeconds } from './pipeline.js';
import { encodeSubtitleToken } from './token.js';
import type { SubtitleJobKey } from './types.js';

const logger = createLogger('subtitles');

const SLOT_ID = {
  trigger: 'aiostreams-translate-exact',
  notReady: 'aiostreams-translate-exact-pending',
  finished: 'aiostreams-finished-translate-exact',
  failed: 'aiostreams-translate-exact-failed',
} as const;

function fmtEta(seconds: number): string {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))}s`;
  return `~${Math.round(seconds / 60)}m`;
}

function slotUrl(action: 'exact' | 'result', token: string): string {
  return `${appConfig.bootstrap.baseUrl}/api/v1/subtitles/${action}/${encodeURIComponent(
    token
  )}.srt`;
}

/**
 * Resolved subtitle-translation config for a user, or `null` when the feature
 * can't run (disabled globally/for-user, missing key/target). Centralises the
 * gating so both the slot builder and the job endpoint agree.
 */
export function resolveSubtitleConfig(userData: UserData): {
  sourceLanguages: string[];
  targetLanguage: string;
  apiKey: string;
  provider: string;
  model?: string;
} | null {
  if (!appConfig.bootstrap.subtitleTranslationEnabled) return null;
  const cfg = userData.subtitleTranslation;
  if (!cfg?.enabled) return null;
  if (!cfg.apiKey || !cfg.targetLanguage) return null;
  return {
    sourceLanguages: cfg.sourceLanguages ?? [],
    targetLanguage: cfg.targetLanguage,
    apiKey: cfg.apiKey,
    provider: cfg.provider ?? 'gemini',
    model: cfg.model,
  };
}

/**
 * Build the exact-path subtitle slots for a request. Returns `[]` (renders no
 * rows) whenever the feature is off, the release can't be identified, or the
 * full-file path is disabled on this instance (spec §7).
 */
export async function buildSubtitleSlots(
  userData: UserData,
  type: string,
  id: string,
  extras?: string
): Promise<Subtitle[]> {
  const cfg = resolveSubtitleConfig(userData);
  if (!cfg) {
    logger.debug(
      { id },
      'subtitle slots: feature not configured (needs enable + apiKey + targetLanguage)'
    );
    return [];
  }
  // Full-file extraction is the gated, download-heavy half (spec §7).
  if (!appConfig.bootstrap.subtitleExtractionAllowed) {
    logger.debug({ id }, 'subtitle slots: extraction disabled on this instance');
    return [];
  }
  const uuid = userData.uuid;
  const encryptedPassword = userData.encryptedPassword;
  if (!uuid || !encryptedPassword) return [];

  const parsed = new ExtrasParser(extras);

  // Identify the exact playing release. Without it, no exact-extract is
  // possible — return nothing rather than guess (spec §3.1).
  const served = await lookupServedRelease(uuid, id, {
    videoSize: parsed.videoSize,
    filename: parsed.filename,
  });
  logger.debug(
    {
      id,
      videoSize: parsed.videoSize,
      filename: parsed.filename,
      matched: !!served,
    },
    'subtitle slots: release lookup'
  );
  if (!served) return [];

  const key: SubtitleJobKey = {
    uuid,
    contentId: id,
    releaseHash: releaseHash({ size: served.size, filename: served.filename }),
    sourcePath: 'exact',
    targetLang: cfg.targetLanguage,
  };

  const token = encodeSubtitleToken({
    uuid,
    encryptedPassword,
    contentId: id,
    targetLang: cfg.targetLanguage,
    sourcePath: 'exact',
    videoSize: served.size,
    filename: served.filename,
  });
  if (!token) {
    logger.warn('failed to encode subtitle token');
    return [];
  }

  const job = await getJob(key);
  const eta = fmtEta(
    estimateEtaSeconds({ fileSizeBytes: served.size })
  );

  const slots: Subtitle[] = [];

  if (!job || job.status === 'failed') {
    // Offer (or re-offer, after a failure) the trigger. Clicking it starts the
    // background job and returns an immediate placeholder (spec §5).
    const label =
      job?.status === 'failed'
        ? `Retry: Translate Exact → ${cfg.targetLanguage} (${eta})`
        : `Translate Exact → ${cfg.targetLanguage} (${eta})`;
    slots.push({ id: SLOT_ID.trigger, url: slotUrl('exact', token), lang: label });
    return slots;
  }

  if (job.status === 'done' && job.resultKey) {
    // FINISHED slot: real target-language track, served from the stored SRT.
    slots.push({
      id: SLOT_ID.finished,
      url: slotUrl('result', token),
      lang: cfg.targetLanguage,
    });
    return slots;
  }

  // pending / running → always-present "not ready" placeholder with ETA.
  slots.push({
    id: SLOT_ID.notReady,
    url: slotUrl('result', token),
    lang: `Translating Exact → ${cfg.targetLanguage}… not ready (${fmtEta(
      job.etaSeconds || estimateEtaSeconds({ fileSizeBytes: served.size })
    )})`,
  });
  return slots;
}

/** Convenience for the route: does a finished result exist for this key? */
export async function getFinishedResult(
  key: SubtitleJobKey
): Promise<string | undefined> {
  const job = await getJob(key);
  if (job?.status === 'done' && job.resultKey) {
    return getResult(job.resultKey);
  }
  return getResult(resultId(key));
}
