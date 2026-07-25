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
const dbFile = path.join(os.tmpdir(), `aios-subtitle-test-${process.pid}.sqlite`);
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
  await SubtitleJobRepository.setExtractedSrt('job-1', 'EXTRACTED SRT', 12, 1200);
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
  const row = (await SubtitleJobRepository.list()).find((r) => r.id === 'job-2');
  assert.ok(row);
  assert.equal(row!.status, 'failed');
  assert.equal(row!.error, 'bitmap only');
  assert.equal(row!.translatedBytes, 0);
  assert.equal(await SubtitleJobRepository.getSrt('job-2', 'translated'), null);
  assert.equal(await SubtitleJobRepository.hasTranslated('job-2'), false);
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
