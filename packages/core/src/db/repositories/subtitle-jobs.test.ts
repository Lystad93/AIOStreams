import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// Establish the package's canonical module init order before pulling the DB
// layer directly (avoids a logger<->tasks init-order quirk that surfaces only
// when db.js is the very first import under the test runner).
import '../../utils/crypto.js';
import { initDb, closeDb } from '../db.js';
import { SubtitleJobRepository } from './subtitle-jobs.js';

// Temp sqlite file; initDb runs all migrations (incl. 0017_subtitle_jobs).
const dbFile = path.join(
  os.tmpdir(),
  `aios-subtitle-test-${process.pid}.sqlite`
);
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

test('subtitle_jobs: write-through lifecycle + SRT download round-trip', async () => {
  const base = {
    id: 'job-1',
    uuid: 'user-a',
    contentId: 'tt42:1:2',
    releaseHash: 'rh1',
    sourcePath: 'exact',
    targetLang: 'Norwegian',
    provider: 'gemini',
    filename: 'Show.S01E02.1080p.mkv',
    videoSize: 3_000_000_000,
    createdAt: 1000,
    updatedAt: 1000,
  };

  // pending → running(+source) → extracted → translated(done)
  await SubtitleJobRepository.saveMeta({ ...base, status: 'pending' });
  await SubtitleJobRepository.saveMeta({
    ...base,
    status: 'running',
    sourceLang: 'English',
    updatedAt: 1100,
  });
  await SubtitleJobRepository.setExtractedSrt(
    'job-1',
    'EXTRACTED SRT',
    12,
    1200
  );
  await SubtitleJobRepository.setTranslatedSrt(
    'job-1',
    'TRANSLATED SRT',
    1300,
    45_000
  );
  await SubtitleJobRepository.saveMeta({
    ...base,
    status: 'done',
    sourceLang: 'English',
    updatedAt: 1300,
    completedAt: 1300,
  });

  const list = await SubtitleJobRepository.list();
  assert.equal(list.length, 1);
  const row = list[0];
  assert.equal(row.status, 'done');
  assert.equal(row.sourceLang, 'English');
  assert.equal(row.targetLang, 'Norwegian');
  assert.equal(row.cueCount, 12);
  assert.equal(row.filename, 'Show.S01E02.1080p.mkv');
  assert.equal(row.videoSize, 3_000_000_000);
  assert.equal(row.completedAt, 1300);
  assert.equal(row.durationMs, 45_000);
  // List must expose SRT presence via lengths, not bodies.
  assert.equal(row.extractedBytes, 'EXTRACTED SRT'.length);
  assert.equal(row.translatedBytes, 'TRANSLATED SRT'.length);

  const extracted = await SubtitleJobRepository.getSrt('job-1', 'extracted');
  assert.equal(extracted?.srt, 'EXTRACTED SRT');
  assert.equal(extracted?.filename, 'Show.S01E02.1080p.mkv');
  const translated = await SubtitleJobRepository.getSrt('job-1', 'translated');
  assert.equal(translated?.srt, 'TRANSLATED SRT');

  // Durable reuse check used by the slot builder.
  assert.equal(await SubtitleJobRepository.hasTranslated('job-1'), true);
  assert.equal(await SubtitleJobRepository.hasTranslated('nope'), false);

  assert.equal(await SubtitleJobRepository.count(), 1);

  await SubtitleJobRepository.delete('job-1');
  assert.equal(await SubtitleJobRepository.count(), 0);
  assert.equal(await SubtitleJobRepository.getSrt('job-1', 'extracted'), null);
});

test('subtitle_jobs: failed job stores error and no translated SRT', async () => {
  await SubtitleJobRepository.saveMeta({
    id: 'job-2',
    uuid: 'user-b',
    contentId: 'tt99',
    releaseHash: 'rh2',
    sourcePath: 'exact',
    targetLang: 'German',
    status: 'failed',
    error: 'bitmap only',
    createdAt: 2000,
    updatedAt: 2000,
  });
  const row = (await SubtitleJobRepository.list()).find(
    (r) => r.id === 'job-2'
  );
  assert.ok(row);
  assert.equal(row!.status, 'failed');
  assert.equal(row!.error, 'bitmap only');
  assert.equal(row!.translatedBytes, 0);
  assert.equal(await SubtitleJobRepository.getSrt('job-2', 'translated'), null);
  assert.equal(await SubtitleJobRepository.hasTranslated('job-2'), false);
});

test('filterTranslated: returns only ids with a stored translation', async () => {
  const base = {
    uuid: 'user-d',
    contentId: 'tt8',
    releaseHash: 'rh4',
    sourcePath: 'exact',
    targetLang: 'Norwegian',
    status: 'done',
    createdAt: 4000,
    updatedAt: 4000,
  };
  await SubtitleJobRepository.saveMeta({ ...base, id: 'has-srt' });
  await SubtitleJobRepository.setTranslatedSrt(
    'has-srt',
    'NOR SRT',
    4100,
    5000
  );
  // Row exists but never produced a translation (e.g. still running / failed).
  await SubtitleJobRepository.saveMeta({
    ...base,
    id: 'no-srt',
    status: 'running',
  });

  const found = await SubtitleJobRepository.filterTranslated([
    'has-srt',
    'no-srt',
    'never-seen',
  ]);
  assert.deepEqual([...found], ['has-srt']);
  // Empty input must not build an invalid `IN ()` query.
  assert.equal((await SubtitleJobRepository.filterTranslated([])).size, 0);

  // Non-empty input whose every name normalises away is the subtler version of
  // the same trap: `filenames` is non-empty but the derived match-key list is
  // empty, which SQLite tolerates as `IN ()` and Postgres rejects outright.
  assert.equal(
    (
      await SubtitleJobRepository.findTranslatedByFilenames(
        'u1',
        'tt1',
        'Norwegian',
        ['.mkv']
      )
    ).size,
    0
  );

  // Clean up: the `running` row would otherwise leak into the
  // markInterrupted test's expected count (tests share one DB).
  await SubtitleJobRepository.delete('has-srt');
  await SubtitleJobRepository.delete('no-srt');
});

