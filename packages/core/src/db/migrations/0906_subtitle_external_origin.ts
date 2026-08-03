import type { Migration } from './types.js';

/**
 * Where an externally-sourced subtitle actually came from.
 *
 * `provider` on this table already means the AI provider (gemini, openai), so
 * an external job had no record of the SUBTITLE provider at all — the dashboard
 * showed "gemini" as the origin of a file fetched from SubDL. These columns
 * keep the two apart, and store what the download resolved to: the file taken
 * out of the archive, the releases the entry claimed to fit, and any runtime
 * the uploader stated.
 *
 * All nullable: an embedded extraction has no external origin to record.
 */
export const subtitleExternalOrigin: Migration = {
  id: 906,
  name: 'subtitle_external_origin',
  up: {
    sqlite: `
      ALTER TABLE subtitle_jobs ADD COLUMN external_provider TEXT;
      ALTER TABLE subtitle_jobs ADD COLUMN external_file TEXT;
      ALTER TABLE subtitle_jobs ADD COLUMN external_releases TEXT;
      ALTER TABLE subtitle_jobs ADD COLUMN external_stated_duration_ms INTEGER;
    `,
    postgres: `
      ALTER TABLE subtitle_jobs
        ADD COLUMN IF NOT EXISTS external_provider TEXT,
        ADD COLUMN IF NOT EXISTS external_file TEXT,
        ADD COLUMN IF NOT EXISTS external_releases TEXT,
        ADD COLUMN IF NOT EXISTS external_stated_duration_ms BIGINT;
    `,
  },
};
