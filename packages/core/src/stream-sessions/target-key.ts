import { createHash } from 'node:crypto';

/**
 * Stable identity for what a session is streaming. It groups the many Range
 * reads of one playback into a single session and is the subject a per-stream
 * block is written against, so it must not vary between a player's requests.
 *
 * Transport-prefixed so a usenet and a proxy target can never collide.
 */
export function usenetTargetKey(
  hash: string,
  fileIndex?: number,
  innerPath?: string
): string {
  return `usenet:${hash}:${fileIndex ?? 'auto'}:${innerPath ?? ''}`;
}

/**
 * Proxy targets are keyed by a hash of the upstream URL: the raw URL can carry
 * credentials and is never persisted, and a hash keeps the key short enough to
 * index.
 */
export function proxyTargetKey(url: string): string {
  return `proxy:${createHash('sha1').update(url).digest('hex')}`;
}
