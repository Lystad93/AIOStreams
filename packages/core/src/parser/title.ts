import { parseTorrentTitle, ParsedResult } from '@viren070/parse-torrent-title';

// Sized to cover the working set of a busy request without retaining much:
// entries are small objects and the hit rate comes from repetition, not volume.
const MAX_ENTRIES = 10_000;

const cache = new Map<string, ParsedResult>();

/**
 * Memoised {@link parseTorrentTitle}.
 *
 * The same names are parsed repeatedly: builtins parse every file inside every
 * torrent and then the wrapper re-parses the names it kept, via a different
 * entry point into the same handlers. Release names also recur across requests.
 *
 * Returned objects are SHARED between callers and must be treated as read-only,
 * including their arrays (`seasons`, `episodes`, `volumes`, `editions`).
 */
export function parseTorrentTitleCached(title: string): ParsedResult {
  const cached = cache.get(title);
  if (cached !== undefined) {
    // Re-insert to refresh recency; Map iterates in insertion order.
    cache.delete(title);
    cache.set(title, cached);
    return cached;
  }

  const parsed = parseTorrentTitle(title);

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(title, parsed);
  return parsed;
}

/** Entry count, for cache reporting. */
export function parsedTitleCacheSize(): number {
  return cache.size;
}
