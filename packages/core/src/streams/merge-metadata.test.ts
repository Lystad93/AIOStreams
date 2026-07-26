import { test } from 'node:test';
import assert from 'node:assert/strict';
// Establish the package's canonical module init order before pulling anything
// that constructs a logger (see subtitle-jobs.test.ts).
import '../utils/crypto.js';
import {
  orderByTrust,
  trustRank,
  pickMergedDuration,
} from './merge-metadata.js';
import type { ParsedStream } from '../db/schemas.js';

const HOUR_42 = 102 * 60 * 1000;

function src(
  name: string,
  duration?: number,
  extra: Record<string, unknown> = {}
): ParsedStream {
  return {
    id: name,
    addon: {
      name,
      preset: { id: name.toLowerCase(), type: 'preset' },
      ...extra,
    },
    duration,
  } as unknown as ParsedStream;
}

test('trustRank: listed addons rank by position, unlisted rank last', () => {
  const trusted = ['Alpha', 'Beta'];
  assert.equal(trustRank(src('Alpha'), trusted), 0);
  assert.equal(trustRank(src('Beta'), trusted), 1);
  // Unlisted is a ranking, not an exclusion.
  assert.equal(trustRank(src('Gamma'), trusted), 2);
});

test('trustRank: matches on name, preset type or instance id, case-insensitively', () => {
  assert.equal(trustRank(src('MyAddon'), ['myaddon']), 0);
  assert.equal(trustRank(src('Whatever'), ['preset']), 0); // preset.type
  const byInstance = {
    id: 'x',
    addon: { name: 'N', instanceId: 'inst-1', preset: { id: 'p', type: 't' } },
  } as unknown as ParsedStream;
  assert.equal(trustRank(byInstance, ['inst-1']), 0);
});

test('orderByTrust: trusted first in configured order, others keep their order', () => {
  const streams = [src('Untrusted'), src('Beta'), src('Alpha'), src('Other')];
  const ordered = orderByTrust(streams, ['Alpha', 'Beta']);
  assert.deepEqual(
    ordered.map((s) => s.addon!.name),
    ['Alpha', 'Beta', 'Untrusted', 'Other']
  );
  // No trusted list configured → untouched.
  assert.deepEqual(orderByTrust(streams, []), streams);
  assert.deepEqual(orderByTrust(streams, undefined), streams);
});

test('pickMergedDuration: takes the first reported runtime', () => {
  const picked = pickMergedDuration([
    src('A', undefined),
    src('B', 0),
    src('C', HOUR_42),
  ]);
  assert.equal(picked, HOUR_42);
});

test('pickMergedDuration: refuses a value equal to the TMDB runtime', () => {
  // The one detectable sign an addon echoed the catalogue figure instead of
  // measuring its own file.
  assert.equal(pickMergedDuration([src('A', HOUR_42)], HOUR_42), undefined);
  // ...but a genuinely different runtime is still adopted.
  assert.equal(
    pickMergedDuration([src('A', HOUR_42 + 37_000)], HOUR_42),
    HOUR_42 + 37_000
  );
  // ...and it falls through to the next source rather than giving up.
  assert.equal(
    pickMergedDuration(
      [src('A', HOUR_42), src('B', HOUR_42 + 12_000)],
      HOUR_42
    ),
    HOUR_42 + 12_000
  );
});

test('pickMergedDuration: nothing to take', () => {
  assert.equal(pickMergedDuration([]), undefined);
  assert.equal(pickMergedDuration([src('A'), src('B', 0)]), undefined);
});

test('trust order decides which runtime wins', () => {
  // The end-to-end intent: a trusted addon's runtime is preferred, but an
  // untrusted one still fills the gap when no trusted source reported it.
  const sources = [src('Untrusted', 111_000), src('Good', 222_000)];
  assert.equal(pickMergedDuration(orderByTrust(sources, ['Good'])), 222_000);
  assert.equal(
    pickMergedDuration(orderByTrust([src('Untrusted', 333_000)], ['Good'])),
    333_000
  );
});
