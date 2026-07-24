/**
 * Self-contained, encrypted token carried in a slot's subtitle URL. Stremio/
 * Nuvio fetch a subtitle `url` directly with no auth context, so everything the
 * job endpoint needs to identify the request (and re-load the owner's config)
 * travels inside this token rather than as query params (spec §3.3).
 */
import { encryptString, decryptString } from '../utils/crypto.js';
import type { SubtitleSourcePath } from './types.js';

export interface SubtitleTokenPayload {
  uuid: string;
  /**
   * The owner's encrypted password (as it appears in the authenticated Stremio
   * path). Lets the unauthenticated job endpoint re-load and validate the
   * owner's config — including the decrypted translation API key — without
   * putting any secret in the URL beyond this already-encrypted blob (same
   * pattern as the debrid playback URL embedding encrypted store auth).
   */
  encryptedPassword: string;
  contentId: string;
  targetLang: string;
  sourcePath: SubtitleSourcePath;
  videoSize?: number;
  filename?: string;
}

export function encodeSubtitleToken(
  payload: SubtitleTokenPayload
): string | undefined {
  const res = encryptString(JSON.stringify(payload));
  return res.success && res.data ? res.data : undefined;
}

export function decodeSubtitleToken(
  token: string
): SubtitleTokenPayload | undefined {
  const res = decryptString(token);
  if (!res.success || !res.data) return undefined;
  try {
    return JSON.parse(res.data) as SubtitleTokenPayload;
  } catch {
    return undefined;
  }
}
