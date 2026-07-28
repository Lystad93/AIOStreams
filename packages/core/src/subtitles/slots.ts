/**
 * The Stremio/Nuvio subtitle-slot surface (spec §5). Given a subtitle request,
 * decides which AIOStreams-generated entries to return — resolved synchronously,
 * server-side, from the request's own identity fields (spec §3.3). A slot with
 * nothing to say is simply omitted (spec §3.4).
 *
 * Covers the exact-file path — the "Translate Exact", "not ready" and
 * "FINISHED" trio from the §5 table — plus the externally-sourced slots
 * (§4.5) built by `buildExternalSlots`. Fast alternate-source (§4.3) and
 * Resync (§4.6) remain follow-on work.
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
import { evaluateCandidate, minDisplayScore } from './relation.js';
import {
  buildLabel,
  buildDescription,
  renderHeader,
  renderDetail,
  standardLangCode,
  type RenderContext,
} from './render.js';
import {
  findExternalSubtitles,
  type ScoredSubtitle,
} from './providers/index.js';
import type {
  ExternalFilters,
  ExternalProviderId,
  ProviderCredentials,
} from './providers/types.js';
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
export interface ResolvedTranslationProvider {
  id: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * The user's LLM providers, in the order failover should try them.
 *
 * Only enabled entries with a key survive — a provider with no key would fail
 * on its first call and simply waste a batch's latency before falling over.
 * Falls back to the legacy single-provider fields so configs written before
 * multi-provider support keep working untouched.
 */
export function resolveTranslationProviders(
  userData: UserData
): ResolvedTranslationProvider[] {
  const cfg = userData.subtitleTranslation;
  if (!cfg) return [];

  const list = (cfg.providers ?? [])
    .filter((p) => p.enabled !== false && p.apiKey?.trim())
    .map((p) => ({
      id: p.id,
      apiKey: p.apiKey!.trim(),
      model: p.model?.trim() || undefined,
      baseUrl: p.baseUrl?.trim() || undefined,
    }));
  if (list.length > 0) return list;

  return cfg.apiKey?.trim()
    ? [
        {
          id: cfg.provider ?? 'gemini',
          apiKey: cfg.apiKey.trim(),
          model: cfg.model?.trim() || undefined,
        },
      ]
    : [];
}

export function resolveSubtitleConfig(userData: UserData): {
  sourceLanguages: string[];
  targetLanguage: string;
  apiKey: string;
  provider: string;
  model?: string;
  providers: ResolvedTranslationProvider[];
} | null {
  if (!appConfig.subtitles.translationEnabled) return null;
  const cfg = userData.subtitleTranslation;
  if (!cfg?.enabled) return null;
  if (!cfg.targetLanguage) return null;
  // At least one usable provider — the legacy `apiKey` check generalised.
  const providers = resolveTranslationProviders(userData);
  if (providers.length === 0) return null;
  return {
    sourceLanguages: cfg.sourceLanguages ?? [],
    targetLanguage: cfg.targetLanguage,
    // Kept for callers still passing a single provider; always the first of the
    // chain so the two can never disagree about what runs first.
    apiKey: providers[0].apiKey,
    provider: providers[0].id,
    model: providers[0].model,
    providers,
  };
}

/**
 * Which subtitle kinds this user accepts, for both externally-sourced results
 * and the embedded track extraction picks. Deliberately one setting: "I don't
 * want forced subtitles" is a statement about subtitles, not about where they
 * came from. Unset means accept both.
 */
export function resolveTrackPreferences(userData: UserData): {
  forced?: boolean;
  hearingImpaired?: boolean;
} {
  const ext = userData.externalSubtitles;
  return {
    forced: ext?.includeForced !== false,
    hearingImpaired: ext?.includeHearingImpaired !== false,
  };
}

/**
 * The user's chosen tokens for each line, plus the compatibility override.
 *
 * `standardLanguageCodes` applies only to rows that actually deliver a
 * subtitle in a known language. An offer or a placeholder is not a subtitle
 * yet, so forcing a bare language code onto it would tell the player something
 * untrue and lose the only text explaining what the row does.
 */
