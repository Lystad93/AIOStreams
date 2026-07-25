import { z } from 'zod';
import { commaSeparatedList } from './helpers.js';
import type { RuntimeConfigSection } from '../types.js';

/**
 * Instance-level settings for subtitle extraction + AI translation
 * (spec §4.2/§4.4). Per-user settings (target language, source-language
 * priority, provider API key) live in the user's own config instead.
 *
 * The ffmpeg/ffprobe binary paths stay in bootstrap: they're process-level
 * plumbing rather than something an operator tunes at runtime.
 */
export const subtitlesSchema = {
  translationEnabled: {
    schema: z.boolean(),
    default: true,
    label: 'Enable subtitle translation',
    description:
      'Master switch for the subtitle extraction + translation feature. When disabled, no translation entries are offered to any user, regardless of their own settings.',
    env: 'SUBTITLE_TRANSLATION_ENABLED',
    requiresRestart: false,
    secret: false,
  },
  extractionAllowed: {
    schema: z.boolean(),
    default: true,
    label: 'Allow subtitle extraction',
    description:
      'Allow the full-file extraction path, which streams the release to demux its embedded subtitle track. On a public multi-tenant instance you may want this off, leaving only features that need no download. Users must supply their own translation API key either way.',
    env: 'SUBTITLE_EXTRACTION_ALLOWED',
    requiresRestart: false,
    secret: false,
  },
  shareSources: {
    schema: z.boolean(),
    default: true,
    label: 'Share extracted subtitles between users',
    description:
      'An extracted subtitle depends only on the release, not on who requested it or which language they were translating into. Sharing lets a second user — or the same user picking a different target language — reuse an existing extraction instead of re-downloading and re-demuxing the whole file. Disable to keep each user’s extractions private to them.',
    env: 'SUBTITLE_SHARE_SOURCES',
    requiresRestart: false,
    secret: false,
  },
  reuploadTags: {
    schema: commaSeparatedList,
    default: [],
    label: 'Re-upload tags',
    description:
      'Extra suffixes that re-hosting sites append to an existing release name (e.g. **wtf** for `…-Kitsune-WtF`). These are ignored when matching a stored subtitle against the release being played, so a re-upload still finds it. **wtf** is recognised by default.',
    env: 'SUBTITLE_REUPLOAD_TAGS',
    requiresRestart: false,
    secret: false,
  },
} as const satisfies RuntimeConfigSection;
