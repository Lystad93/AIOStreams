/**
 * Minimal SRT (SubRip) codec. The translation step never round-trips raw SRT
 * through the LLM — it strips cues to plain indexed text, translates, then
 * re-marries the translated strings to the ORIGINAL timings (spec §4.4). These
 * helpers are that split/join boundary.
 *
 * We normalise ASS/WebVTT to SRT at extraction time (ffmpeg does the container
 * work), so this parser only has to understand SubRip.
 */

export interface SrtCue {
  /** 1-based cue number as written in the file. */
  index: number;
  /** Inclusive start, milliseconds. */
  startMs: number;
  /** Exclusive end, milliseconds. */
  endMs: number;
  /** Cue text; may contain the SRT-internal newline between wrapped lines. */
  text: string;
}

const TIME = String.raw`(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})`;
const CUE_TIMING = new RegExp(`${TIME}\\s*-->\\s*${TIME}`);

function toMs(h: string, m: string, s: string, ms: string): number {
  // Pad/truncate fractional part to exactly 3 digits (SRT uses ms; some tools
  // emit VTT-style `.` and 2- or 3-digit fractions).
  const frac = (ms + '000').slice(0, 3);
  return (
    Number(h) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1_000 +
    Number(frac)
  );
}

function fmtTime(totalMs: number): string {
  const clamped = Math.max(0, Math.round(totalMs));
  const ms = clamped % 1000;
  const totalSec = (clamped - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(ms).padStart(3, '0')}`;
}

/**
 * Parse SRT text into cues. Tolerant of CRLF, a leading BOM, blank runs, and
 * missing/renumbered indices (we re-derive the index from position if the line
 * before the timing isn't a bare integer).
 */
export function parseSrt(input: string): SrtCue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    // Find the timing line; the index (if any) is the line right before it.
    let timingLineIdx = -1;
    let timing: RegExpMatchArray | null = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CUE_TIMING);
      if (m) {
        timingLineIdx = i;
        timing = m;
        break;
      }
    }
    if (!timing || timingLineIdx === -1) continue;

    const startMs = toMs(timing[1], timing[2], timing[3], timing[4]);
    const endMs = toMs(timing[5], timing[6], timing[7], timing[8]);
    const body = lines
      .slice(timingLineIdx + 1)
      .join('\n')
      .trim();
    if (!body) continue;

    const maybeIndex = Number(lines[timingLineIdx - 1]?.trim());
    const index = Number.isInteger(maybeIndex) ? maybeIndex : cues.length + 1;

    cues.push({ index, startMs, endMs, text: body });
  }

  return cues;
}

/** Serialise cues back to SRT, renumbering sequentially from 1. */
export function serializeSrt(cues: SrtCue[]): string {
  return (
    cues
      .map((cue, i) => {
        const n = i + 1;
        return `${n}\n${fmtTime(cue.startMs)} --> ${fmtTime(
          cue.endMs
        )}\n${cue.text}`;
      })
      .join('\n\n') + '\n'
  );
}
