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
import {
  appConfig,
  Cache,
  normaliseLanguage,
  getSimpleTextHash,
} from '../utils/index.js';
import type { Subtitle, UserData } from '../db/schemas.js';
import { SubtitleJobRepository } from '../db/index.js';
import { ExtrasParser } from '../utils/extras.js';
import { getJob, jobId, resultId, getResult, isStaleJob } from './job-store.js';
import {
  lookupServedRelease,
  releaseHash,
  getReleaseDurations,
} from './release-lookup.js';
import { estimateEtaSeconds, startExactJob } from './pipeline.js';
import { hasReusableSource } from './sources.js';
import { encodeSubtitleToken, encodeExternalToken } from './token.js';
import { normaliseReleaseName } from './release-name.js';
import {
  findExternalSubtitles,
  type ScoredSubtitle,
} from './providers/index.js';
import { PLAYBACK_PATH_PREFIX } from '../debrid/utils.js';
import type { SubtitleJob, SubtitleJobKey } from './types.js';

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

function slotUrl(
  action: 'exact' | 'result' | 'external',
  token: string
): string {
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
  if (!appConfig.subtitles.translationEnabled) return null;
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
  if (!appConfig.subtitles.extractionAllowed) {
    logger.debug(
      { id },
      'subtitle slots: extraction disabled on this instance'
    );
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

  // With a reusable source subtitle there's no download at all, so the job is
  // translation-time only — don't quote a filesize-derived download ETA.
  const canReuseSource = await hasReusableSource(
    served.filename,
    cfg.sourceLanguages,
    uuid,
    { contentId: id, durationMs: served.durationMs }
  );
  const eta = fmtEta(
    estimateEtaSeconds({
      fileSizeBytes: served.size,
      reuseSource: canReuseSource,
    })
  );
  const slots: Subtitle[] = [];

  // 1. Durable reuse first: if a finished translation is already stored in the
  // DB (permanent, survives cache TTL and restarts), serve it — never re-extract
  // or re-translate a file we've already done. Matches across addons too.
  const durableDone = !!(await storedTranslationId(
    uuid,
    id,
    cfg.targetLanguage,
    served.filename,
    key
  ));
  if (durableDone) {
    slots.push({
      id: SLOT_ID.finished,
      url: slotUrl('result', token),
      lang: cfg.targetLanguage,
    });
    return slots;
  }

  // 2. Otherwise consult the live job cache for in-flight / failed state.
  // A stale job (orphaned by a crash/restart) is treated as not running, so it
  // falls through to the retry offer instead of showing "not ready" forever.
  const found = await getJob(key);
  const job =
    found && isStaleJob(found, Date.now())
      ? { ...found, status: 'failed' as const }
      : found;

  if (job && (job.status === 'pending' || job.status === 'running')) {
    // Always-present "not ready" placeholder with ETA while a job is in flight.
    slots.push({
      id: SLOT_ID.notReady,
      url: slotUrl('result', token),
      lang: `Translating Exact → ${cfg.targetLanguage}… not ready (${fmtEta(
        job.etaSeconds || estimateEtaSeconds({ fileSizeBytes: served.size })
      )})`,
    });
    return slots;
  }

  // 3. No stored result and nothing running → offer (or re-offer, after a
  // failure) the trigger. Clicking it starts the background job (spec §5).
  const label =
    job?.status === 'failed'
      ? `Retry: Translate Exact → ${cfg.targetLanguage} (${eta})`
      : `Translate Exact → ${cfg.targetLanguage} (${eta})`;
  slots.push({
    id: SLOT_ID.trigger,
    url: slotUrl('exact', token),
    lang: label,
  });
  return slots;
}

/**
 * External-subtitle settings for a user. Deliberately usable WITHOUT the
 * translation feature: matching a subtitle to a release needs no AI key and
 * downloads no video, so someone who just wants a subtitle that fits gets it.
 * Falls back to the translation settings for languages (and for `enabled`, so
 * existing users keep the behaviour they already had).
 */
export function resolveExternalConfig(userData: UserData): {
  languages: string[];
  creds: { subsource?: string; subdl?: string };
} | null {
  if (!appConfig.subtitles.externalEnabled) return null;
  const ext = userData.externalSubtitles;
  const translation = userData.subtitleTranslation;
  const enabled = ext?.enabled ?? translation?.enabled ?? false;
  if (!enabled) return null;

  const languages =
    ext?.languages && ext.languages.length > 0
      ? ext.languages
      : [
          ...new Set(
            [
              translation?.targetLanguage,
              ...(translation?.sourceLanguages ?? []),
            ].filter((l): l is string => !!l)
          ),
        ];
  if (languages.length === 0) return null;

  return {
    languages,
    creds: {
      subsource: ext?.subsourceApiKey,
      subdl: ext?.subdlApiKey,
    },
  };
}

/** Cached external lookups — the subtitle menu is re-opened constantly. */
const externalCache = () =>
  Cache.getInstance<string, ScoredSubtitle[]>('subtitle-external', 500);
const EXTERNAL_TTL_SECONDS = 15 * 60;

/** Parse `tt1234567:1:8` into the parts the provider APIs need. */
function parseImdbContentId(contentId: string): {
  imdbId?: string;
  season?: number;
  episode?: number;
} {
  const [id, season, episode] = contentId.split(':');
  if (!id?.startsWith('tt')) return {};
  return {
    imdbId: id,
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
  };
}

/**
 * Externally-sourced subtitles matched against the playing release (spec §4.5).
 *
 * Unlike the extraction slots this needs no playback URL and downloads no
 * video, so it works even where extraction is gated off — it only needs the
 * release filename the player echoed back.
 */
export async function buildExternalSlots(
  userData: UserData,
  contentId: string,
  filename: string | undefined
): Promise<Subtitle[]> {
  const uuid = userData.uuid;
  if (!uuid || !filename) return [];
  const ext = resolveExternalConfig(userData);
  if (!ext) return [];
  const { languages, creds } = ext;
  const { imdbId, season, episode } = parseImdbContentId(contentId);
  if (!imdbId) return [];

  // Runtimes of every release offered for this title, so a subtitle claiming a
  // different release can still be recognised as timing-compatible.
  const durationIndex = await getReleaseDurations(uuid, contentId);
  const ourKey = normaliseReleaseName(filename);
  const ourDurationMs = ourKey ? durationIndex[ourKey] : undefined;

  const cacheKey = `${imdbId}|${season ?? ''}|${episode ?? ''}|${ourKey}|${languages.join(',')}|${ourDurationMs ?? ''}`;
  let matches = await externalCache().get(cacheKey);
  if (matches === undefined) {
    matches = await findExternalSubtitles(
      { imdbId, season, episode, languages, filename },
      {
        creds,
        duration: {
          ourDurationMs,
          index: durationIndex,
          toleranceSeconds: appConfig.subtitles.durationToleranceSeconds,
          tolerancePercent: appConfig.subtitles.durationTolerancePercent,
        },
      }
    );
    await externalCache().set(cacheKey, matches, EXTERNAL_TTL_SECONDS);
  }

  // A translate-from-external entry is only meaningful when translation is
  // configured AND the match isn't already in the target language.
  const translation = resolveSubtitleConfig(userData);
  const encryptedPassword = userData.encryptedPassword;

  const slots: Subtitle[] = [];
  for (const [i, match] of matches.entries()) {
    const token = encodeExternalToken({
      provider: match.candidate.provider,
      ref: match.candidate.downloadRef,
      releaseKey: filename,
      season,
      episode,
      lang: match.candidate.lang,
      // Carried so the (unauthenticated) download route can use this user's own
      // provider keys; the token is encrypted, so they aren't exposed.
      creds:
        creds.subsource || creds.subdl
          ? { subsource: creds.subsource, subdl: creds.subdl }
          : undefined,
    });
    if (!token) continue;
    // The tier matters more than the number: an exact match is evidence, a
    // percentage is an estimate of how well the timing should line up.
    const label =
      match.tier === 'exact-file'
        ? `${match.candidate.lang} — 100% exact file`
        : match.tier === 'exact-release'
          ? `${match.candidate.lang} — 100% exact release`
          : `${match.candidate.lang} — ${match.score}% match`;
    // Surfaced separately from the percentage: a runtime match is independent
    // evidence that the timing lines up, even when the names look different.
    const duration = match.durationMatched ? ' · duration ✓' : '';
    const provider = `${match.candidate.provider}${
      match.candidate.hearingImpaired ? ', SDH' : ''
    }`;

    // 1. Use it as-is — plays immediately, costs nothing.
    slots.push({
      id: `aiostreams-external-use-${match.candidate.provider}-${i}`,
      url: slotUrl('external', token),
      lang: `Use: ${label}${duration} (${provider})`,
    });

    // 2. Translate it — same match, but run through the LLM into the target
    // language. Needs no video download, so it's far cheaper than extraction.
    const sameLanguage =
      translation &&
      (normaliseLanguage(match.candidate.lang) ?? match.candidate.lang) ===
        (normaliseLanguage(translation.targetLanguage) ??
          translation.targetLanguage);
    if (translation && !sameLanguage && encryptedPassword) {
      const jobToken = encodeSubtitleToken({
        uuid,
        encryptedPassword,
        contentId,
        targetLang: translation.targetLanguage,
        sourcePath: 'external',
        filename,
        external: {
          provider: match.candidate.provider,
          ref: match.candidate.downloadRef,
          lang: match.candidate.lang,
          season,
          episode,
        },
      });
      if (jobToken) {
        const key: SubtitleJobKey = {
          uuid,
          contentId,
          releaseHash: externalJobHash(
            match.candidate.provider,
            match.candidate.downloadRef
          ),
          sourcePath: 'external',
          targetLang: translation.targetLanguage,
        };
        const existing = await getJob(key);
        const done =
          existing?.status === 'done' ||
          (await SubtitleJobRepository.hasTranslated(jobId(key)));
        const running =
          existing &&
          (existing.status === 'pending' || existing.status === 'running') &&
          !isStaleJob(existing, Date.now());

        slots.push({
          id: `aiostreams-external-translate-${match.candidate.provider}-${i}`,
          url: slotUrl(done ? 'result' : 'exact', jobToken),
          lang: done
            ? `${translation.targetLanguage} (translated from ${match.candidate.lang})`
            : running
              ? `Translating ${match.candidate.lang} → ${translation.targetLanguage}… not ready`
              : `Translate → ${translation.targetLanguage}: ${label}${duration} (${provider})`,
        });
      }
    }
  }
  return slots;
}

/**
 * Job identity for a translate-from-external job. Keyed on the provider entry
 * rather than the release, since that's what determines the source text.
 */
export function externalJobHash(provider: string, ref: string): string {
  return getSimpleTextHash(`external|${provider}|${ref}`);
}

/**
 * Flag every stream that already has a finished translation stored for the
 * user's target language, exposing `{stream.subtitleTranslated}` to the
 * formatter. Lets the stream list show which releases are ready to watch with
 * translated subtitles immediately (no extraction wait).
 *
 * One batched DB query for the whole list; mutates the streams in place.
 */
export async function markTranslatedStreams(
  userData: UserData,
  contentId: string,
  streams: { size?: number; filename?: string; subtitleTranslated?: boolean }[]
): Promise<void> {
  const cfg = resolveSubtitleConfig(userData);
  if (!cfg) return;
  const uuid = userData.uuid;
  if (!uuid) return;

  // Group by filename: the same release served by two addons must both be
  // flagged, even though their reported sizes (and so their job ids) differ.
  const byFilename = new Map<string, (typeof streams)[number][]>();
  for (const s of streams) {
    if (!s.filename) continue;
    const bucket = byFilename.get(s.filename);
    if (bucket) bucket.push(s);
    else byFilename.set(s.filename, [s]);
  }
  if (byFilename.size === 0) return;

  const translated = await SubtitleJobRepository.findTranslatedByFilenames(
    uuid,
    contentId,
    cfg.targetLanguage,
    [...byFilename.keys()]
  );
  for (const filename of translated.keys()) {
    for (const s of byFilename.get(filename) ?? []) {
      s.subtitleTranslated = true;
    }
  }
}

/**
 * Pre-translate the exact subtitle for a release that AIOStreams is precaching
 * (the next episode during a binge, spec §6). Fire-and-forget; gated so it only
 * runs when the user opted into BOTH precache-next-episode and this toggle, and
 * skips work that's already done or already in flight.
 */
export async function precacheTranslateExact(
  userData: UserData,
  contentId: string,
  stream: { url?: string; size?: number; filename?: string },
  now: number
): Promise<void> {
  const cfg = resolveSubtitleConfig(userData);
  if (!cfg) return;
  if (!userData.subtitleTranslation?.precacheNextEpisode) return;
  if (!appConfig.subtitles.extractionAllowed) return;
  const uuid = userData.uuid;
  if (!uuid) return;
  // Only our own, demuxable playback URLs (spec §4.2).
  if (!stream.url || !stream.url.includes(PLAYBACK_PATH_PREFIX)) return;
  if (stream.size == null && !stream.filename) return;

  const key: SubtitleJobKey = {
    uuid,
    contentId,
    releaseHash: releaseHash({ size: stream.size, filename: stream.filename }),
    sourcePath: 'exact',
    targetLang: cfg.targetLanguage,
  };

  // Already translated (durable, including via another addon) → nothing to do.
  if (
    await storedTranslationId(
      uuid,
      contentId,
      cfg.targetLanguage,
      stream.filename,
      key
    )
  ) {
    return;
  }

  const job: SubtitleJob = {
    ...key,
    status: 'pending',
    etaSeconds: estimateEtaSeconds({ fileSizeBytes: stream.size }),
    createdAt: now,
    updatedAt: now,
    filename: stream.filename,
    videoSize: stream.size,
    provider: cfg.provider,
    model: cfg.model,
  };

  const { started } = await startExactJob({
    job,
    playbackUrl: stream.url,
    sourceLanguages: cfg.sourceLanguages,
    targetLanguage: cfg.targetLanguage,
    apiKey: cfg.apiKey,
    providerId: cfg.provider,
    model: cfg.model,
    filename: stream.filename,
    videoSize: stream.size,
    now,
  });
  if (started) {
    logger.info(
      { contentId, target: cfg.targetLanguage, release: stream.filename },
      'pre-translating next episode subtitle (precache-selected release)'
    );
  }
}

/**
 * The job id of a stored translation for this release, if one exists.
 *
 * Checks the filename first so the same release served by a DIFFERENT addon
 * resolves to the existing translation (addons report file sizes
 * inconsistently, so the size-derived job id alone would miss it), then falls
 * back to this request's own job id.
 */
async function storedTranslationId(
  uuid: string,
  contentId: string,
  targetLang: string,
  filename: string | undefined,
  key: SubtitleJobKey
): Promise<string | undefined> {
  if (filename) {
    const found = await SubtitleJobRepository.findTranslatedByFilenames(
      uuid,
      contentId,
      targetLang,
      [filename]
    );
    const id = found.get(filename);
    if (id) return id;
  }
  const own = jobId(key);
  return (await SubtitleJobRepository.hasTranslated(own)) ? own : undefined;
}

/** Convenience for the route: the finished SRT for this key, if one exists. */
export async function getFinishedResult(
  key: SubtitleJobKey,
  filename?: string
): Promise<string | undefined> {
  const job = await getJob(key);
  if (job?.status === 'done' && job.resultKey) {
    const cached = await getResult(job.resultKey);
    if (cached) return cached;
  }
  const byResultId = await getResult(resultId(key));
  if (byResultId) return byResultId;
  // Durable fallback: the permanent DB record outlives the result cache TTL,
  // and resolves a translation made from another addon's copy of the release.
  const id = await storedTranslationId(
    key.uuid,
    key.contentId,
    key.targetLang,
    filename,
    key
  );
  if (!id) return undefined;
  const stored = await SubtitleJobRepository.getSrt(id, 'translated');
  return stored?.srt;
}
