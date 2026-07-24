import { getDb } from '../db.js';
import { sql } from '../sql.js';

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
        created_at, updated_at, completed_at
      ) VALUES (
        ${meta.id}, ${meta.uuid}, ${meta.contentId}, ${meta.releaseHash},
        ${meta.sourcePath}, ${meta.targetLang}, ${meta.sourceLang ?? null},
        ${meta.status}, ${meta.filename ?? null}, ${meta.videoSize ?? null},
        ${meta.provider ?? null}, ${meta.model ?? null}, ${meta.error ?? null},
        ${meta.createdAt}, ${meta.updatedAt}, ${meta.completedAt ?? null}
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
        completed_at = ${meta.completedAt ?? null}
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
  async list(opts: { limit?: number; offset?: number } = {}): Promise<
    SubtitleJobListRow[]
  > {
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
    const col = which === 'extracted' ? sql`extracted_srt` : sql`translated_srt`;
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

  /** Cheap check: is a finished translation stored for this job id? */
  async hasTranslated(id: string): Promise<boolean> {
    const row = await getDb().maybeOne<{ [k: string]: unknown; n: number | string }>(
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
