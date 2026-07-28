import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../utils/crypto.js';
import { detectFpsConversion, rescaleCues, describeConversion } from './fps.js';
import { parseSrt, serializeSrt } from './srt.js';

test('detects a PAL speed-up from stated framerates', () => {
  const c = detectFpsConversion({ subFps: 25, streamFps: 23.976 });
  assert.ok(c);
  assert.equal(c.basis, 'fps');
  assert.equal(c.from, 25);
  assert.equal(c.to, 23.976);
  // 4.27% — the subtitle's timings must stretch to reach the longer file.
  assert.ok(Math.abs(c.factor - 1.0427) < 0.0005);
});

test('infers the same conversion from the runtime ratio alone', () => {
  // Providers report fps inconsistently, so the ratio is the better signal.
  const streamMs = 6_808_000; // 1h53m28s at 23.976
  const subMs = Math.round(streamMs / (25 / 23.976)); // the 25fps copy
  const c = detectFpsConversion({
    subDurationMs: subMs,
    streamDurationMs: streamMs,
  });
  assert.ok(c);
  assert.equal(c.basis, 'duration');
  assert.equal(c.from, 25);
  assert.equal(c.to, 23.976);
});

test('a ratio that is not a real conversion is left alone', () => {
  // Two unrelated releases whose runtimes merely differ. Applying a made-up
  // factor here would mangle a subtitle that was only mismatched.
  assert.equal(
    detectFpsConversion({
      subDurationMs: 6_808_000,
      streamDurationMs: 5_000_000,
    }),
    undefined
  );
  // Equal runtimes need no conversion at all.
  assert.equal(
    detectFpsConversion({
      subDurationMs: 6_808_000,
      streamDurationMs: 6_808_000,
    }),
    undefined
  );
  // Same framerate both sides.
  assert.equal(detectFpsConversion({ subFps: 25, streamFps: 25 }), undefined);
  // An unrecognised framerate is not snapped to a neighbour.
  assert.equal(
    detectFpsConversion({ subFps: 47, streamFps: 23.976 }),
    undefined
  );
  assert.equal(detectFpsConversion({}), undefined);
});

test('rescaling stretches timings and touches nothing else', () => {
  const cues = parseSrt(
    '1\n00:00:10,000 --> 00:00:12,000\nHello\n\n2\n01:00:00,000 --> 01:00:02,000\nLater\n'
  );
  const factor = 25 / 23.976;
  const out = rescaleCues(cues, factor);

  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'Hello');
  assert.equal(out[1].text, 'Later');
  assert.equal(out[0].startMs, Math.round(10_000 * factor));
  // An hour in, the correction is already ~2m34s — which is exactly why a
  // constant offset cannot fix this class of mismatch.
  const driftMs = out[1].startMs - cues[1].startMs;
  assert.ok(driftMs > 150_000 && driftMs < 160_000, String(driftMs));

  // Still valid SRT afterwards.
  const reparsed = parseSrt(serializeSrt(out));
  assert.equal(reparsed[0].startMs, out[0].startMs);
});

test('rescaling is a no-op for a meaningless factor', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  for (const f of [1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(rescaleCues(cues, f), cues, String(f));
  }
});

test('describeConversion reads like the framerates it names', () => {
  assert.equal(
    describeConversion({ factor: 1.0427, from: 25, to: 23.976, basis: 'fps' }),
    '25→23.976'
  );
});
