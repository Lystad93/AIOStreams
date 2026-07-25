import type { Migration } from './types.js';

/**
 * Canonical release key alongside the raw filename, on both subtitle tables.
 *
 * Addons spell the same release differently (extension present or absent, dots
 * vs spaces vs percent-encoding, an appended re-upload tag), so an exact
 * filename comparison misses a subtitle that was stored from another addon's
 * copy. `match_key` holds the normalised form (see `normaliseReleaseName`) and
 * is what lookups compare on; `filename` stays as the human-readable original.
 *
 * Rows written before this migration have a NULL `match_key`; lookups fall back
 * to exact-filename matching so those keep resolving.
 */
export const subtitleMatchKey: Migration = {
  id: 20,
  name: 'subtitle_match_key',
  up: {
    sqlite: `
      ALTER TABLE subtitle_jobs ADD COLUMN match_key TEXT;
      ALTER TABLE subtitle_sources ADD COLUMN match_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_match_key
        ON subtitle_jobs (match_key);
      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_match_key
        ON subtitle_sources (match_key);
    `,
    postgres: `
      ALTER TABLE subtitle_jobs ADD COLUMN IF NOT EXISTS match_key TEXT;
      ALTER TABLE subtitle_sources ADD COLUMN IF NOT EXISTS match_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_match_key
        ON subtitle_jobs (match_key);
      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_match_key
        ON subtitle_sources (match_key);
    `,
  },
};
