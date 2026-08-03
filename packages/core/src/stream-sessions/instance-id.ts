import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataFolder } from '../utils/general.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('streams');

const FILE = 'instance-id';

let cached: string | undefined;

/**
 * Stable identity for this replica, persisted beside the database. Sessions
 * record which instance owns their live reader, so a boot can reclaim its own
 * leftovers and a stop can be routed to the replica holding the stream; a
 * per-process id would match nothing after a restart.
 *
 * Falls back to a random id if the file is unusable. Replicas sharing one data
 * volume share an id, and rely on the staleness backstop instead.
 */
export function instanceId(): string {
  if (cached) return cached;
  try {
    const file = path.join(getDataFolder(), FILE);
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return (cached = existing);
  } catch {
    /* first run, or an unreadable data folder */
  }
  const generated = randomUUID();
  try {
    const folder = getDataFolder();
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, FILE), generated, 'utf8');
  } catch (err) {
    logger.warn(
      { err },
      'could not persist the instance id; stream sessions from a previous run will be reclaimed by age instead'
    );
  }
  return (cached = generated);
}
