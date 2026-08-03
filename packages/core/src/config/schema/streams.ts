import { z } from 'zod';
import { byteSize, nonNegativeInt, parseByteSize, seconds } from './helpers.js';
import type { RuntimeConfigSection } from '../types.js';

export const GLOBAL_LIMIT_KEY = '**';
export const PER_USER_LIMIT_KEY = '*';

/** Bandwidth limits in bytes. Env shape is comma-separated `key:size`. */
const bandwidthLimitMap = z.union([
  z.record(z.string(), byteSize),
  z.string().transform((value, ctx) => {
    const out: Record<string, number> = {};
    if (!value.trim()) return out;
    for (const entry of value
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const colon = entry.indexOf(':');
      const username = colon === -1 ? '' : entry.slice(0, colon).trim();
      const size = colon === -1 ? '' : entry.slice(colon + 1).trim();
      if (!username || !size) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid bandwidth limit entry: "${entry}". Expected username:size (e.g. alice:500GB).`,
        });
        return z.NEVER;
      }
      const bytes = parseByteSize(size);
      if (bytes === null) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid bandwidth limit "${size}" for "${username}".`,
        });
        return z.NEVER;
      }
      out[username] = bytes;
    }
    return out;
  }),
]);

/** A concurrent-stream cap: a whole number, where `0` and `-1` mean unlimited. */
const connectionLimit = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (!Number.isInteger(n) || n < -1) {
      ctx.addIssue({
        code: 'custom',
        message: `Connection limit must be a whole number, 0 or -1 for unlimited, got ${JSON.stringify(value)}.`,
      });
      return z.NEVER;
    }
    return n;
  });

/** Concurrent-stream caps. Env shape is comma-separated `key:limit`. */
const connectionLimitMap = z.union([
  z.record(z.string(), connectionLimit),
  z.string().transform((value, ctx) => {
    const out: Record<string, number> = {};
    if (!value.trim()) return out;
    for (const entry of value
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const colon = entry.indexOf(':');
      const username = colon === -1 ? '' : entry.slice(0, colon).trim();
      const limit = colon === -1 ? '' : entry.slice(colon + 1).trim();
      if (!username || !limit) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid connection limit entry: "${entry}". Expected username:limit (e.g. alice:3).`,
        });
        return z.NEVER;
      }
      const n = Number(limit);
      if (!Number.isInteger(n) || n < -1) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid connection limit "${limit}" for "${username}". Expected a whole number, 0 or -1 for unlimited.`,
        });
        return z.NEVER;
      }
      out[username] = n;
    }
    return out;
  }),
]);

/**
 * Unified stream tracking (built-in proxy + native usenet engine): how long a
 * watch survives silence, how long history is kept, and the bandwidth
 * accounting period plus its optional caps.
 */
export const streamsSchema = {
  historyRetentionDays: {
    schema: nonNegativeInt,
    default: 7,
    label: 'Stream history retention (days)',
    description:
      'How long finished streams stay on the dashboard history list. Bandwidth totals are kept separately and are not affected by this.',
    env: 'STREAMS_HISTORY_RETENTION_DAYS',
    requiresRestart: false,
    secret: false,
  },
  clientIpRecording: {
    schema: z.enum(['full', 'prefix', 'none']),
    default: 'full' as 'full' | 'prefix' | 'none',
    label: 'Record client IPs',
    description:
      "How much of a viewer's IP address is kept. `full` shows the whole address on the dashboard and in stream history, `prefix` keeps only the network part (`203.0.113.x`, `2001:db8:1::/48`), and `none` records nothing. Server logs always carry the full address whatever this is set to.",
    env: 'STREAMS_CLIENT_IP_RECORDING',
    requiresRestart: false,
    secret: false,
    ui: { kind: 'enum' as const, options: ['full', 'prefix', 'none'] },
  },
  sessionIdleTimeout: {
    schema: seconds,
    default: 90,
    label: 'Stream idle timeout',
    description:
      'How long a stream may go without serving bytes before it is treated as finished and moved to history. Seeking and buffering pauses are shorter than this, so they keep the same entry; resuming after it counts as a new watch. Bandwidth totals are unaffected either way.',
    env: 'STREAMS_SESSION_IDLE_TIMEOUT',
    requiresRestart: false,
    secret: false,
  },
  connectionLimits: {
    schema: connectionLimitMap,
    default: {} as Record<string, number>,
    label: 'Connection limits',
    description:
      'How many streams may run at once, counted across the built-in proxy and the usenet engine together. Use `**` for one pool everyone shares, `*` for what each unlisted user gets individually, or a username for that user alone. `0` means unlimited.',
    // Second name is the pre-rename variable, undocumented but still honoured.
    env: ['STREAMS_CONNECTION_LIMITS', 'AIOSTREAMS_AUTH_CONNECTIONS_LIMIT'],
    requiresRestart: false,
    secret: false,
    ui: { kind: 'map' as const, mapWidth: 'wide-key' as const },
  },
  bandwidth: {
    periodMode: {
      schema: z.enum(['rolling', 'monthly']),
      default: 'rolling' as 'rolling' | 'monthly',
      label: 'Bandwidth period',
      description:
        'How the 30-day bandwidth figure (and any limits below) are measured. `rolling` counts the last 30 days at all times. `monthly` counts from a fixed reset day each month, matching how most providers meter a data cap.',
      env: 'STREAMS_BANDWIDTH_PERIOD_MODE',
      requiresRestart: false,
      secret: false,
      ui: { kind: 'enum' as const, options: ['rolling', 'monthly'] },
    },
    resetDay: {
      schema: z.union([z.number(), z.string()]).transform((value, ctx) => {
        const n = typeof value === 'string' ? Number(value.trim()) : value;
        if (!Number.isInteger(n) || n < 1 || n > 28) {
          ctx.addIssue({
            code: 'custom',
            message: `Reset day must be a whole number from 1 to 28, got ${JSON.stringify(value)}.`,
          });
          return z.NEVER;
        }
        return n;
      }),
      default: 1,
      label: 'Bandwidth reset day',
      description:
        'Day of the month the bandwidth period restarts when the period is set to `monthly`. Capped at 28 so every month has one.',
      env: 'STREAMS_BANDWIDTH_RESET_DAY',
      requiresRestart: false,
      secret: false,
      ui: { min: 1, max: 28 },
    },
    limits: {
      schema: bandwidthLimitMap,
      default: {} as Record<string, number>,
      label: 'Bandwidth limits',
      description:
        'How many bytes may be served per accounting period. Use `**` for one pool everyone shares, `*` for what each unlisted user gets individually, or a username for that user alone. Sizes accept units (e.g. `500GB`); `0` means unlimited. Reaching a limit stops the streams it covers and refuses new ones. Only bytes served through AIOStreams count, so direct, unproxied links are invisible to it.',
      env: 'STREAMS_BANDWIDTH_LIMITS',
      requiresRestart: false,
      secret: false,
      ui: {
        kind: 'map' as const,
        // The record's `number | string` values classify as `json`; sizes are
        // what operators actually want to type.
        mapValueKind: 'size' as const,
        mapWidth: 'wide-key' as const,
      },
    },
  },
} as const satisfies RuntimeConfigSection;
