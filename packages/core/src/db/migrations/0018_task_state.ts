import type { Migration } from './types.js';

/**
 * Shared state for the background-task scheduler.
 *
 * `task_schedule` is coordination: one row per task holding when it is next
 * due, who owns the current run, and any out-of-band request. `task_runs` is
 * observability: one row per (task, replica).
 */
export const taskState: Migration = {
  id: 18,
  name: 'task_state',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS task_schedule (
        task_id TEXT PRIMARY KEY,
        next_run_at INTEGER,
        claimed_by TEXT,
        claim_expires_at INTEGER,
        run_requested_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        last_run_at INTEGER NOT NULL,
        last_duration_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        PRIMARY KEY (task_id, instance_id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_at ON task_runs (last_run_at);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS task_schedule (
        task_id TEXT PRIMARY KEY,
        next_run_at BIGINT,
        claimed_by TEXT,
        claim_expires_at BIGINT,
        run_requested_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        last_run_at BIGINT NOT NULL,
        last_duration_ms BIGINT,
        last_status TEXT,
        last_error TEXT,
        PRIMARY KEY (task_id, instance_id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_at ON task_runs (last_run_at);
    `,
  },
};
