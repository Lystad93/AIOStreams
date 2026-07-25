import { getDb } from '../db.js';
import { sql, join } from '../sql.js';
import { normaliseReleaseName } from '../../subtitles/release-name.js';

/**
 * Durable store for subtitle extraction+translation jobs (spec §4.2/§4.4),
 * backing the dashboard. The live per-request slot logic uses the fast
 * cache-backed store; the pipeline writes through to this table at each state
 * transition so the dashboard has a permanent record and the SRT files remain
 * downloadable after cache eviction.
 */

export interface SubtitleJobMeta {
  id: string;
  uuid: string;
  contentId: string;
  releaseHash: string;
  sourcePath: string;
  targetLang: string;
  sourceLang?: string;
  status: string;
  filename?: string;
  videoSize?: number;
  provider?: string;
  model?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** A list row: metadata plus which SRTs exist and their sizes (not bodies). */
export interface SubtitleJobListRow extends SubtitleJobMeta {
  cueCount?: number;
  extractedBytes: number;
  translatedBytes: number;
  /** Wall-clock of the successful run (extraction + translation), ms. */
  durationMs?: number;
}

interface DbRow {
  [column: string]: unknown;
  id: string;
  uuid: string;
  content_id: string;
  release_hash: string;
  source_path: string;
  target_lang: string;
  source_lang: string | null;
  status: string;
  filename: string | null;
  video_size: number | string | null;
  provider: string | null;
  model: string | null;
  cue_count: number | string | null;
  error: string | null;
  created_at: number | string;
  updated_at: number | string;
  completed_at: number | string | null;
  duration_ms: number | string | null;
  extracted_len?: number | string | null;
  translated_len?: number | string | null;
}

const num = (v: number | string | null | undefined): number | undefined =>
  v == null ? undefined : Number(v);

function toListRow(r: DbRow): SubtitleJobListRow {
  return {
    id: r.id,
    uuid: r.uuid,
    contentId: r.content_id,
    releaseHash: r.release_hash,
    sourcePath: r.source_path,
    targetLang: r.target_lang,
    sourceLang: r.source_lang ?? undefined,
    status: r.status,
    filename: r.filename ?? undefined,
    videoSize: num(r.video_size),
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    error: r.error ?? undefined,
    cueCount: num(r.cue_count),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    completedAt: num(r.completed_at),
    durationMs: num(r.duration_ms),
    extractedBytes: num(r.extracted_len) ?? 0,
    translatedBytes: num(r.translated_len) ?? 0,
  };
}

export const SubtitleJobRepository = {
  /** Insert or update a job's metadata (never touches the stored SRT bodies). */
  async saveMeta(meta: SubtitleJobMeta): Promise<void> {
    const db = getDb();
    await db.exec(sql`
      INSERT INTO subtitle_jobs (
        id, uuid, content_id, release_hash, source_path, target_lang,
        source_lang, status, filename, video_size, provider, model, error,
        created_at, updated_at, completed_at, match_key
      ) VALUES (
        ${meta.id}, ${meta.uuid}, ${meta.contentId}, ${meta.releaseHash},
        ${meta.sourcePath}, ${meta.targetLang}, ${meta.sourceLang ?? null},
        ${meta.status}, ${meta.filename ?? null}, ${meta.videoSize ?? null},
        ${meta.provider ?? null}, ${meta.model ?? null}, ${meta.error ?? null},
        ${meta.createdAt}, ${meta.updatedAt}, ${meta.completedAt ?? null},
        ${normaliseReleaseName(meta.filename) || null}
      )
      ON CONFLICT (id) DO UPDATE SET
        source_lang = ${meta.sourceLang ?? null},
        status = ${meta.status},
        filename = ${meta.filename ?? null},
        video_size = ${meta.videoSize ?? null},
        provider = ${meta.provider ?? null},
        model = ${meta.model ?? null},
        error = ${meta.error ?? null},
        updated_at = ${meta.updatedAt},
        completed_at = ${meta.completedAt ?? null},
        match_key = ${normaliseReleaseName(meta.filename) || null}
    `);
  },

  async setExtractedSrt(
    id: string,
    srt: string,
    cueCount: number,
    updatedAt: number
  ): Promise<void> {
    await getDb().exec(sql`
      UPDATE subtitle_jobs
      SET extracted_srt = ${srt}, cue_count = ${cueCount}, updated_at = ${updatedAt}
      WHERE id = ${id}
    `);
  },

  async setTranslatedSrt(
    id: string,
    srt: string,
    completedAt: number,
    durationMs: number
  ): Promise<void> {
    await getDb().exec(sql`
      UPDATE subtitle_jobs
      SET translated_srt = ${srt}, completed_at = ${completedAt},
          updated_at = ${completedAt}, duration_ms = ${durationMs}
      WHERE id = ${id}
    `);
  },

  /** Recent jobs, newest first. Bodies excluded — only their lengths. */
  async list(
    opts: { limit?: number; offset?: number } = {}
  ): Promise<SubtitleJobListRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = await getDb().query<DbRow>(sql`
      SELECT id, uuid, content_id, release_hash, source_path, target_lang,
             source_lang, status, filename, video_size, provider, model,
             cue_count, error, created_at, updated_at, completed_at, duration_ms,
             LENGTH(extracted_srt) AS extracted_len,
             LENGTH(translated_srt) AS translated_len
      FROM subtitle_jobs
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.map(toListRow);
  },

  async count(): Promise<number> {
    return getDb().count(sql`SELECT COUNT(*) FROM subtitle_jobs`);
  },

  /** Fetch one stored SRT body (`extracted` | `translated`) plus its filename. */
  async getSrt(
    id: string,
    which: 'extracted' | 'translated'
  ): Promise<{ srt: string; filename?: string } | null> {
    const col =
      which === 'extracted' ? sql`extracted_srt` : sql`translated_srt`;
    const row = await getDb().maybeOne<{
      [column: string]: unknown;
      srt: string | null;
      filename: string | null;
    }>(sql`
      SELECT ${col} AS srt, filename FROM subtitle_jobs WHERE id = ${id}
    `);
    if (!row || row.srt == null) return null;
    return { srt: row.srt, filename: row.filename ?? undefined };
  },

  /**
   * Mark every job left mid-flight as failed. Jobs run as in-process
   * background tasks, so any `pending`/`running` row found at startup belongs
   * to a process that no longer exists — without this they'd show as "running"
   * on the dashboard forever and block the file from ever being retried.
   * Returns how many were reconciled.
   */
  async markInterrupted(at: number): Promise<number> {
    const stuck = await getDb().count(
      sql`SELECT COUNT(*) FROM subtitle_jobs WHERE status IN ('pending','running')`
    );
    if (stuck > 0) {
      await getDb().exec(sql`
        UPDATE subtitle_jobs
        SET status = 'failed',
            error = 'Interrupted by a server restart',
            updated_at = ${at}
        WHERE status IN ('pending','running')
      `);
    }
    return stuck;
  },

  /**
   * Map release filename → job id, for releases that already have a stored
   * translation for this user/content/target language.
   *
   * Matching on the FILENAME rather than the job id is deliberate: the job id
   * folds in the reported file size, which different addons report
   * inconsistently (or omit) for the very same release — so an id match misses
   * the same file served by another addon. The filename is the release
   * identity, so this both flags the stream correctly and lets a translation be
   * reused instead of re-extracting the whole file.
   */
  async findTranslatedByFilenames(
    uuid: string,
    contentId: string,
    targetLang: string,
    filenames: string[]
  ): Promise<Map<string, string>> {
    if (filenames.length === 0) return new Map();
    const keys = [
      ...new Set(filenames.map((f) => normaliseReleaseName(f))),
    ].filter(Boolean);
    const rows = await getDb().query<{
      [k: string]: unknown;
      id: string;
      filename: string | null;
      match_key: string | null;
    }>(sql`
      SELECT id, filename, match_key FROM subtitle_jobs
      WHERE uuid = ${uuid}
        AND content_id = ${contentId}
        AND target_lang = ${targetLang}
        AND translated_srt IS NOT NULL
        AND LENGTH(translated_srt) > 0
        AND (
          match_key IN (${join(keys.map((k) => sql`${k}`))})
          OR filename IN (${join(filenames.map((f) => sql`${f}`))})
        )
    `);
    // Report hits under the caller's own spelling of the filename.
    const byKey = new Map<string, string>();
    for (const r of rows) {
      const key = r.match_key || normaliseReleaseName(r.filename ?? '');
      if (key) byKey.set(key, r.id);
      if (r.filename) byKey.set(r.filename, r.id);
    }
    const out = new Map<string, string>();
    for (const f of filenames) {
      const id = byKey.get(normaliseReleaseName(f)) ?? byKey.get(f);
      if (id) out.set(f, id);
    }
    return out;
  },

  /**
   * Of the given job ids, which already have a finished translation stored.
   * One query for a whole stream list (the formatter's `subtitleTranslated`
   * flag), rather than a lookup per stream.
   */
  async filterTranslated(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await getDb().query<{ [k: string]: unknown; id: string }>(sql`
      SELECT id FROM subtitle_jobs
      WHERE translated_srt IS NOT NULL
        AND LENGTH(translated_srt) > 0
        AND id IN (${join(ids.map((id) => sql`${id}`))})
    `);
    return new Set(rows.map((r) => r.id));
  },

  /** Cheap check: is a finished translation stored for this job id? */
  async hasTranslated(id: string): Promise<boolean> {
    const row = await getDb().maybeOne<{
      [k: string]: unknown;
      n: number | string;
    }>(
      sql`SELECT CASE WHEN translated_srt IS NOT NULL AND LENGTH(translated_srt) > 0
                 THEN 1 ELSE 0 END AS n
          FROM subtitle_jobs WHERE id = ${id}`
    );
    return !!row && Number(row.n) === 1;
  },

  async delete(id: string): Promise<void> {
    await getDb().exec(sql`DELETE FROM subtitle_jobs WHERE id = ${id}`);
  },
};
