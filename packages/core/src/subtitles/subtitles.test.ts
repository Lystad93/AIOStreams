import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, serializeSrt } from './srt.js';
import { encodeSubtitleToken, decodeSubtitleToken } from './token.js';
import { releaseHash } from './release-lookup.js';
import { estimateEtaSeconds } from './pipeline.js';
import { pickTrack } from './extract.js';
import { reassembleTranslations } from './translate.js';
import { isStaleJob, blocksNewAttempt } from './job-store.js';
import { pickSource } from './sources.js';
import { normaliseReleaseName } from './release-name.js';
import type { SubtitleSourceMeta } from '../db/repositories/subtitle-sources.js';
import type { ProbedSubtitleTrack, SubtitleJob } from './types.js';

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

test('pickTrack: excluding a kind means no subtitle, not the wrong one', () => {
  // The case demotion alone gets wrong: the only text track is forced, so
  // sorting would still hand it back.
  const onlyForced: ProbedSubtitleTrack[] = [
    { index: 0, codec: 'subrip', isText: true, language: 'nor', forced: true },
  ];
  assert.ok(pickTrack(onlyForced, ['Norwegian']));
  assert.equal(
    pickTrack(onlyForced, ['Norwegian'], { forced: false }),
    undefined
  );

  const onlySdh: ProbedSubtitleTrack[] = [
    {
      index: 0,
      codec: 'subrip',
      isText: true,
      language: 'nor',
      hearingImpaired: true,
    },
  ];
  assert.equal(
    pickTrack(onlySdh, ['Norwegian'], { hearingImpaired: false }),
    undefined
  );

  // With an acceptable alternative present, exclusion just moves past it.
  const mixed: ProbedSubtitleTrack[] = [
    ...onlyForced,
    { index: 1, codec: 'subrip', isText: true, language: 'nor' },
  ];
  assert.equal(pickTrack(mixed, ['Norwegian'], { forced: false })?.index, 1);
});

test('pickTrack: returns undefined when only bitmap tracks exist', () => {
  const tracks: ProbedSubtitleTrack[] = [
    { index: 0, codec: 'dvd_subtitle', isText: false, language: 'eng' },
  ];
  assert.equal(pickTrack(tracks, ['English']), undefined);
});

test('reassembleTranslations: maps by index and keeps originals for skipped lines', () => {
  const originals = ['one', 'two', 'three', 'four'];
  // Model dropped index 2 and returned them out of order.
  const items = [
    { i: 1, t: 'to' },
    { i: 0, t: 'en' },
    { i: 3, t: 'fire' },
  ];
  const { lines, missing } = reassembleTranslations(originals, items);
  assert.deepEqual(lines, ['en', 'to', 'three', 'fire']); // index 2 kept original
  assert.equal(missing, 1);
});

test('reassembleTranslations: ignores out-of-range/garbage indices, unescapes \\n', () => {
  const { lines, missing } = reassembleTranslations(
    ['a', 'b'],
    [
      { i: 0, t: 'x\\ny' },
      { i: 9, t: 'ignored' },
      { i: -1, t: 'ignored' },
      { t: 'no index' } as any,
    ]
  );
  assert.equal(lines[0], 'x\ny');
  assert.equal(lines[1], 'b'); // untouched
  assert.equal(missing, 1);
});

test('normaliseReleaseName: all addon spellings of one release share a key', () => {
  const canonical = normaliseReleaseName(
    'From.S01E08.Broken.Windows.Open.Doors.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune.mkv'
  );
  // Same release, as reported by other addons:
  const variants = [
    // no extension
    'From.S01E08.Broken.Windows.Open.Doors.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune',
    // spaces instead of dots
    'From S01E08 Broken Windows Open Doors 2160p STAN WEB-DL DDP5 1 H 265-Kitsune',
    // percent-encoded spaces
    'From%20S01E08%20Broken%20Windows%20Open%20Doors%202160p%20STAN%20WEB-DL%20DDP5%201%20H%20265-Kitsune',
    // re-upload tag appended
    'From.S01E08.Broken.Windows.Open.Doors.2160p.STAN.WEB-DL.DDP5.1.H.265-Kitsune-WtF',
    // re-upload tag AND no extension AND different case
    'from.s01e08.broken.windows.open.doors.2160p.stan.web-dl.ddp5.1.h.265-kitsune-wtf.mkv',
    // underscores
    'From_S01E08_Broken_Windows_Open_Doors_2160p_STAN_WEB-DL_DDP5_1_H_265-Kitsune',
  ];
  for (const v of variants) {
    assert.equal(normaliseReleaseName(v), canonical, `variant failed: ${v}`);
  }
});

