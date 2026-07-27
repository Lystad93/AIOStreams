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
import { settingsStore } from '../config/index.js';

const VIDEO_EXTENSIONS =
  /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts|ogm|divx|vob)$/i;

/**
 * The same extensions once separators have been flattened to spaces.
 *
 * Players don't always hand back a filename with its dot intact — Stremio's
 * `filename` extra frequently arrives fully space-separated
 * (`…TrueHD 5 1-CiNEPHiLES mkv`), so the dotted strip above never fires and
 * `mkv` survives as a token, dropping an otherwise identical release out of the
 * exact-match tier.
 *
 * `ts` is deliberately absent: a trailing `TS` is telesync (a source tag), not
 * a container, and stripping it would merge two genuinely different releases.
 */
const TRAILING_EXTENSION =
  /\s(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ogm|divx|vob)$/i;

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
  // Normalisation must work before runtime settings are up (e.g. in unit tests,
  // or any pre-initialiseConfig code path) — reading the section then would trip
  // the settings store's uninitialised-access guard. The operator-configured
  // tags are additive, so falling back to the built-ins is correct, not a
  // silently-swallowed error.
  if (!settingsStore.initialised) return DEFAULT_REUPLOAD_TAGS;
  const configured = appConfig.subtitles.reuploadTags;
  const extra = Array.isArray(configured)
    ? configured.map((t) => t.trim().toLowerCase()).filter(Boolean)
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
  // Second pass, for names whose extension arrived separator-joined rather than
  // dotted — the dotted strip above cannot see those.
  name = name.replace(TRAILING_EXTENSION, '');

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
