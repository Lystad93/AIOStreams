import { test } from 'node:test';
import assert from 'node:assert/strict';
// Canonical module init order before anything constructs a logger.
import '../utils/crypto.js';
import {
  classifyStatus,
  translateCuesWithFailover,
  TranslationError,
  type TranslationProvider,
} from './translate.js';
import { resolveTranslationProviders } from './slots.js';
import type { SrtCue } from './srt.js';
import type { UserData } from '../db/schemas.js';

/** `n` cues, enough to span more than one batch when n > 80. */
function cues(n: number): SrtCue[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `line ${i}`,
  }));
}

/** A provider that succeeds, or fails from a given batch onwards. */
function fakeProvider(
  id: string,
  opts: { failFromCall?: number; kind?: 'quota' | 'auth' | 'server' } = {}
): TranslationProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async translateBatch(lines: string[]) {
      p.calls++;
      if (opts.failFromCall != null && p.calls >= opts.failFromCall) {
        throw new TranslationError(
          `${id} exhausted`,
          opts.kind ?? 'quota',
          id,
          429
        );
      }
      return { lines: lines.map((l) => `${id}:${l}`) };
    },
  };
  return p;
}

test('classifyStatus: maps HTTP status onto the failover decision', () => {
  assert.equal(classifyStatus(429), 'quota');
  assert.equal(classifyStatus(401), 'auth');
  assert.equal(classifyStatus(403), 'auth');
  assert.equal(classifyStatus(503), 'server');
  assert.equal(classifyStatus(400), 'other');
});

test('failover: the second provider takes over and the first is not retried', async () => {
  // 200 cues = 3 batches of 80. Primary dies on its 2nd call.
  const primary = fakeProvider('a', { failFromCall: 2 });
  const backup = fakeProvider('b');

  const out = await translateCuesWithFailover(cues(200), {
    targetLang: 'Norwegian',
    providers: [
      { provider: primary, apiKey: 'k1' },
      { provider: backup, apiKey: 'k2' },
    ],
  });

  assert.equal(out.length, 200);
  // Batch 1 came from the primary; the rest from the backup.
  assert.equal(out[0].text, 'a:line 0');
  assert.equal(out[80].text, 'b:line 80');
  assert.equal(out[199].text, 'b:line 199');
  // The primary is dropped after failing rather than retried per batch.
  assert.equal(primary.calls, 2);
  assert.equal(backup.calls, 2);
});

test('failover: work already done is kept, not restarted', async () => {
  const primary = fakeProvider('a', { failFromCall: 3 });
  const backup = fakeProvider('b');
  const out = await translateCuesWithFailover(cues(240), {
    targetLang: 'Norwegian',
    providers: [
      { provider: primary, apiKey: 'k1' },
      { provider: backup, apiKey: 'k2' },
    ],
  });
  // First two batches survive from the primary — the backup only redoes the
  // batch that actually failed.
  assert.equal(out[0].text, 'a:line 0');
  assert.equal(out[79].text, 'a:line 79');
  assert.equal(out[80].text, 'a:line 80');
  assert.equal(out[160].text, 'b:line 160');
});

test('failover: timings and cue count are never altered', async () => {
  const original = cues(100);
  const out = await translateCuesWithFailover(original, {
    targetLang: 'Norwegian',
    providers: [
      { provider: fakeProvider('a', { failFromCall: 2 }), apiKey: 'k1' },
      { provider: fakeProvider('b'), apiKey: 'k2' },
    ],
  });
  assert.equal(out.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(out[i].startMs, original[i].startMs);
    assert.equal(out[i].endMs, original[i].endMs);
  }
});

test('failover: an auth failure also falls over, it does not sink the job', async () => {
  const out = await translateCuesWithFailover(cues(10), {
    targetLang: 'Norwegian',
    providers: [
      {
        provider: fakeProvider('a', { failFromCall: 1, kind: 'auth' }),
        apiKey: 'bad',
      },
      { provider: fakeProvider('b'), apiKey: 'good' },
    ],
  });
  assert.equal(out[0].text, 'b:line 0');
});

test('failover: exhausting every provider reports each failure', async () => {
  await assert.rejects(
    translateCuesWithFailover(cues(10), {
      targetLang: 'Norwegian',
      providers: [
        { provider: fakeProvider('a', { failFromCall: 1 }), apiKey: 'k1' },
        { provider: fakeProvider('b', { failFromCall: 1 }), apiKey: 'k2' },
      ],
    }),
    (err: Error) => {
      assert.match(err.message, /All translation providers failed/);
      // Both are named, so the dashboard error says what actually went wrong.
      assert.match(err.message, /a: a exhausted/);
      assert.match(err.message, /b: b exhausted/);
      return true;
    }
  );
});

test('failover: no providers configured is an error, not a silent pass', async () => {
  await assert.rejects(
    translateCuesWithFailover(cues(1), {
      targetLang: 'Norwegian',
      providers: [],
    }),
    /No translation provider is configured/
  );
});

test('resolveTranslationProviders: order kept, unusable entries dropped', () => {
  const userData = {
    subtitleTranslation: {
      providers: [
        { id: 'groq', enabled: true, apiKey: ' gk ', model: ' m ' },
        { id: 'gemini', enabled: false, apiKey: 'gk2' }, // disabled
        { id: 'openai', enabled: true, apiKey: '   ' }, // key is blank
        { id: 'anthropic', enabled: true, apiKey: 'ak' },
      ],
    },
  } as unknown as UserData;

  const out = resolveTranslationProviders(userData);
  assert.deepEqual(
    out.map((p) => p.id),
    ['groq', 'anthropic']
  );
  // Values are trimmed so a stray space can't break an auth header.
  assert.equal(out[0].apiKey, 'gk');
  assert.equal(out[0].model, 'm');
});

test('resolveTranslationProviders: falls back to the legacy single provider', () => {
  const legacy = {
    subtitleTranslation: { provider: 'gemini', apiKey: 'k', model: 'flash' },
  } as unknown as UserData;
  assert.deepEqual(resolveTranslationProviders(legacy), [
    { id: 'gemini', apiKey: 'k', model: 'flash' },
  ]);

  // An empty provider list must not shadow a working legacy config.
  const both = {
    subtitleTranslation: { providers: [], provider: 'gemini', apiKey: 'k' },
  } as unknown as UserData;
  assert.equal(resolveTranslationProviders(both).length, 1);

  // Nothing configured at all.
  assert.deepEqual(resolveTranslationProviders({} as UserData), []);
});