test('normaliseReleaseName: must NOT merge different release groups', () => {
  // The dangerous case a structural "drop last dash token" rule would break:
  // these are different releases and must keep different keys.
  const a = normaliseReleaseName('FROM.S01E08.2160p.MGMP.WEB-DL.H.265-XEBEC');
  const b = normaliseReleaseName('From.S01E08.2160p.STAN.WEB-DL.H.265-Kitsune');
  assert.notEqual(a, b);
  // A real group must survive even when the name ends in WEB-DL-<group>.
  const withDashDl = normaliseReleaseName('Show.2020.1080p.WEB-DL-Kitsune');
  assert.ok(withDashDl.endsWith('-kitsune'), withDashDl);
  assert.notEqual(
    withDashDl,
    normaliseReleaseName('Show.2020.1080p.WEB-DL-XEBEC')
  );
  // Different cuts stay distinct.
  assert.notEqual(
    normaliseReleaseName('Movie.2026.1080p-GRP'),
    normaliseReleaseName('Movie.2026.EXTENDED.1080p-GRP')
  );
});

test('normaliseReleaseName: handles empty/garbage input', () => {
  assert.equal(normaliseReleaseName(undefined), '');
  assert.equal(normaliseReleaseName(''), '');
  assert.equal(normaliseReleaseName('   '), '');
  // Malformed percent-encoding must not throw.
  assert.equal(normaliseReleaseName('Bad%ZZ.Name.mkv'), 'bad%zz name');
});

test('pickSource: honours the user-ordered language priority, demotes forced/SDH', () => {
  const mk = (over: Partial<SubtitleSourceMeta>): SubtitleSourceMeta =>
    ({
      id:
        over.lang! +
        (over.forced ? '-f' : '') +
        (over.hearingImpaired ? '-s' : ''),
      filename: 'X.mkv',
      lang: 'English',
      origin: 'extracted',
      forced: false,
      hearingImpaired: false,
      createdAt: 0,
      ...over,
    }) as SubtitleSourceMeta;

  const pool = [
    mk({ lang: 'English' }),
    mk({ lang: 'Danish' }),
    mk({ lang: 'Danish', forced: true }),
  ];

  // A Norwegian user preferring Danish over English (spec §4.4) must get Danish.
  assert.equal(pickSource(pool, ['Danish', 'English'])?.lang, 'Danish');
  // ...and reversing the priority order flips the choice.
  assert.equal(pickSource(pool, ['English', 'Danish'])?.lang, 'English');
  // The plain Danish track wins over the forced one.
  assert.equal(pickSource(pool, ['Danish'])?.forced, false);
  // No preference expressed → still returns something usable.
  assert.ok(pickSource(pool, []));
  assert.equal(pickSource([], ['English']), undefined);
});

const HOUR = 60 * 60 * 1000;
const baseJob = (over: Partial<SubtitleJob>): SubtitleJob => ({
  uuid: 'u',
  contentId: 'tt1:1:1',
  releaseHash: 'rh',
  sourcePath: 'exact',
  targetLang: 'Norwegian',
  status: 'running',
  etaSeconds: 600,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

test('isStaleJob: a job orphaned by a restart is eventually considered dead', () => {
  const now = 10 * HOUR;
  // Running but untouched for hours → stale (the process that owned it is gone).
  assert.equal(isStaleJob(baseJob({ updatedAt: now - 3 * HOUR }), now), true);
  // Recently updated → genuinely in flight, not stale.
  assert.equal(isStaleJob(baseJob({ updatedAt: now - 60_000 }), now), false);
  // Terminal states are never "stale".
  assert.equal(
    isStaleJob(baseJob({ status: 'done', updatedAt: 0 }), now),
    false
  );
  assert.equal(
    isStaleJob(baseJob({ status: 'failed', updatedAt: 0 }), now),
    false
  );
});

test('blocksNewAttempt: stale or failed jobs must not block a retry', () => {
  const now = 10 * HOUR;
  // The regression this guards: a job orphaned mid-flight by a container
  // restart previously made that file permanently un-translatable.
  assert.equal(
    blocksNewAttempt(baseJob({ updatedAt: now - 3 * HOUR }), now),
    false
  );
  assert.equal(
    blocksNewAttempt(baseJob({ status: 'failed', updatedAt: now }), now),
    false
  );
  // A genuinely running job still de-duplicates.
  assert.equal(
    blocksNewAttempt(baseJob({ updatedAt: now - 60_000 }), now),
    true
  );
  // A finished job blocks too — the stored result is served instead.
  assert.equal(
    blocksNewAttempt(baseJob({ status: 'done', updatedAt: now }), now),
    true
  );
});

test('estimateEtaSeconds: grows with file size, has a floor', () => {
  const small = estimateEtaSeconds({ fileSizeBytes: 100 * 1024 * 1024 });
  const large = estimateEtaSeconds({ fileSizeBytes: 20 * 1024 * 1024 * 1024 });
  assert.ok(large > small);
  assert.ok(small >= 120); // translation seed floor
});
