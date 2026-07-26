import { z } from 'zod';
import { commaSeparatedList, nonNegativeInt } from './helpers.js';
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
  externalEnabled: {
    schema: z.boolean(),
    default: true,
    label: 'Search external subtitle providers',
    description:
      'Look up subtitles for the exact release being played on the configured providers (SubSource, SubDL). Matches are offered alongside the extraction entry with a confidence percentage, and a good match can be translated without downloading the video at all. Needs at least one provider API key below.',
    env: 'SUBTITLE_EXTERNAL_ENABLED',
    requiresRestart: false,
    secret: false,
  },
  subsourceApiKey: {
    schema: z.string(),
    default: '',
    label: 'SubSource API key',
    description:
      'API key for [SubSource](https://subsource.net/api-docs). Its subtitles list every release they are synced to, which gives the most reliable matches.',
    env: 'SUBTITLE_SUBSOURCE_API_KEY',
    requiresRestart: false,
    secret: true,
  },
  subdlApiKey: {
    schema: z.string(),
    default: '',
    label: 'SubDL API key',
    description:
      'API key for [SubDL](https://subdl.com/panel/api). Supports searching by the exact release filename.',
    env: 'SUBTITLE_SUBDL_API_KEY',
    requiresRestart: false,
    secret: true,
  },
  externalUseLimit: {
    schema: nonNegativeInt,
    default: 3,
    label: 'External subtitles to offer (use as-is)',
    description:
      'How many matched external subtitles to list for playing directly, best match first. Set 0 to hide them and leave only the translate entries.',
    env: 'SUBTITLE_EXTERNAL_USE_LIMIT',
    requiresRestart: false,
    secret: false,
  },
  externalTranslateLimit: {
    schema: nonNegativeInt,
    default: 3,
    label: 'External subtitles to offer (translate)',
    description:
      'How many matched external subtitles to offer translating into your target language. Counted separately from the entries above, so you can list several to use but only translate the best one. Set 0 to hide them.',
    env: 'SUBTITLE_EXTERNAL_TRANSLATE_LIMIT',
    requiresRestart: false,
    secret: false,
  },
  externalCacheSize: {
    schema: nonNegativeInt,
    default: 500,
    label: 'External subtitle cache size',
    description:
      'How many downloaded external subtitle files to keep, so re-selecting one does not re-download and re-unpack it. This cache is entirely separate from extracted and translated subtitles — those are stored permanently in the database and are never evicted by this limit. Set 0 to disable caching.',
    env: 'SUBTITLE_EXTERNAL_CACHE_SIZE',
    requiresRestart: true,
    secret: false,
  },
  opensubtitlesApiKey: {
    schema: z.string(),
    default: '',
    label: 'OpenSubtitles API key',
    description:
      'App key for [OpenSubtitles](https://www.opensubtitles.com/en/consumers). This is enough to SEARCH. Downloading counts against a personal daily quota, so each user must also supply their own OpenSubtitles username and password in their settings — the instance key is never used to spend someone else’s quota.',
    env: 'SUBTITLE_OPENSUBTITLES_API_KEY',
    requiresRestart: false,
    secret: true,
  },
  durationToleranceSeconds: {
    schema: nonNegativeInt,
    default: 60,
    label: 'Duration match tolerance (seconds)',
    description:
      'How far two runtimes may differ and still count as the same content. Applied as `max(this, percentage below)`: a fixed floor absorbs the minute-level rounding in addon-reported runtimes, while the percentage scales with long films.',
    env: 'SUBTITLE_DURATION_TOLERANCE_SECONDS',
    requiresRestart: false,
    secret: false,
  },
  durationTolerancePercent: {
    schema: z.number().min(0).max(20),
    default: 0.5,
    label: 'Duration match tolerance (%)',
    description:
      'Percentage of the runtime allowed to differ, used when it is larger than the fixed tolerance above.',
    env: 'SUBTITLE_DURATION_TOLERANCE_PERCENT',
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
