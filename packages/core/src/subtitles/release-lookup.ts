/**
 * Maps the identity fields Stremio/Nuvio echo on a subtitle request
 * (`videoSize` + `filename`, spec §3.3) back to the owned, Range-capable
 * playback URL of the exact release the user is watching — so the extractor
 * (§4.2) can point ffmpeg at that same stream.
 *
 * Populated (non-blocking) when streams are served; read when subtitles are
 * requested. Only OUR own playback URLs are recorded — an arbitrary upstream
 * debrid URL isn't guaranteed Range-demuxable and isn't ours to point ffmpeg
 * at. A miss (e.g. after a restart, or a release we don't own) simply means the
 * exact-extract slot isn't offered for that file; nothing speculative is done.
 */
import { Cache, appConfig } from '../utils/index.js';
import { getSimpleTextHash } from '../utils/crypto.js';
import { PLAYBACK_PATH_PREFIX } from '../debrid/utils.js';
import { createLogger } from '../logging/logger.js';
import { normaliseReleaseName } from './release-name.js';

const logger = createLogger('subtitles');

/** Matches the playback link validity; a playback session is short-lived. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Persist the release map so a "Translate Exact" slot survives a container
 * restart and doesn't depend on the stream list being re-opened in the same
 * session (Redis when configured, otherwise the shared SQL cache).
 */
const RELEASE_STORE: 'redis' | 'sql' = appConfig.bootstrap.redisUri
  ? 'redis'
  : 'sql';

export interface ServedRelease {
  url: string;
  size?: number;
  filename?: string;
  /** Runtime reported for this release, in ms (0/undefined = unknown). */
  durationMs?: number;
}

interface StreamLike {
  url?: string;
  size?: number;
  filename?: string;
  duration?: number;
}

/**
 * Runtimes of every release offered for a title, keyed by canonical release
 * name. Two releases with the same runtime carry the same subtitle timing even
 * when their names differ (an added `HDR` token, or a 60fps AI-interpolated
 * remux), so this is what lets a subtitle found for one release be offered for
 * another (spec §4.5/§8).
 */
export type ReleaseDurationIndex = Record<string, number>;

const cache = () =>
  Cache.getInstance<string, ServedRelease>(
    'subtitle-release-map',
    undefined,
    RELEASE_STORE
  );

const durationCache = () =>
  Cache.getInstance<string, ReleaseDurationIndex>(
    'subtitle-release-durations',
    undefined,
    RELEASE_STORE
  );

function durationKey(uuid: string, contentId: string): string {
  return getSimpleTextHash([uuid, contentId].map(encodeURIComponent).join('|'));
}

/** Runtimes of every release we've seen offered for this title. */
export async function getReleaseDurations(
  uuid: string,
  contentId: string
): Promise<ReleaseDurationIndex> {
  return (await durationCache().get(durationKey(uuid, contentId))) ?? {};
}

function key(
  uuid: string,
  contentId: string,
  parts: { size?: number; filename?: string }
): string {
  return getSimpleTextHash(
    [
      uuid,
      contentId,
      parts.size != null ? String(parts.size) : '',
      parts.filename ?? '',
    ]
      .map(encodeURIComponent)
      .join('|')
  );
}

/**
 * Stable identity hash for the exact release, used as the job key's
 * `releaseHash` (spec §5). Derived from size+filename — the same fields the
 * player round-trips — so the subtitle-time lookup and the job key agree.
 */
export function releaseHash(parts: {
  size?: number;
  filename?: string;
}): string {
  return getSimpleTextHash(
    `${parts.size != null ? parts.size : ''}|${parts.filename ?? ''}`
  );
}

/** Record served streams so a later subtitle request can find their play URL. */
export async function recordServedReleases(
  uuid: string,
  contentId: string,
  streams: StreamLike[]
): Promise<void> {
  let recorded = 0;
  await Promise.all(
    streams.map(async (s) => {
      if (!s.url || !s.url.includes(PLAYBACK_PATH_PREFIX)) return;
      if (s.size == null && !s.filename) return;
      recorded++;
      const entry: ServedRelease = {
        url: s.url,
        size: s.size,
        filename: s.filename,
        durationMs: s.duration && s.duration > 0 ? s.duration : undefined,
      };
      // Store under several keys so the lookup can degrade from most to least
      // specific depending on which fields the player actually sends back.
      const keys = new Set<string>();
      keys.add(key(uuid, contentId, { size: s.size, filename: s.filename }));
      if (s.filename) keys.add(key(uuid, contentId, { filename: s.filename }));
      if (s.size != null) keys.add(key(uuid, contentId, { size: s.size }));
      await Promise.all(
        [...keys].map((k) => cache().set(k, entry, TTL_SECONDS))
      );
    })
  );
  // Index every release's runtime, not just the ones we own the playback for:
  // a subtitle found for ANY release in the list can be reused for the one
  // being played when their runtimes agree.
  const durations: ReleaseDurationIndex = {
    ...(await getReleaseDurations(uuid, contentId)),
  };
  let withDuration = 0;
  for (const s of streams) {
    if (!s.filename || !s.duration || s.duration <= 0) continue;
    const k = normaliseReleaseName(s.filename);
    if (!k) continue;
    durations[k] = s.duration;
    withDuration++;
  }
  if (withDuration > 0) {
    await durationCache().set(
      durationKey(uuid, contentId),
      durations,
      TTL_SECONDS
    );
  }

  logger.debug(
    { contentId, total: streams.length, recorded, withDuration },
    'recorded served releases for subtitles'
  );
}

/** Look up the play URL for the release identified by the subtitle request. */
export async function lookupServedRelease(
  uuid: string,
  contentId: string,
  identity: { videoSize?: number; filename?: string }
): Promise<ServedRelease | undefined> {
  const attempts: { size?: number; filename?: string }[] = [];
  if (identity.videoSize != null && identity.filename)
    attempts.push({ size: identity.videoSize, filename: identity.filename });
  if (identity.filename) attempts.push({ filename: identity.filename });
  if (identity.videoSize != null) attempts.push({ size: identity.videoSize });

  for (const parts of attempts) {
    const hit = await cache().get(key(uuid, contentId, parts));
    if (hit) return hit;
  }
  return undefined;
}