test('findTranslatedByFilenames: matches the same release across addons, scoped per user/content/lang', async () => {
  const FILE = 'From.S01E08.2160p.STAN.WEB-DL-Kitsune.mkv';
  // Translated once, from addon A's copy (its own size → its own job id).
  await SubtitleJobRepository.saveMeta({
    id: 'addon-a',
    uuid: 'user-e',
    contentId: 'tt9:1:8',
    releaseHash: 'hash-from-addon-a',
    sourcePath: 'exact',
    targetLang: 'Norwegian',
    status: 'done',
    filename: FILE,
    videoSize: 5_605_356_873,
    createdAt: 5000,
    updatedAt: 5000,
  });
  await SubtitleJobRepository.setTranslatedSrt(
    'addon-a',
    'NOR SRT',
    5100,
    1000
  );

  // Addon B serves the same release; only the filename is shared.
  const hit = await SubtitleJobRepository.findTranslatedByFilenames(
    'user-e',
    'tt9:1:8',
    'Norwegian',
    [FILE]
  );
  assert.equal(hit.get(FILE), 'addon-a');

  // Sharing is the default: another user is served the same finished
  // translation rather than paying to redo it.
  assert.equal(
    (
      await SubtitleJobRepository.findTranslatedByFilenames(
        'someone-else',
        'tt9:1:8',
        'Norwegian',
        [FILE]
      )
    ).get(FILE),
    'addon-a'
  );

  // ...but an explicit owner scope still isolates (sharing turned off).
  assert.equal(
    (
      await SubtitleJobRepository.findTranslatedByFilenames(
        'someone-else',
        'tt9:1:8',
        'Norwegian',
        [FILE],
        'someone-else'
      )
    ).size,
    0
  );
  assert.equal(
    (
      await SubtitleJobRepository.findTranslatedByFilenames(
        'user-e',
        'tt9:1:8',
        'German',
        [FILE]
      )
    ).size,
    0
  );

  await SubtitleJobRepository.delete('addon-a');
});

test('findTranslatedByFilenames: matches other addons’ spellings of the release', async () => {
  const STORED = 'Spell.S02E03.2160p.WEB-DL.H.265-Kitsune.mkv';
  await SubtitleJobRepository.saveMeta({
    id: 'spell-1',
    uuid: 'user-f',
    contentId: 'tt11:2:3',
    releaseHash: 'rh-spell',
    sourcePath: 'exact',
    targetLang: 'Norwegian',
    status: 'done',
    filename: STORED,
    createdAt: 6000,
    updatedAt: 6000,
  });
  await SubtitleJobRepository.setTranslatedSrt('spell-1', 'NOR', 6100, 900);

  const spellings = [
    'Spell.S02E03.2160p.WEB-DL.H.265-Kitsune', // no extension
    'Spell S02E03 2160p WEB-DL H 265-Kitsune', // spaces
    'Spell%20S02E03%202160p%20WEB-DL%20H%20265-Kitsune', // percent-encoded
    'Spell.S02E03.2160p.WEB-DL.H.265-Kitsune-WtF', // re-upload
  ];
  for (const spelling of spellings) {
    const hit = await SubtitleJobRepository.findTranslatedByFilenames(
      'user-f',
      'tt11:2:3',
      'Norwegian',
      [spelling]
    );
    // Reported under the caller's spelling so the stream can be flagged.
    assert.equal(hit.get(spelling), 'spell-1', `missed: ${spelling}`);
  }

  // A genuinely different release must not match.
  assert.equal(
    (
      await SubtitleJobRepository.findTranslatedByFilenames(
        'user-f',
        'tt11:2:3',
        'Norwegian',
        ['Spell.S02E03.2160p.WEB-DL.H.265-XEBEC']
      )
    ).size,
    0
  );

  await SubtitleJobRepository.delete('spell-1');
});

test('markInterrupted: in-flight jobs are failed at startup, terminal ones untouched', async () => {
  const base = {
    uuid: 'user-c',
    contentId: 'tt7',
    releaseHash: 'rh3',
    sourcePath: 'exact',
    targetLang: 'Norwegian',
    createdAt: 3000,
    updatedAt: 3000,
  };
  // Two orphans (the bug: these showed as "running" forever after a restart)
  // plus one already-done job that must not be disturbed.
  await SubtitleJobRepository.saveMeta({
    ...base,
    id: 'stuck-running',
    status: 'running',
  });
  await SubtitleJobRepository.saveMeta({
    ...base,
    id: 'stuck-pending',
    status: 'pending',
  });
  await SubtitleJobRepository.saveMeta({
    ...base,
    id: 'already-done',
    status: 'done',
    completedAt: 3500,
  });

  const n = await SubtitleJobRepository.markInterrupted(9999);
  assert.equal(n, 2);

  const byId = new Map(
    (await SubtitleJobRepository.list()).map((r) => [r.id, r])
  );
  assert.equal(byId.get('stuck-running')!.status, 'failed');
  assert.match(byId.get('stuck-running')!.error!, /restart/i);
  assert.equal(byId.get('stuck-pending')!.status, 'failed');
  // A completed translation must survive reconciliation untouched.
  assert.equal(byId.get('already-done')!.status, 'done');

  // Idempotent: a second boot has nothing left to reconcile.
  assert.equal(await SubtitleJobRepository.markInterrupted(9999), 0);
});
