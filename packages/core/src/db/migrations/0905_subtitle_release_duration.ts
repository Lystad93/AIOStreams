import type { Migration } from './types.js';

/**
 * Runtime of the release a job was made for.
 *
 * Distinct from the existing `duration_ms`, which records how long the JOB
 * took. This is the length of the video itself, and it's what lets a finished
 * translation be offered for a different release of the same content: releases
 * that differ only cosmetically (an added `HDR` token, a different encode, a
 * 60fps remux) share a runtime, and therefore share subtitle timing.
 */
export const subtitleReleaseDuration: Migration = {
  id: 905,
  name: 'subtitle_release_duration',
  up: {
    sqlite: `
      ALTER TABLE subtitle_jobs ADD COLUMN release_duration_ms INTEGER;

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_release_duration
        ON subtitle_jobs (content_id, release_duration_ms);
    `,
    postgres: `
      ALTER TABLE subtitle_jobs
        ADD COLUMN IF NOT EXISTS release_duration_ms BIGINT;

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_release_duration
        ON subtitle_jobs (content_id, release_duration_ms);
    `,
  },
};
