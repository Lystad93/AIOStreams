import { Router } from 'express';
import {
  APIError,
  ConfigProfileRepository,
  constants,
  createLogger,
  decryptString,
  encryptString,
  isConfigUuid,
  MAX_PROFILES_PER_OWNER,
  normaliseAlias,
  resolveConfigAlias,
  UserRepository,
  validateAlias,
  config as appConfig,
} from '@aiostreams/core';
import { z } from 'zod';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { attachSession, requireSession } from '../../middlewares/auth.js';
import { createResponse } from '../../utils/responses.js';

const router: Router = Router();
const logger = createLogger('server');

router.use(userApiRateLimiter);
router.use(attachSession);
router.use(requireSession);

function notFound(): APIError {
  return new APIError(
    constants.ErrorCode.USER_INVALID_DETAILS,
    404,
    'Saved configuration not found'
  );
}

function conflict(message: string): APIError {
  return new APIError(constants.ErrorCode.USER_ALREADY_EXISTS, 409, message);
}

/** Settings win at resolve time, so claiming one here would do nothing. */
function aliasCollidesWithSettings(alias: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    appConfig.api.aliasedConfigurations,
    alias
  );
}

async function assertAliasFree(alias: string, exceptId: string): Promise<void> {
  const reason = validateAlias(alias);
  if (reason) {
    throw new APIError(constants.ErrorCode.BAD_REQUEST, undefined, reason);
  }
  if (aliasCollidesWithSettings(alias)) {
    throw conflict(`"${alias}" is already used by an instance-wide alias`);
  }
  if (await ConfigProfileRepository.aliasTaken(alias, exceptId)) {
    throw conflict(`"${alias}" is already taken`);
  }
}

const saveBody = z.object({
  uuid: z.string().min(1),
  password: z.string().min(1),
  label: z.string().trim().min(1).max(64).optional(),
});

const updateBody = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  alias: z.string().nullable().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const profiles = await ConfigProfileRepository.list(req.user!.username);
    res.status(200).json(
      createResponse({
        success: true,
        data: { profiles, limit: MAX_PROFILES_PER_OWNER },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// also refreshes one already saved, so this doubles as the re-link path
router.post('/', async (req, res, next) => {
  const parsed = saveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(
        constants.ErrorCode.MISSING_REQUIRED_FIELDS,
        undefined,
        'uuid and password are required'
      )
    );
    return;
  }
  const owner = req.user!.username;
  const { password } = parsed.data;

  try {
    let uuid = parsed.data.uuid.trim();
    if (!isConfigUuid(uuid)) {
      const target = await resolveConfigAlias(uuid);
      if (!target) {
        throw new APIError(constants.ErrorCode.USER_INVALID_DETAILS);
      }
      uuid = target.uuid;
    }

    // The password check is the consent gate: you can only save a
    // configuration you can already open.
    await UserRepository.verifyUser(uuid, password);

    const existing = await ConfigProfileRepository.list(owner);
    const alreadySaved = existing.some((p) => p.uuid === uuid);
    if (!alreadySaved && existing.length >= MAX_PROFILES_PER_OWNER) {
      throw new APIError(
        constants.ErrorCode.FORBIDDEN,
        undefined,
        `You can save at most ${MAX_PROFILES_PER_OWNER} configurations`
      );
    }

    const label = parsed.data.label ?? uuid.slice(0, 8);
    const clash = existing.find((p) => p.label === label && p.uuid !== uuid);
    if (clash) {
      throw conflict(`You already have a saved configuration named "${label}"`);
    }

    const { success, data: encryptedPassword } = encryptString(password);
    if (!success) {
      throw new APIError(constants.ErrorCode.ENCRYPTION_ERROR);
    }

    const profile = await ConfigProfileRepository.save(owner, {
      uuid,
      encryptedPassword,
      label,
    });
    logger.info({ owner, uuid }, 'saved a configuration to a session identity');
    res.status(201).json(
      createResponse({
        success: true,
        detail: 'Configuration saved',
        data: { profile },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

router.patch('/:id', async (req, res, next) => {
  const parsed = updateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    next(
      new APIError(constants.ErrorCode.BAD_REQUEST, undefined, 'Invalid body')
    );
    return;
  }
  const owner = req.user!.username;
  const { id } = req.params;

  try {
    const current = await ConfigProfileRepository.get(owner, id);
    if (!current) {
      throw notFound();
    }

    const fields: { label?: string; alias?: string | null } = {};
    if (parsed.data.label !== undefined) {
      if (
        await ConfigProfileRepository.labelTaken(owner, parsed.data.label, id)
      ) {
        throw conflict(
          `You already have a saved configuration named "${parsed.data.label}"`
        );
      }
      fields.label = parsed.data.label;
    }
    // undefined leaves the alias alone; null and '' clear it.
    const requestedAlias = parsed.data.alias;
    if (requestedAlias !== undefined) {
      if (requestedAlias === null || requestedAlias.trim() === '') {
        fields.alias = null;
      } else {
        const alias = normaliseAlias(requestedAlias);
        await assertAliasFree(alias, id);
        fields.alias = alias;
      }
    }

    const profile = await ConfigProfileRepository.update(owner, id, fields);
    if (!profile) {
      throw notFound();
    }
    res.status(200).json(
      createResponse({
        success: true,
        detail: 'Saved configuration updated',
        data: { profile },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// unlink; the configuration itself is left alone
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await ConfigProfileRepository.remove(
      req.user!.username,
      req.params.id
    );
    if (!removed) {
      throw notFound();
    }
    res.status(200).json(
      createResponse({
        success: true,
        detail: 'Saved configuration removed',
        data: { deleted: true },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

// returns credentials, not the configuration: the SPA loads it via /user
router.post('/:id/open', async (req, res, next) => {
  const owner = req.user!.username;
  const { id } = req.params;

  try {
    const secret = await ConfigProfileRepository.openSecret(owner, id);
    if (!secret) {
      throw notFound();
    }

    const { success, data: password } = decryptString(secret.encryptedPassword);
    if (!success) {
      await ConfigProfileRepository.markBroken(owner, id);
      throw new APIError(
        constants.ErrorCode.ENCRYPTION_ERROR,
        undefined,
        'This saved configuration can no longer be opened. Save it again with its password.'
      );
    }

    // decryptString only proves the blob was made with this instance's key, so
    // this is the check that the password still opens the configuration.
    try {
      await UserRepository.verifyUser(secret.uuid, password);
    } catch {
      await ConfigProfileRepository.markBroken(owner, id);
      throw new APIError(
        constants.ErrorCode.USER_INVALID_DETAILS,
        undefined,
        'The password for this saved configuration has changed. Save it again with the new password.'
      );
    }

    await ConfigProfileRepository.markOpened(owner, id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(
      createResponse({
        success: true,
        data: {
          uuid: secret.uuid,
          password,
          encryptedPassword: secret.encryptedPassword,
        },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

export default router;
