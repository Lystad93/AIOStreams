import type { Migration } from './types.js';

/**
 * Unified stream accounting across every transport that serves bytes through
 * this instance (the built-in proxy and the native usenet engine).
 *
 * `stream_sessions` holds one row per watch, not per request: a player's many
 * Range reads fold into one row, so `ended_at IS NULL` is the only predicate
 * splitting the dashboard's Active and History views.
 *
 * `stream_bandwidth` accumulates served bytes into hourly buckets so totals
 * survive session pruning. `stream_bans` backs the temporary blocks.
 */
export const streamSessions: Migration = {
  id: 17,
  name: 'stream_sessions',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS stream_sessions (
        id TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        client_ip TEXT,
        target_key TEXT NOT NULL,
        filename TEXT,
        display_url TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT,
        instance_id TEXT NOT NULL,
        stop_requested_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_stream_sessions_active
        ON stream_sessions (ended_at, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_user
        ON stream_sessions (username, started_at);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_transport
        ON stream_sessions (transport, started_at);

      CREATE TABLE IF NOT EXISTS stream_bandwidth (
        hour_ms INTEGER NOT NULL,
        username TEXT NOT NULL,
        transport TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, username, transport)
      );

      CREATE INDEX IF NOT EXISTS idx_stream_bandwidth_hour
        ON stream_bandwidth (hour_ms);

      CREATE TABLE IF NOT EXISTS stream_bans (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        username TEXT NOT NULL,
        target_key TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_stream_bans_user
        ON stream_bans (username, expires_at);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS stream_sessions (
        id TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        client_ip TEXT,
        target_key TEXT NOT NULL,
        filename TEXT,
        display_url TEXT,
        size BIGINT NOT NULL DEFAULT 0,
        bytes_served BIGINT NOT NULL DEFAULT 0,
        requests BIGINT NOT NULL DEFAULT 0,
        started_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        ended_at BIGINT,
        end_reason TEXT,
        instance_id TEXT NOT NULL,
        stop_requested_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_stream_sessions_active
        ON stream_sessions (ended_at, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_user
        ON stream_sessions (username, started_at);
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_transport
        ON stream_sessions (transport, started_at);

      CREATE TABLE IF NOT EXISTS stream_bandwidth (
        hour_ms BIGINT NOT NULL,
        username TEXT NOT NULL,
        transport TEXT NOT NULL,
        bytes BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_ms, username, transport)
      );

      CREATE INDEX IF NOT EXISTS idx_stream_bandwidth_hour
        ON stream_bandwidth (hour_ms);

      CREATE TABLE IF NOT EXISTS stream_bans (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        username TEXT NOT NULL,
        target_key TEXT,
        reason TEXT,
        created_at BIGINT NOT NULL,
        created_by TEXT,
        expires_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_stream_bans_user
        ON stream_bans (username, expires_at);
    `,
  },
};
