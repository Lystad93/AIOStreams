import { Router, Request, Response } from 'express';
import {
  createLogger,
  decryptString,
  validateConfig,
  UserRepository,
  decodeSubtitleToken,
  decodeExternalToken,
  getProviderClient,
  downloadExternalSubtitle,
  resolveExternalConfig,
  resolveTrackPreferences,
  externalJobHash,
  resolveSubtitleConfig,
  lookupServedRelease,
  releaseHash,
  startExactJob,
  getFinishedResult,
  estimateEtaSeconds,
  serializeSrt,
  type SubtitleJob,
  type SubtitleJobKey,
  type SubtitleTokenPayload,
} from '@aiostreams/core';

/**
 * Subtitle job endpoints (spec §5). Stremio/Nuvio fetch a slot's `url` directly
 * with no auth context, so identity + the owner's encrypted password travel
 * inside the encrypted token minted by the slot builder. Two actions:
 *
 *  - `exact`  → start (or re-start after failure) the extract+translate job and
 *               return an immediate placeholder subtitle. Never blocks on the
 *               job (spec §5).
 *  - `result` → return the finished translated SRT once done, otherwise a
 *               "not ready" placeholder.
 *
 * Everything the response says is delivered AS a subtitle file, because that's
 * the only channel the subtitle protocol gives us (spec §3.3).
 */
const logger = createLogger('server');
const router: Router = Router();

/** Build a one-cue SRT carrying a status message to the player. */
function messageSrt(text: string, seconds = 20): string {
  return serializeSrt([{ index: 1, startMs: 0, endMs: seconds * 1000, text }]);
}

function sendSrt(res: Response, srt: string): void {
  res
    .status(200)
    .set('content-type', 'text/plain; charset=utf-8')
    .set('cache-control', 'no-store')
    .send(srt);
}

