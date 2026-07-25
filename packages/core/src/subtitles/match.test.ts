import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRelease, matchesEpisode, durationsMatch } from './match.js';
import { readZipEntries, subtitleEntries } from './providers/zip.js';
import { deflateRawSync, crc32 } from 'node:zlib';

test('scoreRelease: a moviehash match is the only automatic 100', () => {
  const r = scoreRelease('Whatever.mkv', ['Something.Else'], {
    moviehashMatched: true,
  });
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'exact-file');
});

test('scoreRelease: identical release (any addon spelling) scores exact-release', () => {
  const ours = 'From.S01E08.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune.mkv';
  for (const claimed of [
    'From.S01E08.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune',
    'From S01E08 2160p STAN WEB-DL DDP5 1 H 265-Kitsune',
    'From.S01E08.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune-WtF',
  ]) {
    const r = scoreRelease(ours, [claimed]);
    assert.equal(r.tier, 'exact-release', claimed);
    assert.equal(r.score, 100, claimed);
  }
});

test('scoreRelease: a different release of the same episode scores partial, never 100', () => {
  // Real case from the live API: ours is 2160p STAN, theirs 1080p AMZN.
  const r = scoreRelease(
    'From.S01E08.Broken.Windows.Open.Doors.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune.mkv',
    ['From.S01E08.1080p.AMZN.WEB-DL.DDP5.1.H.264-TEPES']
  );
  assert.equal(r.tier, 'similar');
  assert.ok(r.score > 0 && r.score < 100, `score was ${r.score}`);
});

test('scoreRelease: takes the best of several claimed releases', () => {
  const ours = 'Show.S01E01.1080p.WEB-DL-GRP.mkv';
  const r = scoreRelease(ours, [
    'Totally.Unrelated.Thing',
    'Show.S01E01.1080p.WEB-DL-GRP',
  ]);
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'exact-release');
});

test('scoreRelease: handles a missing filename without throwing', () => {
  assert.equal(scoreRelease(undefined, ['Anything']).score, 0);
  assert.equal(scoreRelease('Ours.mkv', []).score, 0);
});

test('matchesEpisode: recognises SxxExx and NxN, rejects neighbours', () => {
  const want = { season: 1, episode: 8 };
  assert.ok(matchesEpisode('From.S01E08.1080p-GRP.srt', want));
  assert.ok(matchesEpisode('From.s1e8.srt', want));
  assert.ok(matchesEpisode('From 1x08.srt', want));
  assert.ok(!matchesEpisode('From.S01E09.1080p-GRP.srt', want));
  assert.ok(!matchesEpisode('From.S02E08.1080p-GRP.srt', want));
  // Must not confuse E8 with E80.
  assert.ok(!matchesEpisode('From.S01E80.srt', want));
  // With no episode wanted, everything matches.
  assert.ok(matchesEpisode('anything.srt', {}));
});

const TOL = { toleranceSeconds: 60, tolerancePercent: 0.5 };

test('durationsMatch: identical runtimes match, unknown runtimes never do', () => {
  const twoHours = 2 * 60 * 60 * 1000;
  assert.ok(durationsMatch(twoHours, twoHours, TOL));
  // 0 / undefined mean "not reported" — never treat that as agreement.
  assert.ok(!durationsMatch(twoHours, 0, TOL));
  assert.ok(!durationsMatch(0, 0, TOL));
  assert.ok(!durationsMatch(twoHours, undefined, TOL));
  assert.ok(!durationsMatch(undefined, undefined, TOL));
});

test('durationsMatch: absorbs minute-level rounding but not a different cut', () => {
  const base = 102 * 60 * 1000; // 1h42m
  // Addon descriptions are minute-granular, so a 1-minute disagreement between
  // two reports of the same film must still match.
  assert.ok(durationsMatch(base, base + 60_000, TOL));
  // A theatrical vs extended cut differs by far more and must NOT match.
  assert.ok(!durationsMatch(base, base + 20 * 60_000, TOL));
});

test('durationsMatch: percentage term takes over for long runtimes', () => {
  const fourHours = 4 * 60 * 60 * 1000;
  // 0.5% of 4h = 72s, which is wider than the 60s floor.
  assert.ok(durationsMatch(fourHours, fourHours + 70_000, TOL));
  assert.ok(!durationsMatch(fourHours, fourHours + 200_000, TOL));
});

test('scoreRelease: the real-world HDR-token case scores partial by name alone', () => {
  // These two differ only by an `HDR` token but are genuinely different files;
  // the name score is honest about that, which is why duration is needed as a
  // separate signal.
  const r = scoreRelease(
    'Backrooms.2026.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-BYNDR',
    ['Backrooms.2026.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.H.265-BYNDR']
  );
  assert.equal(r.tier, 'similar');
  assert.ok(r.score >= 50 && r.score < 100, `score was ${r.score}`);
});

test('scoreRelease: a 60fps AI remux scores low by name — duration must carry it', () => {
  const r = scoreRelease(
    'Backrooms.2026.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-BYNDR',
    [
      'Backrooms.2026.2160p.60fps.REMUX.HEVC..AI.RIFE.DV.HDR10.DDP.5.1.ATMOS.V2-WoodrowsPoo69&Bigboy2k',
    ]
  );
  // Deliberately not asserting a high score: the point is that name similarity
  // alone would hide this result, so the duration signal has to surface it.
  assert.equal(r.tier, 'similar');
  assert.ok(r.score < 100);
});

/** Build a real ZIP in memory so the reader is tested against actual bytes. */
function makeZip(files: { name: string; body: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.body, 'utf8');
    const comp = deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test('zip reader: inflates entries and filters to subtitle files', () => {
  const zip = makeZip([
    {
      name: 'Show.S01E08.1080p-GRP.srt',
      body: '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
    },
    { name: 'Show.S01E09.1080p-GRP.srt', body: 'nine' },
    { name: '__MACOSX/._Show.S01E08.srt', body: 'junk' },
    { name: 'readme.nfo', body: 'not a subtitle' },
  ]);

  const all = readZipEntries(zip);
  assert.equal(all.length, 4);

  const subs = subtitleEntries(all);
  // macOS resource forks and non-subtitle files are excluded.
  assert.deepEqual(
    subs.map((e) => e.name),
    ['Show.S01E08.1080p-GRP.srt', 'Show.S01E09.1080p-GRP.srt']
  );
  assert.match(
    subs[0].read().toString('utf8'),
    /00:00:01,000 --> 00:00:02,000/
  );
  assert.equal(subs[1].read().toString('utf8'), 'nine');
});

test('zip reader: rejects non-ZIP input clearly', () => {
  assert.throws(
    () => readZipEntries(Buffer.from('this is not a zip file at all')),
    /not a zip/i
  );
});
