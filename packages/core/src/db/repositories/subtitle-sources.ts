import { getDb } from '../db.js';
import { sql, join } from '../sql.js';
import { getSimpleTextHash } from '../../utils/crypto.js';

/**
 * The reusable *source* subtitle pool (see migration 0019). A row is one
 * subtitle track for one release, in one language, from one origin — with the
 * measured properties needed to match it against other releases.
 */

export type SubtitleSourceOrigin = 'extracted' | 'external';

export interface SubtitleSource {
  id: string;
  contentId?: string;
  filename: string;
  videoSize?: number;
  /** Language of THIS subtitle (canonical display name, e.g. "English"). */
  lang: string;
  origin: SubtitleSourceOrigin;
  trackIndex?: number;
  trackCodec?: string;
  forced: boolean;
  hearingImpaired: boolean;
  trackTitle?: string;
  /** Measured container duration — the primary cross-release matching key. */
  durationMs?: number;
  /** Frame rate; decides whether cues can be reused without retiming. */
  fps?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  cueCount?: number;
  firstCueMs?: number;
  lastCueMs?: number;
  srt: string;
  createdBy?: string;
  createdAt: number;
}

/** A source row without the (potentially large) SRT body. */
export type SubtitleSourceMeta = Omit<SubtitleSource, 'srt'>;

interface DbRow {
  [column: string]: unknown;
  id: string;
  content_id: string | null;
  filename: string;
  video_size: number | string | null;
  lang: string;
  origin: string;
  track_index: number | string | null;
  track_codec: string | null;
  forced: number | boolean | null;
  hearing_impaired: number | boolean | null;
  track_title: string | null;
  duration_ms: number | string | null;
  fps: number | string | null;
  width: number | string | null;
  height: number | string | null;
  video_codec: string | null;
  cue_count: number | string | null;
  first_cue_ms: number | string | null;
  last_cue_ms: number | string | null;
  created_by: string | null;
  created_at: number | string;
  srt?: string | null;
}

const num = (v: number | string | null | undefined): number | undefined =>
  v == null ? undefined : Number(v);
const bool = (v: number | boolean | null | undefined): boolean =>
  v === true || v === 1;

function toMeta(r: DbRow): SubtitleSourceMeta {
  return {
    id: r.id,
    contentId: r.content_id ?? undefined,
    filename: r.filename,
    videoSize: num(r.video_size),
    lang: r.lang,
    origin: (r.origin as SubtitleSourceOrigin) ?? 'extracted',
    trackIndex: num(r.track_index),
    trackCodec: r.track_codec ?? undefined,
    forced: bool(r.forced),
    hearingImpaired: bool(r.hearing_impaired),
    trackTitle: r.track_title ?? undefined,
    durationMs: num(r.duration_ms),
    fps: num(r.fps),
    width: num(r.width),
    height: num(r.height),
    videoCodec: r.video_codec ?? undefined,
    cueCount: num(r.cue_count),
    firstCueMs: num(r.first_cue_ms),
    lastCueMs: num(r.last_cue_ms),
    createdBy: r.created_by ?? undefined,
    createdAt: Number(r.created_at),
  };
}

const META_COLUMNS = sql`id, content_id, filename, video_size, lang, origin,
  track_index, track_codec, forced, hearing_impaired, track_title,
  duration_ms, fps, width, height, video_codec, cue_count, first_cue_ms,
  last_cue_ms, created_by, created_at`;

/** Deterministic id for a (release, language, origin) source subtitle. */
export function sourceId(parts: {
  filename: string;
  lang: string;
  origin: SubtitleSourceOrigin;
}): string {
  return getSimpleTextHash(
    [parts.filename, parts.lang, parts.origin].map(encodeURIComponent).join('|')
  );
}

export const SubtitleSourceRepository = {
  async put(source: SubtitleSource): Promise<void> {
    await getDb().exec(sql`
      INSERT INTO subtitle_sources (
        id, content_id, filename, video_size, lang, origin, track_index,
        track_codec, forced, hearing_impaired, track_title, duration_ms, fps,
        width, height, video_codec, cue_count, first_cue_ms, last_cue_ms,
        srt, created_by, created_at
      ) VALUES (
        ${source.id}, ${source.contentId ?? null}, ${source.filename},
        ${source.videoSize ?? null}, ${source.lang}, ${source.origin},
        ${source.trackIndex ?? null}, ${source.trackCodec ?? null},
        ${source.forced}, ${source.hearingImpaired},
        ${source.trackTitle ?? null}, ${source.durationMs ?? null},
        ${source.fps ?? null}, ${source.width ?? null}, ${source.height ?? null},
        ${source.videoCodec ?? null}, ${source.cueCount ?? null},
        ${source.firstCueMs ?? null}, ${source.lastCueMs ?? null},
        ${source.srt}, ${source.createdBy ?? null}, ${source.createdAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        srt = ${source.srt},
        duration_ms = ${source.durationMs ?? null},
        fps = ${source.fps ?? null},
        cue_count = ${source.cueCount ?? null},
        first_cue_ms = ${source.firstCueMs ?? null},
        last_cue_ms = ${source.lastCueMs ?? null}
    `);
  },

  /**
   * Every stored source subtitle for a release, newest first. `ownerUuid`
   * restricts to that user's own sources — pass `undefined` when the instance
   * shares the pool across users.
   */
  async findByFilename(
    filename: string,
    ownerUuid?: string
  ): Promise<SubtitleSourceMeta[]> {
    const scope = ownerUuid ? sql` AND created_by = ${ownerUuid}` : sql``;
    const rows = await getDb().query<DbRow>(sql`
      SELECT ${META_COLUMNS} FROM subtitle_sources
      WHERE filename = ${filename}${scope}
      ORDER BY created_at DESC
    `);
    return rows.map(toMeta);
  },

  /** Which of these filenames have at least one stored source subtitle. */
  async filterWithSources(
    filenames: string[],
    ownerUuid?: string
  ): Promise<Set<string>> {
    if (filenames.length === 0) return new Set();
    const scope = ownerUuid ? sql` AND created_by = ${ownerUuid}` : sql``;
    const rows = await getDb().query<{ [k: string]: unknown; filename: string }>(
      sql`
        SELECT DISTINCT filename FROM subtitle_sources
        WHERE filename IN (${join(filenames.map((f) => sql`${f}`))})${scope}
      `
    );
    return new Set(rows.map((r) => r.filename));
  },

  async getSrt(id: string): Promise<string | undefined> {
    const row = await getDb().maybeOne<{
      [k: string]: unknown;
      srt: string | null;
    }>(sql`SELECT srt FROM subtitle_sources WHERE id = ${id}`);
    return row?.srt ?? undefined;
  },

  async list(limit = 100, offset = 0): Promise<SubtitleSourceMeta[]> {
    const rows = await getDb().query<DbRow>(sql`
      SELECT ${META_COLUMNS} FROM subtitle_sources
      ORDER BY created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 500)} OFFSET ${Math.max(offset, 0)}
    `);
    return rows.map(toMeta);
  },

  async count(): Promise<number> {
    return getDb().count(sql`SELECT COUNT(*) FROM subtitle_sources`);
  },

  async delete(id: string): Promise<void> {
    await getDb().exec(sql`DELETE FROM subtitle_sources WHERE id = ${id}`);
  },
};
