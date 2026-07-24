import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, serializeSrt } from './srt.js';
import { encodeSubtitleToken, decodeSubtitleToken } from './token.js';
import { releaseHash } from './release-lookup.js';
import { estimateEtaSeconds } from './pipeline.js';
import { pickTrack } from './extract.js';
import type { ProbedSubtitleTrack } from './types.js';

test('parseSrt: tolerates CRLF, multiline cues, and preserves timings', () => {
  const input =
    '1\r\n00:00:00,500 --> 00:00:02,000\r\nHello, world.\r\n\r\n' +
    '2\n00:00:02,500 --> 00:00:04,000\nLine one\nLine two\n';
  const cues = parseSrt(input);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 500);
  assert.equal(cues[0].endMs, 2000);
  assert.equal(cues[0].text, 'Hello, world.');
  assert.equal(cues[1].text, 'Line one\nLine two');
});

test('parseSrt: accepts VTT-style dot separator and 2-digit fractions', () => {
  const cues = parseSrt('1\n00:00:01.50 --> 00:00:02.00\nHi\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1500);
  assert.equal(cues[0].endMs, 2000);
});

test('serializeSrt: renumbers and swaps text while keeping timings (translation re-marry)', () => {
  const cues = parseSrt('7\n00:00:00,500 --> 00:00:02,000\nhola\n');
  const translated = cues.map((c) => ({ ...c, text: 'hello' }));
  const out = serializeSrt(translated);
  assert.match(out, /^1\n00:00:00,500 --> 00:00:02,000\nhello/);
  // Round-trips back to the same timing.
  const reparsed = parseSrt(out);
  assert.equal(reparsed[0].startMs, 500);
  assert.equal(reparsed[0].text, 'hello');
});

test('subtitle token: round-trips and rejects garbage', () => {
  const payload = {
    uuid: 'abc',
    encryptedPassword: 'enc',
    contentId: 'tt1:1:2',
    targetLang: 'nor',
    sourcePath: 'exact' as const,
    videoSize: 12345,
    filename: 'Show.S01E02.mkv',
  };
  const token = encodeSubtitleToken(payload);
  assert.ok(token, 'token should encode');
  const decoded = decodeSubtitleToken(token!);
  assert.deepEqual(decoded, payload);
  assert.equal(decodeSubtitleToken('not-a-real-token'), undefined);
});

test('releaseHash: stable and identity-sensitive', () => {
  const a = releaseHash({ size: 100, filename: 'x.mkv' });
  const b = releaseHash({ size: 100, filename: 'x.mkv' });
  const c = releaseHash({ size: 101, filename: 'x.mkv' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('pickTrack: matches UI language names against ffprobe ISO codes; skips bitmap', () => {
  const tracks: ProbedSubtitleTrack[] = [
    { index: 0, codec: 'hdmv_pgs_subtitle', isText: false, language: 'eng' },
    { index: 1, codec: 'subrip', isText: true, language: 'eng' },
    { index: 2, codec: 'subrip', isText: true, language: 'nor' },
  ];
  // User prefers Norwegian (display name) — must select the "nor" track, not
  // the bitmap track and not English.
  const picked = pickTrack(tracks, ['Norwegian', 'English']);
  assert.equal(picked?.index, 2);
  assert.equal(picked?.codec, 'subrip');

  // Forced/SDH demotion and fallback when preferred lang absent.
  const noPref = pickTrack(tracks, ['Japanese']);
  assert.ok(noPref?.isText); // still returns a text track
});

test('pickTrack: returns undefined when only bitmap tracks exist', () => {
  const tracks: ProbedSubtitleTrack[] = [
    { index: 0, codec: 'dvd_subtitle', isText: false, language: 'eng' },
  ];
  assert.equal(pickTrack(tracks, ['English']), undefined);
});

test('estimateEtaSeconds: grows with file size, has a floor', () => {
  const small = estimateEtaSeconds({ fileSizeBytes: 100 * 1024 * 1024 });
  const large = estimateEtaSeconds({ fileSizeBytes: 20 * 1024 * 1024 * 1024 });
  assert.ok(large > small);
  assert.ok(small >= 120); // translation seed floor
});
