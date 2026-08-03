import { randomUUID } from 'node:crypto';
import {
  StreamSessionRepository,
  type StreamBan,
  type StreamBanScope,
} from '../db/repositories/stream-sessions.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('streams');

/**
 * In-memory mirror of the ban list, refreshed by the flush task. Admission has
 * to be synchronous (check and reserve must not interleave with another open),
 * so it cannot await a query.
 */
let cache: StreamBan[] = [];

/** Replace the cached ban list from the DB. */
export async function refreshStreamBans(): Promise<void> {
  try {
    cache = await StreamSessionRepository.listBans();
  } catch (err) {
    logger.warn(
      { err },
      'failed to refresh stream bans; keeping last snapshot'
    );
  }
}

function isLive(ban: StreamBan, now: number): boolean {
  return ban.expiresAt === undefined || ban.expiresAt > now;
}

/**
 * The ban covering this user (and optionally this target), or undefined. A
 * `user` ban outranks a `target` ban since it blocks strictly more.
 */
export function findStreamBan(
  username: string,
  targetKey?: string,
  now = Date.now()
): StreamBan | undefined {
  if (!username) return undefined;
  let target: StreamBan | undefined;
  for (const ban of cache) {
    if (ban.username !== username || !isLive(ban, now)) continue;
    if (ban.scope === 'user') return ban;
    if (targetKey && ban.targetKey === targetKey) target = ban;
  }
  return target;
}

export interface CreateStreamBanInput {
  scope: StreamBanScope;
  username: string;
  /** Required for `scope: 'target'`. */
  targetKey?: string;
  reason?: string;
  createdBy?: string;
  /** Duration from now; omit for a ban that holds until lifted. */
  durationMs?: number;
}

export async function createStreamBan(
  input: CreateStreamBanInput
): Promise<StreamBan> {
  if (input.scope === 'target' && !input.targetKey) {
    throw new Error('a target ban needs a targetKey');
  }
  if (!input.username) {
    throw new Error('cannot ban an unidentified user');
  }
  const now = Date.now();
  const ban: StreamBan = {
    id: randomUUID(),
    scope: input.scope,
    username: input.username,
    targetKey: input.scope === 'target' ? input.targetKey : undefined,
    reason: input.reason,
    createdAt: now,
    createdBy: input.createdBy,
    expiresAt: input.durationMs ? now + input.durationMs : undefined,
  };
  await StreamSessionRepository.addBan(ban);
  cache = [ban, ...cache];
  logger.info(
    {
      scope: ban.scope,
      username: ban.username,
      targetKey: ban.targetKey,
      expiresAt: ban.expiresAt,
    },
    'stream ban created'
  );
  return ban;
}

export async function liftStreamBan(id: string): Promise<boolean> {
  const removed = await StreamSessionRepository.removeBan(id);
  if (removed) {
    cache = cache.filter((b) => b.id !== id);
    logger.info({ id }, 'stream ban lifted');
  }
  return removed;
}

/** Currently-effective bans, newest first. */
export function listStreamBans(now = Date.now()): StreamBan[] {
  return cache.filter((b) => isLive(b, now));
}

export type { StreamBan, StreamBanScope };
