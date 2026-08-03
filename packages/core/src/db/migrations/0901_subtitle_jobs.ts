import type { Migration } from './types.js';

/**
 * Durable record of subtitle extraction+translation jobs (spec §4.2/§4.4) so
 * the dashboard can list history, show details, and let the owner download both
 * the extracted and translated `.srt` files. The live per-request slot logic
 * still uses the fast cache-backed job store; this table is the durable
 * write-through record (survives restarts and cache eviction).
 *
 * The SRT bodies live in this table as TEXT (they're small); the list query
 * never selects them, only their presence/length.
 */
export const subtitleJobs: Migration = {
  id: 901,
  name: 'subtitle_jobs',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS subtitle_jobs (
        id TEXT PRIMARY KEY,
        uuid TEXT NOT NULL,
        content_id TEXT NOT NULL,
        release_hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        source_lang TEXT,
        status TEXT NOT NULL,
        filename TEXT,
        video_size INTEGER,
        provider TEXT,
        model TEXT,
        cue_count INTEGER,
        error TEXT,
        extracted_srt TEXT,
        translated_srt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_updated
        ON subtitle_jobs (updated_at);
      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_uuid
        ON subtitle_jobs (uuid);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS subtitle_jobs (
        id TEXT PRIMARY KEY,
        uuid TEXT NOT NULL,
        content_id TEXT NOT NULL,
        release_hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        source_lang TEXT,
        status TEXT NOT NULL,
        filename TEXT,
        video_size BIGINT,
        provider TEXT,
        model TEXT,
        cue_count BIGINT,
        error TEXT,
        extracted_srt TEXT,
        translated_srt TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        completed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_updated
        ON subtitle_jobs (updated_at);
      CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_uuid
        ON subtitle_jobs (uuid);
    `,
  },
};