async function loadOwnerConfig(payload: SubtitleTokenPayload) {
  const { success, data: password } = decryptString(payload.encryptedPassword);
  if (!success || !password) return null;
  let userData = await UserRepository.getUser(payload.uuid, password);
  if (!userData) return null;
  userData.uuid = payload.uuid;
  userData.encryptedPassword = payload.encryptedPassword;
  try {
    userData = await validateConfig(userData, {
      skipErrorsFromAddonsOrProxies: true,
      decryptValues: true,
    });
  } catch (error) {
    logger.warn(
      `subtitle job: invalid config for ${payload.uuid}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
  return userData;
}

/**
 * Serve an externally-sourced subtitle (spec §4.5). Registered before the
 * generic action route because it carries its own token shape and needs no user
 * config — the token holds the provider reference and the episode to pick out
 * of a season pack.
 */
router.get(
  '/external/:token',
  async (req: Request<{ token: string }>, res: Response) => {
    const token = decodeURIComponent(req.params.token).replace(/\.srt$/i, '');
    const payload = decodeExternalToken(token);
    if (!payload) {
      sendSrt(res, messageSrt('AIOStreams: invalid or expired subtitle link.'));
      return;
    }
    try {
      const client = getProviderClient(
        payload.provider as Parameters<typeof getProviderClient>[0]
      );
      if (!client) {
        sendSrt(res, messageSrt('AIOStreams: unknown subtitle provider.'));
        return;
      }
      const srt = await downloadExternalSubtitle({
        provider: client.id,
        ref: payload.ref,
        lang: payload.lang,
        season: payload.season,
        episode: payload.episode,
        releaseKey: payload.releaseKey,
        creds: payload.creds,
      });
      sendSrt(res, srt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`external subtitle fetch failed: ${message}`);
      sendSrt(
        res,
        messageSrt(`AIOStreams: could not fetch subtitle — ${message}`)
      );
    }
  }
);

router.get(
  '/:action/:token',
  async (req: Request<{ action: string; token: string }>, res: Response) => {
    const { action } = req.params;
    // The slot URL ends in `.srt`; the extension is captured with the token.
    const token = decodeURIComponent(req.params.token).replace(/\.srt$/i, '');

    const payload = decodeSubtitleToken(token);
    if (!payload) {
      sendSrt(res, messageSrt('AIOStreams: invalid or expired subtitle link.'));
      return;
    }

    try {
      const jobKey: SubtitleJobKey = {
        uuid: payload.uuid,
        contentId: payload.contentId,
        releaseHash: releaseHash({
          size: payload.videoSize,
          filename: payload.filename,
        }),
        sourcePath: payload.sourcePath,
        targetLang: payload.targetLang,
      };

      if (action === 'result') {
        // Pass the filename so a translation produced from another addon's
        // copy of the same release still resolves.
        const srt = await getFinishedResult(jobKey, payload.filename);
        if (srt) {
          sendSrt(res, srt);
          return;
        }
        sendSrt(
          res,
          messageSrt(
            'AIOStreams: translation not ready yet. Re-open the subtitle menu shortly.'
          )
        );
        return;
      }

      if (action !== 'exact') {
        sendSrt(res, messageSrt('AIOStreams: unknown subtitle action.'));
        return;
      }
      // (external is handled by its own route below — it carries a different
      // token shape and needs no user config.)

      // --- exact: start the job, return a placeholder ------------------------
      const userData = await loadOwnerConfig(payload);
      if (!userData) {
        sendSrt(
          res,
          messageSrt('AIOStreams: could not load your configuration.')
        );
        return;
      }
      const cfg = resolveSubtitleConfig(userData);
      if (!cfg) {
        sendSrt(
          res,
          messageSrt(
            'AIOStreams: subtitle translation is not fully configured (API key / target language).'
          )
        );
        return;
      }

      // Translating an externally-sourced subtitle needs no video at all, so
      // it skips the playback lookup and the extraction entirely.
      if (payload.sourcePath === 'external' && payload.external) {
        const now = Date.now();
        const key: SubtitleJobKey = {
          uuid: payload.uuid,
          contentId: payload.contentId,
          releaseHash: externalJobHash(
            payload.external.provider,
            payload.external.ref
          ),
          sourcePath: 'external',
          targetLang: payload.targetLang,
        };
        const { started } = await startExactJob({
          job: {
            ...key,
            status: 'pending',
            // No file transit — the job is just the translation.
            etaSeconds: estimateEtaSeconds({ reuseSource: true }),
            createdAt: now,
            updatedAt: now,
            filename: payload.filename,
            provider: cfg.provider,
            model: cfg.model,
          },
          externalSource: {
            provider: payload.external.provider as Parameters<
              typeof getProviderClient
            >[0],
            ref: payload.external.ref,
            lang: payload.external.lang,
            season: payload.external.season,
            episode: payload.external.episode,
            releaseKey: payload.filename,
            creds: resolveExternalConfig(userData)?.creds,
          },
          sourceLanguages: cfg.sourceLanguages,
          targetLanguage: cfg.targetLanguage,
          apiKey: cfg.apiKey,
          providerId: cfg.provider,
          model: cfg.model,
          providerChain: cfg.providers,
          filename: payload.filename,
          now,
        });
        sendSrt(
          res,
          messageSrt(
            started
              ? `AIOStreams: translating the matched ${payload.external.lang} subtitle into ${payload.targetLang}. Re-open the subtitle menu shortly.`
              : 'AIOStreams: translation already in progress. Re-open the subtitle menu shortly.',
            30
          )
        );
        return;
      }

      const served = await lookupServedRelease(
        payload.uuid,
        payload.contentId,
        {
          videoSize: payload.videoSize,
          filename: payload.filename,
        }
      );
      if (!served) {
        sendSrt(
          res,
          messageSrt(
            'AIOStreams: could not identify the playing release to extract from. Try again from the stream list.'
          )
        );
        return;
      }

      const now = Date.now();
      const etaSeconds = estimateEtaSeconds({ fileSizeBytes: served.size });
      const job: SubtitleJob = {
        ...jobKey,
        status: 'pending',
        etaSeconds,
        createdAt: now,
        updatedAt: now,
        filename: served.filename,
        videoSize: served.size,
        provider: cfg.provider,
        model: cfg.model,
      };

      const { started } = await startExactJob({
        job,
        playbackUrl: served.url,
        sourceLanguages: cfg.sourceLanguages,
        allowTracks: resolveTrackPreferences(userData),
        targetLanguage: cfg.targetLanguage,
        apiKey: cfg.apiKey,
        providerId: cfg.provider,
        model: cfg.model,
        providerChain: cfg.providers,
        filename: served.filename,
        videoSize: served.size,
        durationMs: served.durationMs,
        now,
      });

      const mins = Math.max(1, Math.round(etaSeconds / 60));
      sendSrt(
        res,
        messageSrt(
          started
            ? `AIOStreams: translation started (~${mins} min). Re-open the subtitle menu when ready and pick "Translated Exact".`
            : `AIOStreams: translation already in progress. Re-open the subtitle menu shortly.`,
          30
        )
      );
    } catch (error) {
      logger.error(
        `subtitle job error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      sendSrt(res, messageSrt('AIOStreams: subtitle job failed to start.'));
    }
  }
);

export default router;
