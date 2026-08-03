import {
  StreamSessionRepository,
  type StreamBandwidthBucket,
  type StreamBandwidthRollup,
  type StreamTransport,
} from '../db/repositories/stream-sessions.js';
import { appConfig } from '../utils/index.js';
import {
  GLOBAL_LIMIT_KEY,
  PER_USER_LIMIT_KEY,
} from '../config/schema/streams.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('streams');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * `24h` and `7d` are plain rolling windows. `30d` is the accounting period:
 * the last 30 days, or month-to-date when the period mode is monthly. It is
 * the figure limits are measured against, so caps and dashboard agree.
 */
export type BandwidthWindow = '24h' | '7d' | '30d';

export interface BandwidthUsage {
  /** Bytes served by everyone this period. */
  global: number;
  /** Bytes served per user this period. */
  byUser: Map<string, number>;
}

/**
 * Start of the current accounting period. `monthly` counts from `resetDay` of
 * the current month, falling back to last month's when that day has not
 * arrived yet. `resetDay` is capped at 28 by the schema so it always exists.
 */
export function currentPeriodStart(now = Date.now()): number {
  const { periodMode, resetDay } = appConfig.streams.bandwidth;
  if (periodMode !== 'monthly') return now - 30 * DAY_MS;
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), resetDay, 0, 0, 0, 0);
  if (start.getTime() > now) start.setMonth(start.getMonth() - 1);
  return start.getTime();
}

function floorTo(ts: number, width: number): number {
  return ts - (ts % width);
}

/**
 * `sinceMs` and chart bucket width for a dashboard window. The rolling windows
 * start on a bucket boundary so the axis carries whole buckets only; `30d`
 * cannot, being the accounting period the caps are measured against.
 */
export function resolveBandwidthWindow(
  window: BandwidthWindow,
  now = Date.now()
): { sinceMs: number; bucketMs: number } {
  switch (window) {
    case '24h':
      return {
        sinceMs: floorTo(now, HOUR_MS) - 23 * HOUR_MS,
        bucketMs: HOUR_MS,
      };
    case '7d':
      return { sinceMs: floorTo(now, DAY_MS) - 6 * DAY_MS, bucketMs: DAY_MS };
    case '30d':
    default:
      // The accounting period, not a fixed 30 days.
      return { sinceMs: currentPeriodStart(now), bucketMs: DAY_MS };
  }
}

/**
 * Period-to-date usage, refreshed by the flush task. Admission is synchronous
 * (check and reserve must not interleave), so it reads this snapshot rather
 * than querying. Bytes served since the last refresh are layered on top by the
 * registry, so a cap still trips within one flush interval.
 */
let snapshot: BandwidthUsage = { global: 0, byUser: new Map() };
/** Which period the snapshot describes; a rollover invalidates it. */
let snapshotKey = '';

/**
 * Identity of the current period, stable for as long as it lasts.
 *
 * Not the period's start timestamp: in rolling mode that is `now - 30d`, which
 * differs on every call, so the snapshot would always look stale and admission
 * would read zero usage. Only `monthly` has a rollover to detect.
 */
function periodKey(now: number): string {
  const { periodMode } = appConfig.streams.bandwidth;
  return periodMode === 'monthly'
    ? `monthly:${currentPeriodStart(now)}`
    : 'rolling';
}

export async function refreshBandwidthUsage(now = Date.now()): Promise<void> {
  try {
    const rows = await StreamSessionRepository.bandwidthByUser(
      currentPeriodStart(now)
    );
    snapshot = foldUsage(rows);
    snapshotKey = periodKey(now);
  } catch (err) {
    logger.warn({ err }, 'failed to refresh bandwidth usage; keeping snapshot');
  }
}

function foldUsage(rows: StreamBandwidthRollup[]): BandwidthUsage {
  const byUser = new Map<string, number>();
  let global = 0;
  for (const r of rows) {
    byUser.set(r.username, (byUser.get(r.username) ?? 0) + r.bytes);
    global += r.bytes;
  }
  return { global, byUser };
}

