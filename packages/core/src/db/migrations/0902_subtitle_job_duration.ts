import type { Migration } from './types.js';

/**
 * Records how long a successful translation actually took (extraction +
 * translation wall-clock, milliseconds), so the dashboard can show "time
 * taken". Set once at completion, so it's immune to retries and to the job's
 * created/updated timestamps.
 */
export const subtitleJobDuration: Migration = {
  id: 902,
  name: 'subtitle_job_duration',
  up: {
    sqlite: `
      ALTER TABLE subtitle_jobs ADD COLUMN duration_ms INTEGER;
    `,
    postgres: `
      ALTER TABLE subtitle_jobs ADD COLUMN IF NOT EXISTS duration_ms BIGINT;
    `,
  },
};
