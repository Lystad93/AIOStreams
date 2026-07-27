import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// Establish the package's canonical module init order before pulling the DB
// layer directly (see subtitle-jobs.test.ts).
import '../../utils/crypto.js';
import { initDb, closeDb } from '../db.js';
import { SubtitleSourceRepository, sourceId } from './subtitle-sources.js';

const dbFile = path.join(os.tmpdir(), `aios-subsrc-test-${process.pid}.sqlite`);
before(async () => {
  await initDb(`sqlite://${dbFile}`);
});
after(async () => {
  await closeDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

const FILE = 'Show.S01E01.1080p.WEB-DL-GRP.mkv';

test('subtitle_sources: stores measured metadata and reuses across users', async () => {
  const id = sourceId({ filename: FILE, lang: 'English', origin: 'extracted' });
  await SubtitleSourceRepository.put({
    id,
    contentId: 'tt1:1:1',
    filename: FILE,
    videoSize: 5_000_000_000,
    lang: 'English',
    origin: 'extracted',
    trackIndex: 2,
    trackCodec: 'subrip',
    forced: false,
    hearingImpaired: false,
    durationMs: 2_700_000,
    fps: 23.976,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    cueCount: 800,
    firstCueMs: 1200,
    lastCueMs: 2_690_000,
    srt: 'ENGLISH SRT',
    createdBy: 'user-a',
    createdAt: 1000,
  });

  // Shared pool (no owner scope): another user finds user-a's extraction —
  // this is what lets them translate without re-downloading the file.
  const shared = await SubtitleSourceRepository.findByFilename(FILE);
  assert.equal(shared.length, 1);
  const meta = shared[0];
  assert.equal(meta.lang, 'English');
  assert.equal(meta.durationMs, 2_700_000); // primary cross-release match key
  assert.equal(meta.fps, 23.976); // decides whether retiming is needed
  assert.equal(meta.cueCount, 800);
  assert.equal(meta.trackCodec, 'subrip');
  assert.equal(await SubtitleSourceRepository.getSrt(id), 'ENGLISH SRT');

  // Private pool: scoped to the owner, so another user sees nothing.
  assert.equal(
    (await SubtitleSourceRepository.findByFilename(FILE, 'user-a')).length,
    1
  );
  assert.equal(
    (await SubtitleSourceRepository.findByFilename(FILE, 'user-b')).length,
    0
  );
});

test('subtitle_sources: re-extracting the same release upserts rather than duplicating', async () => {
  const id = sourceId({ filename: FILE, lang: 'English', origin: 'extracted' });
  await SubtitleSourceRepository.put({
    id,
    filename: FILE,
    lang: 'English',
    origin: 'extracted',
    forced: false,
    hearingImpaired: false,
    cueCount: 810,
    srt: 'UPDATED SRT',
    createdBy: 'user-b',
    createdAt: 2000,
  });
  const rows = await SubtitleSourceRepository.findByFilename(FILE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cueCount, 810);
  assert.equal(await SubtitleSourceRepository.getSrt(id), 'UPDATED SRT');
});

test('subtitle_sources: an upsert refreshes the track descriptors, not just the body', async () => {
  // Re-extraction can pick a different track (source-language priority changed,
  // or forced/SDH newly excluded). Updating the SRT while keeping the previous
  // track's flags would leave pickSource ranking on stale metadata.
  const FILE2 = 'Upsert.Descriptors.2160p.WEB-DL-GROUP.mkv';
  const id = sourceId({
    filename: FILE2,
    lang: 'English',
    origin: 'extracted',
  });
  await SubtitleSourceRepository.put({
    id,
    filename: FILE2,
    lang: 'English',
    origin: 'extracted',
    trackIndex: 2,
    trackTitle: 'Forced',
    forced: true,
    hearingImpaired: true,
    srt: 'FIRST',
    createdAt: 1000,
  });
  await SubtitleSourceRepository.put({
    id,
    filename: FILE2,
    lang: 'English',
    origin: 'extracted',
    trackIndex: 5,
    trackTitle: 'Full',
    forced: false,
    hearingImpaired: false,
    srt: 'SECOND',
    createdAt: 2000,
  });

  const [row] = await SubtitleSourceRepository.findByFilename(FILE2);
  assert.equal(await SubtitleSourceRepository.getSrt(id), 'SECOND');
  assert.equal(row.forced, false);
  assert.equal(row.hearingImpaired, false);
  assert.equal(row.trackIndex, 5);
  assert.equal(row.trackTitle, 'Full');
});

test('subtitle_sources: found under any addon spelling of the same release', async () => {
  const STORED = 'Alt.S01E02.1080p.WEB-DL.H.264-Kitsune.mkv';
  await SubtitleSourceRepository.put({
    id: sourceId({ filename: STORED, lang: 'English', origin: 'extracted' }),
    filename: STORED,
    lang: 'English',
    origin: 'extracted',
    forced: false,
    hearingImpaired: false,
    srt: 'SRT',
    createdAt: 4000,
  });

  // Every one of these is the same release, spelled differently by an addon.
  const spellings = [
    'Alt.S01E02.1080p.WEB-DL.H.264-Kitsune', // no extension
    'Alt S01E02 1080p WEB-DL H 264-Kitsune', // spaces
    'Alt%20S01E02%201080p%20WEB-DL%20H%20264-Kitsune', // percent-encoded
    'Alt.S01E02.1080p.WEB-DL.H.264-Kitsune-WtF', // re-upload tag
  ];
  for (const spelling of spellings) {
    const found = await SubtitleSourceRepository.findByFilename(spelling);
    assert.equal(found.length, 1, `not found for: ${spelling}`);
    assert.equal(found[0].lang, 'English');
    // filterWithSources reports the hit under the caller's own spelling.
    const set = await SubtitleSourceRepository.filterWithSources([spelling]);
    assert.ok(set.has(spelling), `filterWithSources missed: ${spelling}`);
  }

  // A different release group must NOT match.
  assert.equal(
    (
      await SubtitleSourceRepository.findByFilename(
        'Alt.S01E02.1080p.WEB-DL.H.264-XEBEC'
      )
    ).length,
    0
  );
});

test('subtitle_sources: different languages of one release coexist', async () => {
  await SubtitleSourceRepository.put({
    id: sourceId({ filename: FILE, lang: 'Danish', origin: 'extracted' }),
    filename: FILE,
    lang: 'Danish',
    origin: 'extracted',
    forced: false,
    hearingImpaired: false,
    srt: 'DANISH SRT',
    createdAt: 3000,
  });
  const langs = (await SubtitleSourceRepository.findByFilename(FILE))
    .map((r) => r.lang)
    .sort();
  assert.deepEqual(langs, ['Danish', 'English']);

  const withSources = await SubtitleSourceRepository.filterWithSources([
    FILE,
    'Other.mkv',
  ]);
  assert.deepEqual([...withSources], [FILE]);
  assert.equal((await SubtitleSourceRepository.filterWithSources([])).size, 0);
});