/** Persisted period-to-date usage as of the last refresh. */
export function bandwidthSnapshot(now = Date.now()): BandwidthUsage {
  // A rollover (or a change of period mode) between refreshes would otherwise
  // keep enforcing the previous period's total against the new period's cap.
  if (snapshotKey !== periodKey(now)) {
    return { global: 0, byUser: new Map() };
  }
  return snapshot;
}

/** The configured cap for a user in bytes; 0 means unlimited. */
export function userBandwidthLimit(username: string): number {
  const limits = appConfig.streams.bandwidth.limits;
  return limits[username] ?? limits[PER_USER_LIMIT_KEY] ?? 0;
}

/** The configured shared cap in bytes; 0 means unlimited. */
export function globalBandwidthLimit(): number {
  return appConfig.streams.bandwidth.limits[GLOBAL_LIMIT_KEY] ?? 0;
}

/** Lines the per-user chart stays readable with; the rest fold into one. */
const MAX_USER_SERIES = 7;

/** One user's line on the per-user chart. */
export interface BandwidthUserSeries {
  /** Empty both for unidentified streams and for the aggregate line. */
  username: string;
  /** Set on the line folding everyone past {@link MAX_USER_SERIES}. */
  aggregated?: boolean;
  series: StreamBandwidthBucket[];
}

/**
 * Split the bucketed series per user, heaviest first. Buckets stay sparse; the
 * chart densifies them. The fold gets a container of its own rather than a
 * reserved username, since every string is a name someone could hold.
 */
function foldUserSeries(
  buckets: Array<{ bucketMs: number; username: string; bytes: number }>,
  ranked: Array<{ username: string }>
): BandwidthUserSeries[] {
  const named = ranked.slice(0, MAX_USER_SERIES).map((u) => u.username);
  const keep = new Set(named);
  const byUser = new Map<string, Map<number, number>>();
  const others = new Map<number, number>();
  for (const b of buckets) {
    let line = others;
    if (keep.has(b.username)) {
      line = byUser.get(b.username) ?? new Map<number, number>();
      byUser.set(b.username, line);
    }
    line.set(b.bucketMs, (line.get(b.bucketMs) ?? 0) + b.bytes);
  }
  const toSeries = (line: Map<number, number>): StreamBandwidthBucket[] =>
    [...line.entries()]
      .map(([bucket, bytes]) => ({ bucketMs: bucket, bytes }))
      .sort((a, b) => a.bucketMs - b.bucketMs);

  const out: BandwidthUserSeries[] = named
    .filter((username) => byUser.has(username))
    .map((username) => ({
      username,
      series: toSeries(byUser.get(username)!),
    }));
  if (others.size > 0) {
    out.push({ username: '', aggregated: true, series: toSeries(others) });
  }
  return out;
}

/** Per-user and per-transport totals for the dashboard. */
export async function bandwidthBreakdown(
  window: BandwidthWindow,
  now = Date.now()
): Promise<{
  sinceMs: number;
  bucketMs: number;
  total: number;
  byTransport: Record<StreamTransport, number>;
  byUser: Array<{ username: string; bytes: number }>;
  series: StreamBandwidthBucket[];
  seriesByUser: BandwidthUserSeries[];
}> {
  const { sinceMs, bucketMs } = resolveBandwidthWindow(window, now);
  const [rows, series, userBuckets] = await Promise.all([
    StreamSessionRepository.bandwidthByUser(sinceMs),
    StreamSessionRepository.bandwidthSeries(sinceMs, bucketMs),
    StreamSessionRepository.bandwidthSeriesByUser(sinceMs, bucketMs),
  ]);
  const byTransport: Record<StreamTransport, number> = { usenet: 0, proxy: 0 };
  const perUser = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byTransport[r.transport] = (byTransport[r.transport] ?? 0) + r.bytes;
    perUser.set(r.username, (perUser.get(r.username) ?? 0) + r.bytes);
    total += r.bytes;
  }
  const byUser = [...perUser.entries()]
    .map(([username, bytes]) => ({ username, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    sinceMs,
    bucketMs,
    total,
    byTransport,
    byUser,
    series,
    seriesByUser: foldUserSeries(userBuckets, byUser),
  };
}
