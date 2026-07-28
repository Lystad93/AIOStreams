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

export interface SubtitleExternalOrigin {
  /** The SUBTITLE provider (subdl/subsource/opensubtitles), not the AI one. */
  externalProvider?: string;
  /** File taken out of the provider's archive — the one actually translated. */
  externalFile?: string;
  /** Releases the entry claimed to fit, including any mined from its comment. */
  externalReleases?: string[];
  /** Runtime the uploader stated, if their comment gave one. */
  externalStatedDurationMs?: number;
}

export interface SubtitleJobMeta extends SubtitleExternalOrigin {
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
  /** Runtime of the release this job was made for, in ms. */
  releaseDurationMs?: number;
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
  external_provider?: string | null;
  external_file?: string | null;
  external_releases?: string | null;
  external_stated_duration_ms?: number | string | null;
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

/** Stored as JSON text; a malformed value is treated as absent, not fatal. */
function parseJsonArray(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

function toListRow(r: DbRow): SubtitleJobListRow {
  return {
    id: r.id,
    uuid: r.uuid,
    contentId: r.content_id,
    releaseHash: r.release_hash,
    externalProvider: r.external_provider || undefined,
    externalFile: r.external_file || undefined,
    externalReleases: parseJsonArray(r.external_releases),
    externalStatedDurationMs: num(r.external_stated_duration_ms),
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
        created_at, updated_at, completed_at, match_key, release_duration_ms,
        external_provider, external_file, external_releases,
        external_stated_duration_ms
      ) VALUES (
        ${meta.id}, ${meta.uuid}, ${meta.contentId}, ${meta.releaseHash},
        ${meta.sourcePath}, ${meta.targetLang}, ${meta.sourceLang ?? null},
        ${meta.status}, ${meta.filename ?? null}, ${meta.videoSize ?? null},
        ${meta.provider ?? null}, ${meta.model ?? null}, ${meta.error ?? null},
        ${meta.createdAt}, ${meta.updatedAt}, ${meta.completedAt ?? null},
        ${normaliseReleaseName(meta.filename) || null},
        ${meta.releaseDurationMs ?? null},
        ${meta.externalProvider ?? null}, ${meta.externalFile ?? null},
        ${
          meta.externalReleases?.length
            ? JSON.stringify(meta.externalReleases)
            : null
        },
        ${meta.externalStatedDurationMs ?? null}
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
        match_key = ${normaliseReleaseName(meta.filename) || null},
        release_duration_ms = ${meta.releaseDurationMs ?? null},
        -- COALESCE so a later status write can't blank an origin that an
        -- earlier one recorded: only the download knows these values.
        external_provider = COALESCE(
          ${meta.externalProvider ?? null}, external_provider
        ),
        external_file = COALESCE(${meta.externalFile ?? null}, external_file),
        external_releases = COALESCE(
          ${
            meta.externalReleases?.length
              ? JSON.stringify(meta.externalReleases)
              : null
          },
          external_releases
        ),
        external_stated_duration_ms = COALESCE(
          ${meta.externalStatedDurationMs ?? null}, external_stated_duration_ms
        )
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
             external_provider, external_file, external_releases,
             external_stated_duration_ms,
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
  ): Promise<{
    srt: string;
    filename?: string;
    sourceLang?: string;
    targetLang?: string;
  } | null> {
    const col =
      which === 'extracted' ? sql`extracted_srt` : sql`translated_srt`;
    const row = await getDb().maybeOne<{
      [column: string]: unknown;
      srt: string | null;
      filename: string | null;
      source_lang: string | null;
      target_lang: string | null;
    }>(sql`
      SELECT ${col} AS srt, filename, source_lang, target_lang
      FROM subtitle_jobs WHERE id = ${id}
    `);
    if (!row || row.srt == null) return null;
    return {
      srt: row.srt,
      filename: row.filename ?? undefined,
      sourceLang: row.source_lang ?? undefined,
      targetLang: row.target_lang ?? undefined,
    };
  },

  /**
   * Mark every job left mid-flight as failed. Jobs run as in-process
   * background tasks, so any `pending`/`running` row found at startup belongs
   * to a process that no longer exists — without this they'd show as "running"
   * on the dashboard forever and block the file from ever being retried.
   * Returns how many were reconciled.
   */
  async markInterrupted(at: number): Promise<number> {
    // One statement: a separate COUNT would both duplicate the scan and let a
    // job finish between the two, reporting a number that was never true.
    const { rowCount } = await getDb().exec(sql`
      UPDATE subtitle_jobs
      SET status = 'failed',
          error = 'Interrupted by a server restart',
          updated_at = ${at}
      WHERE status IN ('pending','running')
    `);
    return rowCount ?? 0;
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
    filenames: string[],
    /** `undefined` = any user's translation (shared); otherwise this user's. */
    ownerUuid?: string
  ): Promise<Map<string, string>> {
    if (filenames.length === 0) return new Map();
    const keys = [
      ...new Set(filenames.map((f) => normaliseReleaseName(f))),
    ].filter(Boolean);
    // `sql\`\`` when shared, so the uuid predicate simply disappears rather
    // than being widened to a match-anything comparison.
    const ownerScope = ownerUuid ? sql`uuid = ${ownerUuid} AND` : sql``;
    // Guard the array actually interpolated, not `filenames`: a name that
    // normalises away to nothing (e.g. a bare ".mkv") leaves `keys` empty while
    // `filenames` is not, and `IN ()` is a Postgres syntax error even though
    // SQLite tolerates it.
    const byMatchKey = keys.length
      ? sql`match_key IN (${join(keys.map((k) => sql`${k}`))}) OR `
      : sql``;
    const rows = await getDb().query<{
      [k: string]: unknown;
      id: string;
      filename: string | null;
      match_key: string | null;
    }>(sql`
      SELECT id, filename, match_key FROM subtitle_jobs
      WHERE ${ownerScope}
        content_id = ${contentId}
        AND target_lang = ${targetLang}
        AND translated_srt IS NOT NULL
        AND LENGTH(translated_srt) > 0
        AND (
          ${byMatchKey}filename IN (${join(filenames.map((f) => sql`${f}`))})
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

  /**
   * A finished translation for this title in this language whose release runs
   * the same length as the one being played.
   *
   * This is what makes an already-translated subtitle reusable across releases
   * that differ only cosmetically — the runtime, not the name, is what decides
   * whether the timing fits.
   */
  async findTranslatedByDuration(
    uuid: string,
    contentId: string,
    targetLang: string,
    durationMs: number,
    toleranceMs: number,
    /** `undefined` = any user's translation (shared); otherwise this user's. */
    ownerUuid?: string
  ): Promise<string | undefined> {
    const ownerScope = ownerUuid ? sql`uuid = ${ownerUuid} AND` : sql``;
    if (!durationMs || durationMs <= 0) return undefined;
    const row = await getDb().maybeOne<{
      [k: string]: unknown;
      id: string;
    }>(sql`
      SELECT id FROM subtitle_jobs
      WHERE ${ownerScope}
        content_id = ${contentId}
        AND target_lang = ${targetLang}
        AND translated_srt IS NOT NULL
        AND LENGTH(translated_srt) > 0
        AND release_duration_ms IS NOT NULL
        AND release_duration_ms BETWEEN ${durationMs - toleranceMs}
                                    AND ${durationMs + toleranceMs}
      -- SQLite sorts NULLs low and Postgres sorts them high, and equal
      -- timestamps otherwise tie arbitrarily — spell both out so the two
      -- backends pick the same row.
      ORDER BY (completed_at IS NULL), completed_at DESC, id DESC
      LIMIT 1
    `);
    return row?.id;
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

  /**
   * Drop jobs older than `maxDays`, and any whose user no longer exists.
   *
   * Each row carries two full SRT bodies, so this table is the one part of the
   * feature that grows without bound. `uuid` is a plain column rather than a
   * foreign key (jobs outlive individual configs by design), which means user
   * pruning cannot cascade — orphans are collected here instead, and always,
   * since nobody can reach them. A negative `maxDays` disables the age sweep
   * only, matching the user-pruning convention.
   */
  async prune(maxDays: number, now: number): Promise<number> {
    let removed = 0;
    if (maxDays >= 0) {
      const cutoff = now - maxDays * 24 * 60 * 60 * 1000;
      const { rowCount } = await getDb().exec(
        sql`DELETE FROM subtitle_jobs WHERE created_at < ${cutoff}`
      );
      removed += rowCount ?? 0;
    }
    const { rowCount: orphaned } = await getDb().exec(sql`
      DELETE FROM subtitle_jobs
      WHERE uuid NOT IN (SELECT uuid FROM users)
    `);
    return removed + (orphaned ?? 0);
  },
};
