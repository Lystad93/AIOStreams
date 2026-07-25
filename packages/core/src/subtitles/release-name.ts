/**
 * Canonical release key for matching the *same* release across addons.
 *
 * Addons report the same file in inconsistent ways:
 *   From.S01E08.2160p.STAN.WEB-DL.H.265-Kitsune.mkv   (dotted, with extension)
 *   From.S01E08.2160p.STAN.WEB-DL.H.265-Kitsune       (no extension)
 *   From S01E08 2160p STAN WEB-DL H 265-Kitsune       (spaces)
 *   From%20S01E08%202160p%20STAN%20WEB-DL...          (percent-encoded)
 *   From.S01E08...H.265-Kitsune-WtF                   (re-upload tag appended)
 *
 * All of those are one release and must share one key, or a stored subtitle
 * won't be found for the copy the user actually plays.
 */
import { appConfig } from '../utils/index.js';

const VIDEO_EXTENSIONS =
  /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts|ogm|divx|vob)$/i;

/**
 * Suffixes some sites append when re-hosting an existing release
 * (`…-Kitsune-WtF`). These are matched as an explicit list on purpose.
 *
 * A structural rule ("drop the last dash-separated token") is NOT safe here:
 * `Show.1080p.WEB-DL-Kitsune` and `Show.1080p.WEB-DL-XEBEC` would both collapse
 * to `show 1080p web-dl`, silently merging two genuinely different releases
 * whose subtitles may not share timing. An explicit list can't do that.
 */
const DEFAULT_REUPLOAD_TAGS = ['wtf'];

function reuploadTags(): string[] {
  const configured = appConfig.bootstrap.subtitleReuploadTags;
  const extra =
    typeof configured === 'string' && configured.trim()
      ? configured
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : [];
  return [...new Set([...DEFAULT_REUPLOAD_TAGS, ...extra])];
}

/** Percent-decode, tolerating malformed input and double-encoding. */
function safeDecode(value: string): string {
  let out = value;
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-f]{2}/i.test(out)) break;
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Reduce a filename to a canonical key. Returns an empty string for input that
 * normalises away to nothing (callers should treat that as "no key").
 */
export function normaliseReleaseName(filename: string | undefined): string {
  if (!filename) return '';

  let name = safeDecode(filename.trim());
  // Strip the extension before separators are rewritten, so ".mkv" doesn't
  // survive as a " mkv" token.
  name = name.replace(VIDEO_EXTENSIONS, '');
  name = name.toLowerCase();
  // Dots, underscores, plus signs and runs of whitespace are all just
  // separators — the same release uses different ones across addons.
  name = name.replace(/[._+\s]+/g, ' ').trim();

  // Drop re-upload tags, repeatedly (a file may carry more than one).
  const tags = reuploadTags();
  let changed = true;
  while (changed && name) {
    changed = false;
    for (const tag of tags) {
      const suffix = `-${tag}`;
      if (name.endsWith(suffix) && name.length > suffix.length) {
        name = name.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
  }

  return name;
}
