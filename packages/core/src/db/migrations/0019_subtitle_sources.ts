import type { Migration } from './types.js';

/**
 * Reusable *source* subtitles, separated from the per-user translation jobs.
 *
 * An extracted subtitle depends only on (release, track) — not on who asked for
 * it, and not on the language they wanted it translated into. Keeping it in its
 * own table means:
 *
 *  - a second user (or the same user wanting a different target language) reuses
 *    an existing extraction instead of re-downloading and re-demuxing the file,
 *  - the measured properties needed to match this subtitle against OTHER
 *    releases live with the subtitle itself (`duration_ms` is the primary
 *    matching key, `fps` decides whether cues need retiming),
 *  - externally-sourced subtitles (OpenSubtitles/SubDL/…) drop in later as rows
 *    with a different `origin`, sharing all the same matching logic.
 *
 * Keyed by filename rather than a size-derived hash: addons report file sizes
 * inconsistently for the same release, so the filename is the release identity.
 */
export const subtitleSources: Migration = {
  id: 19,
  name: 'subtitle_sources',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS subtitle_sources (
        id TEXT PRIMARY KEY,
        content_id TEXT,
        filename TEXT NOT NULL,
        video_size INTEGER,
        lang TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'extracted',
        track_index INTEGER,
        track_codec TEXT,
        forced INTEGER NOT NULL DEFAULT 0,
        hearing_impaired INTEGER NOT NULL DEFAULT 0,
        track_title TEXT,
        duration_ms INTEGER,
        fps REAL,
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        cue_count INTEGER,
        first_cue_ms INTEGER,
        last_cue_ms INTEGER,
        srt TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_filename
        ON subtitle_sources (filename);
      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_duration
        ON subtitle_sources (duration_ms);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS subtitle_sources (
        id TEXT PRIMARY KEY,
        content_id TEXT,
        filename TEXT NOT NULL,
        video_size BIGINT,
        lang TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'extracted',
        track_index BIGINT,
        track_codec TEXT,
        forced BOOLEAN NOT NULL DEFAULT FALSE,
        hearing_impaired BOOLEAN NOT NULL DEFAULT FALSE,
        track_title TEXT,
        duration_ms BIGINT,
        fps DOUBLE PRECISION,
        width BIGINT,
        height BIGINT,
        video_codec TEXT,
        cue_count BIGINT,
        first_cue_ms BIGINT,
        last_cue_ms BIGINT,
        srt TEXT NOT NULL,
        created_by TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_filename
        ON subtitle_sources (filename);
      CREATE INDEX IF NOT EXISTS idx_subtitle_sources_duration
        ON subtitle_sources (duration_ms);
    `,
  },
};
