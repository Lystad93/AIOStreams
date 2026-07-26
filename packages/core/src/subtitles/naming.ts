/**
 * Subtitle filenames following the convention OpenSubtitles publishes and that
 * Plex, Jellyfin, Emby and Bazarr all read:
 *
 *   <video file name without extension>.<language code>[.flags].srt
 *   Backrooms.2026.2160p.WEB-DL-BYNDR.nor.srt
 *   Backrooms.2026.2160p.WEB-DL-BYNDR.eng.sdh.srt
 *
 * Naming a download this way means it can be dropped straight next to the video
 * file and picked up automatically, instead of needing to be renamed by hand.
 */
import { languageToCode } from '../utils/languages.js';

/** Characters that are unsafe in a filename or in a Content-Disposition value. */
const UNSAFE = /[\r\n"\\/:*?<>|]+/g;
const VIDEO_EXTENSION =
  /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts)$/i;

export interface SubtitleNameParts {
  /** Release/video filename this subtitle belongs to. */
  releaseName?: string;
  /** Language display name (e.g. "Norwegian") or code. */
  language?: string;
  hearingImpaired?: boolean;
  forced?: boolean;
  /**
   * Disambiguates two files for the same release and language — e.g. the
   * untranslated source alongside its translation.
   */
  suffix?: string;
  extension?: string;
}

/**
 * Language code for a filename. Players accept both ISO 639-1 and 639-2; the
 * two-letter form is the more widely recognised, so prefer it and fall back to
 * whatever the caller gave us.
 */
export function subtitleLanguageCode(language?: string): string | undefined {
  if (!language) return undefined;
  const code = languageToCode(language);
  if (code) return code.toLowerCase();
  const trimmed = language.trim().toLowerCase();
  // Already a code (2–3 letters)? Keep it. Otherwise there's nothing usable.
  return /^[a-z]{2,3}$/.test(trimmed) ? trimmed : undefined;
}

export function buildSubtitleFilename(parts: SubtitleNameParts): string {
  const base = (parts.releaseName ?? 'subtitle')
    .replace(VIDEO_EXTENSION, '')
    .replace(UNSAFE, '_')
    .trim()
    .slice(0, 150);

  const segments: string[] = [base || 'subtitle'];

  const code = subtitleLanguageCode(parts.language);
  if (code) segments.push(code);
  // Flag order follows the convention players expect.
  if (parts.forced) segments.push('forced');
  if (parts.hearingImpaired) segments.push('sdh');
  if (parts.suffix) segments.push(parts.suffix.replace(UNSAFE, '_'));

  return `${segments.join('.')}.${parts.extension ?? 'srt'}`;
}
