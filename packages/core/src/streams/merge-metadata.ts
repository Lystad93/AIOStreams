/**
 * Choosing where merged metadata comes from.
 *
 * Split out of the deduplicator because the decisions here are pure and worth
 * testing on their own: which addon a missing field is taken from, and whether
 * a reported runtime is trustworthy enough to adopt.
 */
import { createLogger } from '../logging/logger.js';
import type { ParsedStream } from '../db/schemas.js';

const logger = createLogger('deduplicator');

/** Names an addon can be referred to by in the trusted-sources list. */
function addonIdentities(stream: ParsedStream): string[] {
  return [
    stream.addon?.name,
    stream.addon?.preset?.type,
    stream.addon?.preset?.id,
    stream.addon?.instanceId,
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.toLowerCase());
}

/**
 * Position in the trusted list, or one past the end when unlisted.
 *
 * Unlisted is a ranking, not an exclusion: merging exists to enrich addons that
 * report less, so a source nobody vouched for is still better than no value.
 */
export function trustRank(stream: ParsedStream, trusted: string[]): number {
  const identities = addonIdentities(stream);
  for (let i = 0; i < trusted.length; i++) {
    const want = trusted[i].trim().toLowerCase();
    if (want && identities.includes(want)) return i;
  }
  return trusted.length;
}

/** Trusted addons first, in configured order; everything else keeps its order. */
export function orderByTrust(
  streams: ParsedStream[],
  trusted?: string[]
): ParsedStream[] {
  if (!trusted || trusted.length === 0) return streams;
  return streams
    .map((stream, index) => ({ stream, index }))
    .sort(
      (a, b) =>
        trustRank(a.stream, trusted) - trustRank(b.stream, trusted) ||
        a.index - b.index
    )
    .map((entry) => entry.stream);
}

/**
 * The runtime to adopt for a release that didn't report one, or `undefined`.
 *
 * Only ever a duration an addon reported for its own file. A value exactly
 * equal to the title's TMDB runtime is refused: an addon echoing the catalogue
 * figure is indistinguishable from one that measured the file, and a catalogue
 * runtime says nothing about a particular release — which is exactly what a
 * merged duration is for (spec §8).
 */
export function pickMergedDuration(
  sources: ParsedStream[],
  titleRuntimeMs?: number
): number | undefined {
  for (const source of sources) {
    const duration = source.duration;
    if (!duration || duration <= 0) continue;
    if (titleRuntimeMs && duration === titleRuntimeMs) {
      logger.debug(
        { addon: source.addon?.name, duration },
        'ignoring merged duration identical to the TMDB runtime'
      );
      continue;
    }
    return duration;
  }
  return undefined;
}
