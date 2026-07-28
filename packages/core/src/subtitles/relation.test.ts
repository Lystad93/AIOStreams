import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../utils/crypto.js';
import {
  classifyRelation,
  compareDuration,
  evaluateCandidate,
  parseReleaseMeta,
  scoreFor,
} from './relation.js';
import {
  buildLabel,
  buildDescription,
  formatDuration,
  langCode3,
} from './render.js';
import { normaliseReleaseName } from './release-name.js';

const STREAM = 'Supergirl.2026.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR.mkv';

// ---------------------------------------------------------------- §1 normalize

test('normalize: the three stated spellings collapse to one key', () => {
  const expected = 'supergirl 2026 2160p it web-dl ddp5 1 dv hdr h 265-byndr';
  for (const v of [
    'Supergirl.2026.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR.mkv',
    'Supergirl.2026.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR',
    'Supergirl 2026 2160p iT WEB-DL DDP5 1 DV HDR H 265-BYNDR',
  ]) {
    assert.equal(normaliseReleaseName(v), expected, v);
  }
});

test('normalize: only an allowlisted final segment is treated as an extension', () => {
  // `...H.265-BYNDR` has no extension; a naive last-dot strip would eat it.
  assert.ok(
    normaliseReleaseName('Show.2026.H.265-BYNDR').endsWith('265-byndr')
  );
  // Hyphens survive, carrying WEB-DL and the group boundary.
  assert.ok(normaliseReleaseName(STREAM).includes('web-dl'));
});

// ------------------------------------------------------------- §4 identity gate

test('identity gate: a contradiction rejects rather than scoring low', () => {
  const other = classifyRelation(
    'Supergirl.2026.S01E06.1080p.WEB-DL-BYNDR.mkv',
    'Supergirl.2026.S01E05.2160p.WEB-DL-BYNDR.mkv'
  );
  assert.equal(other.rejected, true);
});

test('identity gate: absent is not a mismatch — season packs survive', () => {
  const pack = classifyRelation(
    'Supergirl.S01.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR',
    'Supergirl.S01E05.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR.mkv'
  );
  assert.equal(pack.rejected, false);
  assert.equal(pack.seasonPack, true);
  assert.equal(pack.seasonLabel, 'S01');
});

// ------------------------------------------------------------------- §5 duration

test('compareDuration: tolerance and the three unknown sub-states', () => {
  assert.equal(compareDuration(1_000_000, 1_001_500), 'EQUAL'); // within 2s
  assert.equal(compareDuration(1_000_000, 1_010_000), 'UNEQUAL');
  assert.equal(compareDuration(undefined, undefined), 'UNKNOWN_BOTH');
  assert.equal(compareDuration(undefined, 1_000), 'UNKNOWN_SUB');
  assert.equal(compareDuration(1_000, undefined), 'UNKNOWN_STREAM');
});

// --------------------------------------------------------------- §6 score matrix

test('score matrix: every published cell', () => {
  const cells: [
    Parameters<typeof scoreFor>[0],
    Parameters<typeof scoreFor>[1],
    number,
  ][] = [
    ['IDENTICAL', 'EQUAL', 100],
    ['IDENTICAL', 'UNKNOWN_BOTH', 100],
    ['IDENTICAL', 'UNEQUAL', 90],
    ['COSMETIC', 'EQUAL', 100],
    ['COSMETIC', 'UNKNOWN_BOTH', 95],
    ['COSMETIC', 'UNEQUAL', 60],
    ['MATERIAL', 'EQUAL', 90],
    ['MATERIAL', 'UNKNOWN_BOTH', 70],
    ['MATERIAL', 'UNEQUAL', 50],
    ['UNRELATED', 'EQUAL', 90],
    ['UNRELATED', 'UNKNOWN_BOTH', 50],
    ['UNRELATED', 'UNEQUAL', 40],
  ];
  for (const [rel, dur, want] of cells) {
    assert.equal(scoreFor(rel, dur), want, `${rel}/${dur}`);
  }
});

test('embedded extraction bypasses the matrix and is always 100', () => {
  const r = evaluateCandidate({ embedded: true, streamFilename: STREAM });
  assert.equal(r.score, 100);
});

// ------------------------------------------------------------- §8 worked examples

test('§8A: network difference with equal durations scores 90', () => {
  const r = evaluateCandidate({
    subFilename: 'Supergirl.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-BYNDR.mkv',
    streamFilename: STREAM,
    subDurationMs: 3_000_000,
    streamDurationMs: 3_000_000,
  });
  assert.equal(r.relation, 'MATERIAL'); // network is Tier H
  assert.equal(r.duration, 'EQUAL');
  assert.equal(r.score, 90);
  // The subtitle's network is surfaced; the stream's competing value is not.
  assert.match(buildDescription(r, { provider: 'subdl' }), /\(\+AMZN\)/);
  assert.ok(!buildDescription(r, { provider: 'subdl' }).includes('IT)'));
});

test('§8B: cosmetic-only difference with no durations scores 95', () => {
  const r = evaluateCandidate({
    subFilename: 'Supergirl.2026.1080p.iT.WEB-DL.DDP5.1.H.264-BYNDR.mkv',
    streamFilename: STREAM,
  });
  assert.equal(r.relation, 'COSMETIC');
  assert.equal(r.score, 95);
  assert.equal(
    buildDescription(r, { provider: 'subdl' }),
    '95%(?)(≠enc)(SubDL)'
  );
});

