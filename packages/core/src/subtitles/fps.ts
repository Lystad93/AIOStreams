/**
 * Framerate rescue: making a subtitle authored for one framerate usable on
 * another (spec §4.6, the retiming half).
 *
 * This is the one sync problem a constant offset cannot fix. A film mastered at
 * 23.976 and released at 25 (PAL speed-up) runs 4.27% shorter, so its subtitle
 * timings are compressed by the same factor. Shifting aligns the start or the
 * end, never both; over a two-hour feature the drift reaches several minutes.
 * The correction is multiplicative and exact — every timestamp scaled by the
 * ratio of the two framerates.
 *
 * Deliberately a LAST RESORT. A candidate that already matches by filename,
 * duration or a provider's own claim is better evidence than an inferred
 * framerate conversion, so this only ever rescues a subtitle that would
 * otherwise not be offered at all.
 */
import type { SrtCue } from './srt.js';

/** Framerates that actually occur in distribution. */
const KNOWN_FPS = [23.976, 24, 25, 29.97, 30] as const;

/**
 * Conversions worth attempting, as `[from, to]` framerate pairs.
 *
 * Restricted to real telecine/PAL relationships. An arbitrary ratio between two
 * unrelated framerates is not a conversion, it is a coincidence, and applying
 * it would silently mangle a subtitle that was merely mismatched.
 */
const CONVERSIONS: [number, number][] = [
  [25, 23.976],
  [23.976, 25],
  [25, 24],
  [24, 25],
  [24, 23.976],
  [23.976, 24],
  [30, 29.97],
  [29.97, 30],
  [29.97, 23.976],
  [23.976, 29.97],
];

/** How far a measured ratio may sit from a nominal one and still count. */
const RATIO_TOLERANCE = 0.002;
/**
 * Minimum distance from 1.0 for a conversion to be INFERABLE from runtimes.
 *
 * `24→23.976` and `30→29.97` differ by only 0.1%, which is closer to unity
 * than the tolerance itself — two equal-length files would otherwise be read
 * as needing a conversion. Those pairs are real, but they can only be
 * established from stated framerates, never guessed from duration.
 */
const MIN_INFERABLE_RATIO_DELTA = 0.01;

export interface FpsConversion {
  /** Multiply every subtitle timestamp by this. */
  factor: number;
  from: number;
  to: number;
  /** How it was established — `fps` is stated, `duration` is inferred. */
  basis: 'fps' | 'duration';
}

function snap(fps?: number): number | undefined {
  if (!fps || fps <= 0) return undefined;
  return KNOWN_FPS.find((k) => Math.abs(k - fps) < 0.05);
}

/**
 * Work out whether a subtitle needs retiming to fit the playing release.
 *
 * Two independent routes, and the duration one is the more trustworthy:
 * providers report `fps` inconsistently (often 0, sometimes the container's
 * value rather than the subtitle's), whereas a duration RATIO that lands on a
 * known conversion is hard to produce by accident.
 */
export function detectFpsConversion(opts: {
  subFps?: number;
  streamFps?: number;
  subDurationMs?: number;
  streamDurationMs?: number;
}): FpsConversion | undefined {
  // 1. Both framerates stated and a recognised pair.
  const from = snap(opts.subFps);
  const to = snap(opts.streamFps);
  if (from && to && from !== to) {
    const known = CONVERSIONS.some(([a, b]) => a === from && b === to);
    if (known) return { factor: from / to, from, to, basis: 'fps' };
  }

  // 2. Inferred from how the two runtimes relate. A subtitle authored for a
  // 25fps copy describes a file 4.27% shorter than the 23.976 one being
  // played, so the ratio of runtimes IS the conversion factor.
  const subMs = opts.subDurationMs;
  const streamMs = opts.streamDurationMs;
  if (subMs && streamMs && subMs > 0 && streamMs > 0) {
    const ratio = streamMs / subMs;
    for (const [a, b] of CONVERSIONS) {
      const nominal = a / b;
      if (Math.abs(nominal - 1) < MIN_INFERABLE_RATIO_DELTA) continue;
      if (Math.abs(ratio - nominal) <= RATIO_TOLERANCE) {
        return { factor: nominal, from: a, to: b, basis: 'duration' };
      }
    }
  }
  return undefined;
}

/**
 * Rescale cue timings by a constant factor, preserving text and order.
 *
 * Only the timeline changes — the same reasoning as the translation path, where
 * timings are never round-tripped through anything that might reinterpret them.
 */
export function rescaleCues(cues: SrtCue[], factor: number): SrtCue[] {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return cues;
  return cues.map((cue) => ({
    ...cue,
    startMs: Math.max(0, Math.round(cue.startMs * factor)),
    endMs: Math.max(0, Math.round(cue.endMs * factor)),
  }));
}

/** `25→23.976`, for the row's detail line. */
export function describeConversion(c: FpsConversion): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3));
  return `${fmt(c.from)}→${fmt(c.to)}`;
}