function displayTokens(userData: UserData): {
  header: string[];
  detail: string[];
  standardCodes: boolean;
} {
  const d = userData.subtitleDisplay;
  return {
    header: d?.header?.length ? d.header : [],
    detail: d?.detail?.length ? d.detail : [],
    standardCodes: d?.standardLanguageCodes !== false,
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
  const display = displayTokens(userData);
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
  const durable = await storedTranslation(
    uuid,
    id,
    cfg.targetLanguage,
    served.filename,
    key,
    served.durationMs
  );
  if (durable) {
    // Flagged only for a runtime match, where the subtitle was made for a
    // different release and the equal runtime is the whole reason it's offered.
    // A name match needs no such caveat.
    slots.push({
      id:
        durable.matchedBy === 'duration'
          ? `${SLOT_ID.finished}-duration`
          : SLOT_ID.finished,
      url: slotUrl('result', token),
      // This row delivers a real subtitle in a known language, so the header
      // follows the Stremio SDK's ISO 639-2 expectation unless the user opted
      // out — players that resolve `lang` strictly show anything else as
      // "Unknown". The match evidence rides in `id`.
      lang: display.standardCodes
        ? standardLangCode(cfg.targetLanguage)
        : renderHeader(display.header, { targetLang: cfg.targetLanguage }),
    });
    return slots;
  }
  if (!served.durationMs) {
    // The single most common reason a duration match never fires. The index is
    // built from `stream.duration`, so a stream list where no addon reports a
    // runtime leaves nothing to match on.
    logger.debug(
      { filename: served.filename, contentId: id },
      'no runtime known for the playing release — duration matching is inactive; enable the "duration" merged metadata field or use an addon that reports it'
    );
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
      // Detail rides in `id`, which the player renders as the smaller
      // secondary line; `lang` stays the language header.
      id: renderDetail(display.detail, {
        targetLang: cfg.targetLanguage,
        score: 100,
        etaText: fmtEta(
          job.etaSeconds || estimateEtaSeconds({ fileSizeBytes: served.size })
        ),
        provider: 'embedded',
      }),
      url: slotUrl('result', token),
      // Same header as every other row for this language: the player groups on
      // an exact string match, so `NOR` here and `nor` elsewhere would split
      // one language into two entries.
      lang: display.standardCodes
        ? standardLangCode(cfg.targetLanguage)
        : renderHeader(display.header, { targetLang: cfg.targetLanguage }),
    });
    return slots;
  }

  // 3. No stored result and nothing running → offer (or re-offer, after a
  // failure) the trigger. Clicking it starts the background job (spec §5).
  slots.push({
    // Extraction comes from the playing file itself, so it bypasses the match
    // matrix and is always 100 (§6).
    id: `${renderDetail(display.detail, {
      targetLang: cfg.targetLanguage,
      score: 100,
      etaText: eta,
      provider: 'embedded',
    })}${job?.status === 'failed' ? '(retry)' : ''}`,
    url: slotUrl('exact', token),
    lang: display.standardCodes
      ? standardLangCode(cfg.targetLanguage)
      : renderHeader(display.header, { targetLang: cfg.targetLanguage }),
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
  creds: ProviderCredentials;
  filters: ExternalFilters;
} | null {
  if (!appConfig.subtitles.externalEnabled) return null;
  const ext = userData.externalSubtitles;
  const translation = userData.subtitleTranslation;
  const enabled = ext?.enabled ?? translation?.enabled ?? false;
  if (!enabled) return null;

  let languages =
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
  // Ready-made target-language subtitles need the target language to be in the
  // query in the first place — a user whose source list is "English, Swedish"
  // would otherwise never be offered the Norwegian that already exists.
  if (
    translation?.showTargetLanguageSubs !== false &&
    translation?.targetLanguage &&
    !languages.includes(translation.targetLanguage)
  ) {
    languages = [translation.targetLanguage, ...languages];
  }
  if (languages.length === 0) return null;

  // Unset means on, so a provider added in a later version doesn't stay
  // silently off for people who configured this before it existed.
  const p = ext?.providers;
  const providers = (
    ['subsource', 'subdl', 'opensubtitles'] as ExternalProviderId[]
  ).filter((id) => p?.[id] !== false);
  // Every provider off is a deliberate "none", not a reason to fall back to all
  // of them — which is what an empty list would mean downstream.
  if (providers.length === 0) return null;

  return {
    languages,
    creds: {
      subsource: ext?.subsourceApiKey,
      subdl: ext?.subdlApiKey,
      opensubtitlesApiKey: ext?.opensubtitlesApiKey,
      opensubtitlesUsername: ext?.opensubtitlesUsername,
      opensubtitlesPassword: ext?.opensubtitlesPassword,
    },
    filters: {
      providers,
      hearingImpaired: ext?.includeHearingImpaired !== false,
      forced: ext?.includeForced !== false,
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
  filename: string | undefined,
  /**
   * OpenSubtitles-format hash of the video, when the player supplies one. This
   * is the only signal that yields a verified exact-FILE match rather than a
   * name comparison, so it is worth threading all the way through.
   */
  videoHash?: string
): Promise<Subtitle[]> {
  const uuid = userData.uuid;
  if (!uuid || !filename) return [];
  const ext = resolveExternalConfig(userData);
  if (!ext) return [];
  const { languages, creds, filters } = ext;
  const { imdbId, season, episode } = parseImdbContentId(contentId);
  if (!imdbId) return [];

  // Runtimes of every release offered for this title, so a subtitle claiming a
  // different release can still be recognised as timing-compatible.
  const durationIndex = await getReleaseDurations(uuid, contentId);
  const ourKey = normaliseReleaseName(filename);
  const ourDurationMs = ourKey ? durationIndex[ourKey] : undefined;

  // The filters are part of the key: without them a cached hit would keep
  // serving a provider for the rest of the TTL after it was switched off, which
  // looks exactly like the setting having no effect.
  const filterKey = `${filters.providers?.join('+') ?? 'all'}|${
    filters.hearingImpaired === false ? 'nohi' : ''
  }${filters.forced === false ? 'nofor' : ''}`;
  const cacheKey = `${imdbId}|${season ?? ''}|${episode ?? ''}|${ourKey}|${languages.join(',')}|${ourDurationMs ?? ''}|${filterKey}|${videoHash ?? ''}`;
  let matches = await externalCache().get(cacheKey);
  if (matches === undefined) {
    matches = await findExternalSubtitles(
      { imdbId, season, episode, languages, filename, movieHash: videoHash },
      {
        creds,
        filters,
        limit: Math.max(
          appConfig.subtitles.externalUseLimit,
          appConfig.subtitles.externalTranslateLimit
        ),
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

  const display = displayTokens(userData);
  const useLimit = appConfig.subtitles.externalUseLimit;
  const translateLimit = appConfig.subtitles.externalTranslateLimit;
  // Ready-made target-language subtitles get their own budget: they cost
  // nothing and need no waiting, so they shouldn't compete for slots with the
  // source-language rows that exist only to be translated.
  const targetCfg = userData.subtitleTranslation;
  const targetDirectEnabled = targetCfg?.showTargetLanguageSubs !== false;
  const targetDirectLimit = targetDirectEnabled
    ? (targetCfg?.targetLanguageSubLimit ?? 3)
    : 0;
  let usedCount = 0;
  let translateCount = 0;
  let targetDirectCount = 0;
  // Headers that represent the target language, so the ordering below can find
  // those rows without re-deriving how each was rendered.
  const targetLangHeaders = new Set<string>();
  // Rendered once: every target-language row must produce a byte-identical
  // header, and the exact-path rows render from `targetLang` the same way.
  const targetHeader = translation
    ? display.standardCodes
      ? standardLangCode(translation.targetLanguage)
      : renderHeader(display.header, { targetLang: translation.targetLanguage })
    : '';

  // Pool every runtime the providers stated, keyed by the release it was
  // stated FOR. Uploaders write the runtime in prose far more often than the
  // stream list carries one, and a figure stated by SubSource for a release is
  // just as usable when SubDL's entry claims that same release. Cached
  // stream-list runtimes still win: those are observations, these are claims.
  const stated: Record<string, number> = {};
  for (const m of matches) {
    if (!m.candidate.statedDurationMs) continue;
    for (const name of m.candidate.releaseNames) {
      const k = normaliseReleaseName(name);
      if (k && !stated[k]) stated[k] = m.candidate.statedDurationMs;
    }
  }
  /**
   * One runtime for the title, agreed across providers.
   *
   * Pooling by exact release name isn't enough: SubSource states a runtime for
   * the 720p BYNDR release, SubDL's Norwegian entry claims the 1080p one, and
   * the file playing is the 2160p — three different keys for one master. The
   * identity gate has already established these are the same title and episode,
   * so a runtime stated for any of them describes all of them.
   *
   * Applied to the SUBTITLE side only. Letting the stream side fall back to the
   * same figure would make every comparison trivially EQUAL and turn an honest
   * "unknown" into a fabricated ✓.
   */
  const statedValues = Object.values(stated);
  const titleStatedMs = statedValues.length
    ? statedValues.sort((a, b) => a - b)[Math.floor(statedValues.length / 2)]
    : undefined;

  const durationFor = (key: string | undefined): number | undefined =>
    (key ? (durationIndex[key] ?? stated[key]) : undefined) ?? titleStatedMs;

  // Without a runtime for the release being played, every candidate falls to
  // the UNKNOWN column no matter how good the evidence on the other side is.
  const playingDurationMs =
    ourDurationMs ??
    (ourKey ? (durationIndex[ourKey] ?? stated[ourKey]) : undefined);
  if (!playingDurationMs) {
    logger.debug(
      { filename, contentId, statedKeys: Object.keys(stated).length },
      'no runtime known for the playing release — every subtitle will score in the UNKNOWN column; enable the "duration" merged metadata field'
    );
  }

  // Re-score every candidate against the playing release using the match spec
  // (§4–§6): parsed-field tiers rather than token overlap, with the duration
  // cache supplying runtimes for release names we've seen in a stream list.
  const evaluated = matches
    .map((match, i) => {
      // A candidate may claim several release names; take its best.
      const names = match.candidate.releaseNames.length
        ? match.candidate.releaseNames
        : [undefined];
      let best: ReturnType<typeof evaluateCandidate> | undefined;
      for (const name of names) {
        const key = name ? normaliseReleaseName(name) : '';
        const evaluation = evaluateCandidate({
          subFilename: name,
          streamFilename: filename,
          // Resolution order (§3): the cached runtime for this release name
          // first, then whatever the uploader stated in their comment. The
          // cache is an observation; the comment is a claim, so it ranks lower.
          subDurationMs: durationFor(key) ?? match.candidate.statedDurationMs,
          streamDurationMs: playingDurationMs,
        });
        if (!best || evaluation.score > best.score) best = evaluation;
      }
      return { match, i, evaluation: best! };
    })
    // An identity contradiction is a reject, not a low score, and anything
    // under the floor is computed but never rendered (§4, §6).
    .filter(
      (e) => !e.evaluation.rejected && e.evaluation.score >= minDisplayScore()
    )
    .sort((a, b) => b.evaluation.score - a.evaluation.score);

  // One rank per candidate, shared by its "use" and "translate" rows so the
  // two lists line up: `2#` in one is the same subtitle as `2#` in the other.
  // Suppressed entirely when there is only one candidate — a lone `1#` is noise.
  const ranked = evaluated.map((e, index) => ({
    ...e,
    rank: evaluated.length > 1 ? index + 1 : 0,
  }));

  const slots: Subtitle[] = [];
  for (const { match, i, evaluation, rank } of ranked) {
    if (
      usedCount >= useLimit &&
      translateCount >= translateLimit &&
      targetDirectCount >= targetDirectLimit
    ) {
      break;
    }
    const token = encodeExternalToken({
      provider: match.candidate.provider,
      ref: match.candidate.downloadRef,
      releaseKey: filename,
      season,
      episode,
      lang: match.candidate.lang,
      // Carried so the (unauthenticated) download route can use this user's own
      // provider keys; the token is encrypted, so they aren't exposed.
      creds: Object.values(creds).some(Boolean) ? creds : undefined,
    });
    if (!token) continue;

    const machineSource =
      !!match.candidate.aiTranslated || !!match.candidate.machineTranslated;
    const ctx: RenderContext = {
      sourceLang: match.candidate.lang,
      rank,
      score: evaluation.score,
      provider: match.candidate.provider,
      machineSource,
      duration: evaluation.duration,
      diffs: evaluation.diffs,
      seasonPack: evaluation.seasonPack,
      seasonLabel: evaluation.seasonLabel,
      subDurationMs: evaluation.subDurationMs,
      streamDurationMs: playingDurationMs,
    };
    const description = renderDetail(display.detail, ctx);

    // 1. Use it as-is — plays immediately, costs nothing.
    const isTargetLanguage =
      !!translation &&
      (normaliseLanguage(match.candidate.lang) ?? match.candidate.lang) ===
        (normaliseLanguage(translation.targetLanguage) ??
          translation.targetLanguage);
    const budgetOk = isTargetLanguage
      ? targetDirectCount < targetDirectLimit
      : usedCount < useLimit;
    if (budgetOk) {
      if (isTargetLanguage) targetDirectCount++;
      else usedCount++;
      // A subtitle already in the target language belongs under the SAME header
      // as the extracted/translated rows — it is the same language, so the
      // player should group them. That means rendering it exactly as the
      // exact-path rows do: from `targetLang`, with no rank prefix, since any
      // difference in the string splits one language into two entries.
      const header = isTargetLanguage
        ? targetHeader
        : display.standardCodes
          ? standardLangCode(match.candidate.lang)
          : renderHeader(display.header, ctx);
      if (isTargetLanguage && header) targetLangHeaders.add(header);
      slots.push({
        // `lang` is the big header; everything quantitative moves to `id`,
        // which the player renders smaller.
        id: description,
        url: slotUrl('external', token),
        lang: header,
      });
    }

    // 2. Translate it — same match, but run through the LLM into the target
    // language. Needs no video download, so it's far cheaper than extraction.
    if (
      translation &&
      !isTargetLanguage &&
      encryptedPassword &&
      translateCount < translateLimit
    ) {
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
        translateCount++;
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

        const translateEta = fmtEta(estimateEtaSeconds({ reuseSource: true }));
        const translateCtx: RenderContext = {
          ...ctx,
          targetLang: translation.targetLanguage,
          etaText: done ? undefined : running ? 'running' : translateEta,
        };
        slots.push({
          // Distinct from the "use" row's detail by the ETA, so the two rows
          // for one candidate never collide on `id`.
          id: renderDetail(display.detail, translateCtx),
          url: slotUrl(done ? 'result' : 'exact', jobToken),
          // A finished translation delivers a real subtitle in the target
          // language, so it takes the standard code; an offer or an in-flight
          // job is not a subtitle yet and keeps its readable header.
          lang: display.standardCodes
            ? standardLangCode(translation.targetLanguage)
            : renderHeader(display.header, translateCtx),
        });
      }
    }
  }
  // Ready-made subtitles in the target language lead: they need no waiting and
  // no API spend, so they are what most users want to click. Everything else
  // keeps its score order behind them.
  return [
    ...slots.filter((s) => targetLangHeaders.has(s.lang)),
    ...slots.filter((s) => !targetLangHeaders.has(s.lang)),
  ];
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
  streams: {
    size?: number;
    filename?: string;
    /** Runtime in ms, as carried on ParsedStream. */
    duration?: number;
    subtitleTranslated?: boolean;
    translatedSubtitles?: string[];
  }[]
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
    [...byFilename.keys()],
    translationScope(uuid)
  );
  const flag = (s: (typeof streams)[number]) => {
    s.subtitleTranslated = true;
    s.translatedSubtitles = [
      ...new Set([...(s.translatedSubtitles ?? []), cfg.targetLanguage]),
    ];
  };

  for (const filename of translated.keys()) {
    for (const s of byFilename.get(filename) ?? []) flag(s);
  }

  // Also flag releases whose runtime matches a translation already in the
  // library, even though their names differ — those play with it as-is.
  const stillUnflagged = streams.filter(
    (s) => !s.subtitleTranslated && s.duration && s.duration > 0
  );
  if (stillUnflagged.length === 0) return;
  const checked = new Map<number, boolean>();
  for (const s of stillUnflagged) {
    const durationMs = s.duration!;
    let hit = checked.get(durationMs);
    if (hit === undefined) {
      hit = !!(await SubtitleJobRepository.findTranslatedByDuration(
        uuid,
        contentId,
        cfg.targetLanguage,
        durationMs,
        durationToleranceMs(durationMs),
        translationScope(uuid)
      ));
      checked.set(durationMs, hit);
    }
    if (hit) flag(s);
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
    allowTracks: resolveTrackPreferences(userData),
    targetLanguage: cfg.targetLanguage,
    apiKey: cfg.apiKey,
    providerId: cfg.provider,
    model: cfg.model,
    providerChain: cfg.providers,
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
/**
 * Owner scope for translation lookups: `undefined` means "any user's finished
 * translation", mirroring {@link sourceScope} for extracted sources.
 *
 * Translation is the expensive half — re-running it per user burns API quota to
 * produce a byte-identical result for the same release and target language.
 */
export function translationScope(uuid: string): string | undefined {
  return appConfig.subtitles.shareTranslations ? undefined : uuid;
}

/**
 * How a stored translation was found. Worth surfacing: a subtitle matched on
 * runtime alone was made for a DIFFERENT release, which is exactly the case a
 * user wants to see flagged before trusting the timing.
 */
export type StoredMatch = {
  id: string;
  matchedBy: 'filename' | 'own' | 'duration';
};

async function storedTranslationId(
  uuid: string,
  contentId: string,
  targetLang: string,
  filename: string | undefined,
  key: SubtitleJobKey,
  durationMs?: number
): Promise<string | undefined> {
  return (
    await storedTranslation(
      uuid,
      contentId,
      targetLang,
      filename,
      key,
      durationMs
    )
  )?.id;
}

async function storedTranslation(
  uuid: string,
  contentId: string,
  targetLang: string,
  filename: string | undefined,
  key: SubtitleJobKey,
  durationMs?: number
): Promise<StoredMatch | undefined> {
  if (filename) {
    const found = await SubtitleJobRepository.findTranslatedByFilenames(
      uuid,
      contentId,
      targetLang,
      [filename],
      translationScope(uuid)
    );
    const id = found.get(filename);
    if (id) return { id, matchedBy: 'filename' };
  }
  const own = jobId(key);
  if (await SubtitleJobRepository.hasTranslated(own))
    return { id: own, matchedBy: 'own' };

  // Last resort, and the one that makes a library subtitle reusable: a
  // translation made for a DIFFERENT release of this title whose runtime
  // matches. Releases that differ only cosmetically share subtitle timing.
  if (durationMs) {
    const id = await SubtitleJobRepository.findTranslatedByDuration(
      uuid,
      contentId,
      targetLang,
      durationMs,
      durationToleranceMs(durationMs),
      translationScope(uuid)
    );
    if (id) return { id, matchedBy: 'duration' };
  }
  return undefined;
}

/** The spec's `max(N seconds, X% of runtime)` tolerance, from config. */
export function durationToleranceMs(durationMs: number): number {
  return Math.max(
    appConfig.subtitles.durationToleranceSeconds * 1000,
    (durationMs * appConfig.subtitles.durationTolerancePercent) / 100
  );
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
  // Resolve the release's runtime so a translation made for a different but
  // equally-long release still serves.
  const served = filename
    ? await lookupServedRelease(key.uuid, key.contentId, { filename })
    : undefined;
  const id = await storedTranslationId(
    key.uuid,
    key.contentId,
    key.targetLang,
    filename,
    key,
    served?.durationMs
  );
  if (!id) return undefined;
  const stored = await SubtitleJobRepository.getSrt(id, 'translated');
  return stored?.srt;
}