test('§8C: exact match with no duration scores 100 and shows no diffs', () => {
  const r = evaluateCandidate({ subFilename: STREAM, streamFilename: STREAM });
  assert.equal(r.relation, 'IDENTICAL');
  assert.equal(r.score, 100);
  assert.equal(
    buildDescription(r, { provider: 'subsource' }),
    '100%(?)(SubSource)'
  );
});

test('§8E: exact filename with contradictory durations stays at 90', () => {
  // Trust the filename; surface the flag rather than collapsing to 50.
  const r = evaluateCandidate({
    subFilename: STREAM,
    streamFilename: STREAM,
    subDurationMs: 6_808_000,
    streamDurationMs: 6_628_000,
  });
  assert.equal(r.score, 90);
  assert.equal(
    buildDescription(r, { provider: 'opensubtitles' }),
    '90%(X 1h53m28s)(OpenSub)'
  );
});

test('§8F: unresolved season pack of the identical release scores 90', () => {
  const r = evaluateCandidate({
    subFilename: 'Supergirl.S01.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR',
    streamFilename:
      'Supergirl.S01E05.2160p.iT.WEB-DL.DDP5.1.DV.HDR.H.265-BYNDR.mkv',
  });
  assert.equal(r.seasonPack, true);
  // A pack has no meaningful runtime, so duration is forced unknown...
  assert.equal(r.duration, 'UNKNOWN_SUB');
  // ...and the flat penalty applies on top of its own field score.
  assert.equal(r.score, 90);
  assert.equal(
    buildDescription(r, { provider: 'subdl' }),
    '90%(S01)(?)(SubDL)'
  );
});

test('a subtitle with no filename is UNRELATED; only duration lifts it', () => {
  const blind = evaluateCandidate({ streamFilename: STREAM });
  assert.equal(blind.relation, 'UNRELATED');
  assert.equal(blind.score, 50);

  const byDuration = evaluateCandidate({
    streamFilename: STREAM,
    subDurationMs: 3_000_000,
    streamDurationMs: 3_000_000,
  });
  assert.equal(byDuration.score, 90);
});

// -------------------------------------------------------------------- §7 render

test('label grammar: rank prefix and languages only', () => {
  // Everything quantitative moved to the detail line; the header is what the
  // player renders largest, and at that size only the languages read well.
  assert.equal(
    buildLabel({ targetLang: 'Norwegian', sourceLang: 'English', rank: 1 }),
    '1# NOR<ENG'
  );
  assert.equal(
    buildLabel({ targetLang: 'Norwegian', sourceLang: 'Swedish', rank: 3 }),
    '3# NOR<SWE'
  );
  assert.equal(buildLabel({ sourceLang: 'English', rank: 2 }), '2# ENG');
  // A lone candidate carries no number.
  assert.equal(buildLabel({ sourceLang: 'English' }), 'ENG');
  assert.equal(buildLabel({ sourceLang: 'English', rank: 0 }), 'ENG');
  // Same language both sides collapses to one code.
  assert.equal(
    buildLabel({ targetLang: 'Norwegian', sourceLang: 'Norwegian', rank: 1 }),
    '1# NOR'
  );
});

test('description carries the score, ETA and rank-suffixed source', () => {
  const r = evaluateCandidate({ subFilename: STREAM, streamFilename: STREAM });
  assert.equal(
    buildDescription(
      { ...r, score: r.score },
      { provider: 'subdl', rank: 2, etaText: '~2m' }
    ),
    '100% (~2m)(?)(SubDL-2)'
  );
  // Providers keep their own casing.
  assert.equal(
    buildDescription(
      { ...r, score: r.score },
      { provider: 'opensubtitles', rank: 1 }
    ),
    '100%(?)(OpenSub-1)'
  );
  assert.equal(
    buildDescription(
      { ...r, score: r.score },
      { provider: 'subsource', rank: 3 }
    ),
    '100%(?)(SubSource-3)'
  );
  // Machine-translated sources are flagged before being translated again.
  assert.match(
    buildDescription(
      { ...r, score: r.score },
      { provider: 'subdl', rank: 1, machineSource: true }
    ),
    /\(MT\)/
  );
});

test('language codes are ISO 639-2/B, not the terminology set', () => {
  assert.equal(langCode3('German'), 'GER'); // not DEU
  assert.equal(langCode3('French'), 'FRE'); // not FRA
  assert.equal(langCode3('Dutch'), 'DUT'); // not NLD
  assert.equal(langCode3('Norwegian'), 'NOR');
});

test('duration formatting drops colons and scales down', () => {
  assert.equal(formatDuration(6_808_000), '1h53m28s');
  assert.equal(formatDuration(3_208_000), '53m28s');
  assert.equal(formatDuration(28_000), '28s');
});

test('description: groups concatenate with no separator and none are empty', () => {
  const r = evaluateCandidate({ subFilename: STREAM, streamFilename: STREAM });
  const desc = buildDescription(r, { provider: 'subdl' });
  assert.ok(!desc.includes('()'));
  assert.ok(!desc.includes(')-('));
});

test('parseReleaseMeta: IMAX is routed to editions, not visual tags', () => {
  const meta = parseReleaseMeta('Movie.2026.IMAX.2160p.WEB-DL.H.265-GRP.mkv');
  assert.ok(!meta.visualTags.includes('imax'));
  assert.ok(meta.editionTag.includes('imax'));
});
