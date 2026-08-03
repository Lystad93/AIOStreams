import { getDb } from '../db.js';
import { sql } from '../sql.js';

export type TaskRunStatus = 'ok' | 'error' | 'skipped';

/** Coordination state for one task, shared by every replica. */
export interface TaskScheduleRow {
  taskId: string;
  /** When the next scheduled run is due; unset for manual tasks. */
  nextRunAt?: number;
  /** Replica currently running it, while its claim is live. */
  claimedBy?: string;
  claimExpiresAt?: number;
  /** Set when a run has been asked for outside the schedule. */
  runRequestedAt?: number;
}

/** What one replica did the last time it ran one task. */
export interface TaskRunRow {
  taskId: string;
  instanceId: string;
  lastRunAt: number;
  lastDurationMs?: number;
  lastStatus?: TaskRunStatus;
  lastError?: string;
}

interface ScheduleDbRow {
  task_id: string;
  next_run_at: number | string | null;
  claimed_by: string | null;
  claim_expires_at: number | string | null;
  run_requested_at: number | string | null;
  [k: string]: unknown;
}

interface RunDbRow {
  task_id: string;
  instance_id: string;
  last_run_at: number | string;
  last_duration_ms: number | string | null;
  last_status: string | null;
  last_error: string | null;
  [k: string]: unknown;
}

function optionalNumber(v: number | string | null): number | undefined {
  return v == null ? undefined : Number(v);
}

/**
 * Persistence for the task scheduler's shared state. The TaskManager owns the
 * in-process timers; this is what makes a run visible to, and claimable by,
 * every replica.
 */
export class TaskStateRepository {
  /**
   * Seed the coordination row, and pull in a next run that sits further out
   * than the current interval allows (a shortened interval leaves one behind).
   */
  static async ensureSchedule(
    taskId: string,
    nextRunAt?: number
  ): Promise<void> {
    const db = getDb();
    if (nextRunAt === undefined) {
      await db.exec(
        sql`INSERT INTO task_schedule (task_id) VALUES (${taskId})
            ON CONFLICT(task_id) DO NOTHING`
      );
      return;
    }
    await db.exec(
      sql`INSERT INTO task_schedule (task_id, next_run_at)
          VALUES (${taskId}, ${nextRunAt})
          ON CONFLICT(task_id) DO UPDATE SET next_run_at = ${nextRunAt}
          WHERE task_schedule.next_run_at IS NULL
             OR task_schedule.next_run_at > ${nextRunAt}`
    );
  }

  static async listSchedule(): Promise<TaskScheduleRow[]> {
    const rows = await getDb().query<ScheduleDbRow>(
      sql`SELECT task_id, next_run_at, claimed_by, claim_expires_at, run_requested_at
            FROM task_schedule`
    );
    return rows.map((r) => ({
      taskId: r.task_id,
      nextRunAt: optionalNumber(r.next_run_at),
      claimedBy: r.claimed_by ?? undefined,
      claimExpiresAt: optionalNumber(r.claim_expires_at),
      runRequestedAt: optionalNumber(r.run_requested_at),
    }));
  }

  /**
   * Take ownership of a run that has come due. The claim expires on its own, so
   * a replica killed mid-run does not block the task forever.
   */
  static async claimDue(
    taskId: string,
    owner: string,
    now: number,
    expiresAt: number
  ): Promise<boolean> {
    const res = await getDb().exec(
      sql`UPDATE task_schedule
             SET claimed_by = ${owner}, claim_expires_at = ${expiresAt}
           WHERE task_id = ${taskId}
             AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
             AND next_run_at IS NOT NULL AND next_run_at <= ${now}`
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** The same, for an on-demand run: due or not, as long as nobody holds it. */
  static async claimNow(
    taskId: string,
    owner: string,
    now: number,
    expiresAt: number
  ): Promise<boolean> {
    const res = await getDb().exec(
      sql`UPDATE task_schedule
             SET claimed_by = ${owner}, claim_expires_at = ${expiresAt}
           WHERE task_id = ${taskId}
             AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})`
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Push the claim's expiry out; called periodically while a run is going. */
  static async renewClaim(
    taskId: string,
    owner: string,
    expiresAt: number
  ): Promise<void> {
    await getDb().exec(
      sql`UPDATE task_schedule
             SET claim_expires_at = ${expiresAt}
           WHERE task_id = ${taskId} AND claimed_by = ${owner}`
    );
  }

  /** Give up ownership and set when the task is next due. */
  static async releaseClaim(
    taskId: string,
    owner: string,
    nextRunAt: number | undefined
  ): Promise<void> {
    await getDb().exec(
      sql`UPDATE task_schedule
             SET claimed_by = NULL,
                 claim_expires_at = NULL,
                 next_run_at = ${nextRunAt ?? null}
           WHERE task_id = ${taskId} AND claimed_by = ${owner}`
    );
  }

  /**
   * Ask every replica to run this task. Only for `all` tasks: a claimed task is
   * already covered cluster-wide by whoever holds the claim.
   */
  static async requestRun(taskId: string, atMs: number): Promise<void> {
    await getDb().exec(
      sql`INSERT INTO task_schedule (task_id, run_requested_at)
          VALUES (${taskId}, ${atMs})
          ON CONFLICT(task_id) DO UPDATE SET run_requested_at = ${atMs}`
    );
  }

  /** Clear a request this replica has answered locally. */
  static async clearRequest(
    taskId: string,
    handledUpTo: number
  ): Promise<void> {
    await getDb().exec(
      sql`UPDATE task_schedule
             SET run_requested_at = NULL
           WHERE task_id = ${taskId} AND run_requested_at <= ${handledUpTo}`
    );
  }

  static async recordRun(row: TaskRunRow): Promise<void> {
    await getDb().exec(
      sql`INSERT INTO task_runs
            (task_id, instance_id, last_run_at, last_duration_ms, last_status, last_error)
          VALUES
            (${row.taskId}, ${row.instanceId}, ${row.lastRunAt},
             ${row.lastDurationMs ?? null}, ${row.lastStatus ?? null},
             ${row.lastError ?? null})
          ON CONFLICT(task_id, instance_id) DO UPDATE SET
            last_run_at = EXCLUDED.last_run_at,
            last_duration_ms = EXCLUDED.last_duration_ms,
            last_status = EXCLUDED.last_status,
            last_error = EXCLUDED.last_error`
    );
  }

  static async listRuns(): Promise<TaskRunRow[]> {
    const rows = await getDb().query<RunDbRow>(
      sql`SELECT task_id, instance_id, last_run_at, last_duration_ms, last_status, last_error
            FROM task_runs
           ORDER BY last_run_at DESC`
    );
    return rows.map((r) => ({
      taskId: r.task_id,
      instanceId: r.instance_id,
      lastRunAt: Number(r.last_run_at),
      lastDurationMs: optionalNumber(r.last_duration_ms),
      lastStatus: (r.last_status as TaskRunStatus | null) ?? undefined,
      lastError: r.last_error ?? undefined,
    }));
  }

  /** Drop rows left by replicas that are never coming back. */
  static async pruneRuns(cutoffMs: number): Promise<number> {
    const res = await getDb().exec(
      sql`DELETE FROM task_runs WHERE last_run_at < ${cutoffMs}`
    );
    return res.rowCount ?? 0;
  }
}
