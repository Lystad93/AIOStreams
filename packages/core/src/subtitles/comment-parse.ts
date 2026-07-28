/**
 * Mining an OpenSubtitles uploader comment for matching evidence.
 *
 * OpenSubtitles entries frequently carry no scene release name at all, which
 * drops them straight to the `UNRELATED` floor even when the uploader wrote
 * exactly what we need — the runtime, and the list of releases the file syncs
 * with — in free text underneath.
 *
 * The parsing is deliberately conservative. A comment is prose written by a
 * stranger in an arbitrary language, so only high-confidence shapes are taken
 * and everything else is treated as absent. That asymmetry is the whole point:
 * a wrong runtime is worse than no runtime, because it turns an honest `(?)`
 * into a confident `(X 1h53m28s)` that sends the user to the wrong subtitle.
 */

/** `1:53:28`, `01:53:28`, and the `1:53:28.500` / `,500` variants. */
const HMS = /(?<![\d:])(\d{1,2}):([0-5]\d):([0-5]\d)(?:[.,]\d{1,3})?(?![\d:])/;
/** `1h53m28s`, `1h 53m`, `1 h 53 min`. */
const H_M =
  /(?<![\d.,])(\d{1,2})\s*h(?:ours?|rs?)?\s*(\d{1,2})\s*m(?:in(?:utes?)?)?(?:\s*(\d{1,2})\s*s(?:ec(?:onds?)?)?)?/i;
/** `113 min`, `113 minutes`, `113min`. Bounded to plausible runtimes. */
const MINUTES = /(?<![\d.,])(\d{2,3})\s*m(?:in(?:ute)?s?)\b/i;

/**
 * A token that looks like a scene release name: dotted, with at least one
 * recognisable release marker. Requiring a marker is what keeps ordinary
 * sentences containing dots out of the result.
 */
const RELEASE_TOKEN = /\b[\w[\]()'!&+-]+(?:\.[\w[\]()'!&+-]+){2,}\b/g;
const RELEASE_MARKERS =
  /\b(?:web-?dl|web-?rip|webrip|bluray|blu-ray|bdrip|brrip|hdtv|dvdrip|remux|hdrip|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|2160p|1080p|720p|480p|amzn|nf|dsnp|hmax|atvp|pcok|hulu|stan|itunes|ddp|dts|aac|atmos|truehd)\b/i;

/** Plausible feature/episode runtime bounds, in milliseconds. */
const MIN_RUNTIME_MS = 5 * 60_000;
const MAX_RUNTIME_MS = 6 * 60 * 60_000;

export interface ParsedComment {
  /** Runtime the uploader stated, when one could be read confidently. */
  durationMs?: number;
  /** Release names the uploader claims the subtitle syncs with. */
  releaseNames: string[];
}

function plausible(ms: number): number | undefined {
  return ms >= MIN_RUNTIME_MS && ms <= MAX_RUNTIME_MS ? ms : undefined;
}

/**
 * Read a runtime out of free text.
 *
 * Ordered most-specific first: `1:53:28` is unambiguous, `113 min` is not (it
 * could be a bitrate, a file size, or a sentence about something else), so the
 * bare-minutes form is only consulted when nothing better is present.
 */
export function parseCommentDuration(comment: string): number | undefined {
  const hms = comment.match(HMS);
  if (hms) {
    const ms =
      (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) * 1000;
    const ok = plausible(ms);
    if (ok) return ok;
  }

  const hm = comment.match(H_M);
  if (hm) {
    const ms =
      (Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3] ?? 0)) * 1000;
    const ok = plausible(ms);
    if (ok) return ok;
  }

  const mins = comment.match(MINUTES);
  if (mins) {
    const ok = plausible(Number(mins[1]) * 60_000);
    if (ok) return ok;
  }
  return undefined;
}

/**
 * Release names the comment mentions.
 *
 * Every candidate must carry a recognisable release marker (a source, codec or
 * resolution token). Without that rule a sentence like `see readme.txt.for.info`
 * would be read as a release, and a junk name is worse than none — it feeds
 * the relation classifier a comparison that never should have happened.
 */
export function parseCommentReleases(comment: string): string[] {
  const out: string[] = [];
  for (const match of comment.matchAll(RELEASE_TOKEN)) {
    const token = match[0].replace(/[.,;:]+$/, '');
    if (token.length < 12 || !RELEASE_MARKERS.test(token)) continue;
    out.push(token);
  }
  // Preserve first-seen order; uploaders list the primary release first.
  return [...new Set(out)].slice(0, 10);
}

export function parseUploaderComment(comment?: string): ParsedComment {
  if (!comment?.trim()) return { releaseNames: [] };
  return {
    durationMs: parseCommentDuration(comment),
    releaseNames: parseCommentReleases(comment),
  };
}
