/**
 * AI translation of extracted subtitles (spec §4.4).
 *
 * Rules baked in from the spec:
 *  - Never round-trip raw SRT through the model — timestamps/numbering get
 *    mangled. We send a plain indexed text array and re-marry the translated
 *    strings to the ORIGINAL cue timings here.
 *  - Batch/chunk for context-window limits on long files.
 *  - Carry a running glossary (names, recurring terms) across chunks for
 *    consistency.
 *  - Translation uses the user's OWN API key (BYO, spec §7).
 *
 * The provider is pluggable ({@link TranslationProvider}); the first concrete
 * adapter is Google Gemini.
 */
import { createLogger } from '../logging/logger.js';
import * as constants from '../utils/constants.js';
import type { SrtCue } from './srt.js';

const logger = createLogger('subtitles');

export interface TranslationRequest {
  cues: SrtCue[];
  /** Source language name/code for the prompt (e.g. `English`, `en`). */
  sourceLang?: string;
  /** Target language the user wants (e.g. `Norwegian`, `nor`). */
  targetLang: string;
  apiKey: string;
  /** Provider-specific model id. */
  model?: string;
}

/**
 * Why a provider call failed, which decides what failover does.
 *
 * `quota` and `server` are the cases another provider can plausibly satisfy;
 * `auth` cannot be fixed by retrying but still shouldn't sink the job when a
 * working provider is configured behind it, so it also fails over — just
 * loudly, since a bad key is a configuration mistake worth surfacing.
 */
export type TranslationErrorKind = 'quota' | 'auth' | 'server' | 'other';

export class TranslationError extends Error {
  constructor(
    message: string,
    readonly kind: TranslationErrorKind,
    readonly provider: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

/** Map an HTTP status onto the failover decision. */
export function classifyStatus(status: number): TranslationErrorKind {
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  // 400 from these APIs is usually "quota exhausted" dressed as a bad request
  // (Gemini free tier does exactly this), so it is not treated as fatal.
  return 'other';
}

export interface TranslationProvider {
  readonly id: string;
  /**
   * Translate a batch of plain strings, index-aligned with the input. MUST
   * return exactly one output per input, in order. `glossary` carries agreed
   * translations of recurring terms so far; the provider may extend it.
   */
  translateBatch(
    lines: string[],
    ctx: {
      sourceLang?: string;
      targetLang: string;
      apiKey: string;
      model?: string;
      /** Overrides the provider's default endpoint (OpenAI-compatible hosts). */
      baseUrl?: string;
      glossary: Record<string, string>;
    }
  ): Promise<{ lines: string[]; glossary?: Record<string, string> }>;
}

/** Cues per model call. Kept modest so one bad batch is cheap to retry. */
const BATCH_SIZE = 80;

const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

/**
 * The one translation prompt, shared by every adapter.
 *
 * Keeping it in one place matters for failover: when provider B picks up where
 * A stopped mid-file, both must have been given identical instructions, or the
 * register and terminology visibly shift halfway through the subtitle.
 */
export function buildTranslationPrompt(
  lines: string[],
  ctx: {
    sourceLang?: string;
    targetLang: string;
    glossary: Record<string, string>;
  }
): string {
  const glossaryLines = Object.entries(ctx.glossary)
    .slice(0, 200)
    .map(([k, v]) => `- ${k} => ${v}`)
    .join('\n');

  return [
    `You are a professional subtitle translator.`,
    `Translate each numbered subtitle line${
      ctx.sourceLang ? ` from ${ctx.sourceLang}` : ''
    } into ${ctx.targetLang}.`,
    `Preserve meaning, tone and register. Keep line breaks (\\n) inside a cue.`,
    `Return one object per input line as {"i": <the line number>, "t": "<translation>"}, reusing the SAME line number. Do not merge, split, renumber, add, or drop lines.`,
    `Do not translate proper nouns that are normally left untranslated.`,
    glossaryLines
      ? `Use these agreed term translations for consistency:\n${glossaryLines}`
      : '',
    `Return ONLY a JSON object of the form {"translations":[{"i":0,"t":"..."}],"glossary":[{"term":"...","translation":"..."}]}.`,
    ``,
    `Lines:`,
    ...lines.map((l, i) => `${i}: ${l.replace(/\n/g, '\\n')}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pull `{translations, glossary}` out of a model's text response. */
function parseTranslationJson(
  raw: string,
  provider: string
): {
  translations?: { i?: number; t?: string }[];
  glossary?: { term: string; translation: string }[];
} {
  // Models that can't be forced into JSON mode often wrap it in a fence or add
  // a sentence before it, so isolate the outermost object rather than failing.
  const cleaned = raw.replace(/^\s*```(?:json)?|```\s*$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate =
    start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new TranslationError(
      `${provider} returned unparseable JSON`,
      'other',
      provider
    );
  }
}

/**
 * Google Gemini adapter. Uses the `generateContent` REST endpoint with a JSON
 * response schema so we get a clean `{ translations: string[] }` back instead
 * of parsing free text.
 */
export const geminiProvider: TranslationProvider = {
  id: 'gemini',
  async translateBatch(lines, ctx) {
    const model = ctx.model || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`;

    const prompt = buildTranslationPrompt(lines, {
      sourceLang: ctx.sourceLang,
      targetLang: ctx.targetLang,
      glossary: ctx.glossary,
    });

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  i: { type: 'integer' },
                  t: { type: 'string' },
                },
                required: ['i', 't'],
              },
            },
            glossary: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  term: { type: 'string' },
                  translation: { type: 'string' },
                },
                required: ['term', 'translation'],
              },
            },
          },
          required: ['translations'],
        },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new TranslationError(
        `Gemini request failed (${res.status}): ${text.slice(0, 400)}`,
        // Gemini reports an exhausted free tier as 429 with `limit: 0`, and
        // sometimes as 400 — treat an explicit quota mention as quota either way
        // so failover kicks in rather than the job dying.
        /quota|rate.?limit|resource.?exhausted/i.test(text)
          ? 'quota'
          : classifyStatus(res.status),
        'gemini',
        res.status
      );
    }

    const json: any = await res.json();
    const raw: string | undefined =
      json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      const reason = json?.candidates?.[0]?.finishReason ?? 'no content';
      throw new TranslationError(
        `Gemini returned no text (${reason})`,
        'other',
        'gemini'
      );
    }

    return finishBatch('gemini', lines, parseTranslationJson(raw, 'gemini'));
  },
};

/**
 * Reassemble indexed translations onto the original lines. Missing indices keep
 * the original text (graceful degradation); out-of-range/duplicate indices are
 * ignored. Returns the count of lines left untranslated.
 */
export function reassembleTranslations(
  originals: string[],
  items: { i?: number; t?: string }[]
): { lines: string[]; missing: number } {
  const out = originals.slice();
  const filled = new Array(originals.length).fill(false);
  for (const item of items) {
    const i = item?.i;
    if (
      typeof i === 'number' &&
      Number.isInteger(i) &&
      i >= 0 &&
      i < out.length &&
      typeof item.t === 'string'
    ) {
      out[i] = item.t.replace(/\\n/g, '\n');
      filled[i] = true;
    }
  }
  const missing = filled.filter((f) => !f).length;
  return { lines: out, missing };
}

/** Shared tail of every adapter: map indexed output back onto the originals. */
function finishBatch(
  provider: string,
  lines: string[],
  parsed: {
    translations?: { i?: number; t?: string }[];
    glossary?: { term: string; translation: string }[];
  }
): { lines: string[]; glossary: Record<string, string> } {
  const { lines: mapped, missing } = reassembleTranslations(
    lines,
    parsed.translations ?? []
  );
  if (missing > 0) {
    logger.debug(
      { provider, expected: lines.length, missing },
      'some subtitle lines were not translated; kept original text'
    );
  }
  const glossary: Record<string, string> = {};
  for (const g of parsed.glossary ?? []) {
    if (g?.term && g?.translation) glossary[g.term] = g.translation;
  }
  return { lines: mapped, glossary };
}

/**
 * OpenAI chat-completions adapter, shared by OpenAI, OpenRouter, Groq, DeepSeek
 * and any self-hosted OpenAI-compatible endpoint — they differ only in base URL
 * and model id, so one implementation covers all of them.
 */
export function openAiCompatibleProvider(
  id: string,
  defaults: { baseUrl: string; model: string }
): TranslationProvider {
  return {
    id,
    async translateBatch(lines, ctx) {
      const baseUrl = (ctx.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
      if (!baseUrl) {
        throw new TranslationError(`${id} needs a base URL`, 'other', id);
      }
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.apiKey}`,
        },
        body: JSON.stringify({
          model: ctx.model || defaults.model,
          temperature: 0.3,
          // Honoured by OpenAI/DeepSeek/Groq; harmlessly ignored elsewhere,
          // which is why parseTranslationJson still tolerates prose and fences.
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: buildTranslationPrompt(lines, {
                sourceLang: ctx.sourceLang,
                targetLang: ctx.targetLang,
                glossary: ctx.glossary,
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TranslationError(
          `${id} request failed (${res.status}): ${text.slice(0, 400)}`,
          /quota|rate.?limit|insufficient.?(quota|balance)/i.test(text)
            ? 'quota'
            : classifyStatus(res.status),
          id,
          res.status
        );
      }

      const json: any = await res.json();
      const raw: string | undefined = json?.choices?.[0]?.message?.content;
      if (!raw) {
        throw new TranslationError(
          `${id} returned no content (${json?.choices?.[0]?.finish_reason ?? 'unknown'})`,
          'other',
          id
        );
      }
      return finishBatch(id, lines, parseTranslationJson(raw, id));
    },
  };
}

/** Anthropic Messages API adapter. */
export const anthropicProvider: TranslationProvider = {
  id: 'anthropic',
  async translateBatch(lines, ctx) {
    const baseUrl = (ctx.baseUrl || 'https://api.anthropic.com/v1').replace(
      /\/+$/,
      ''
    );
    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ctx.model || 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: buildTranslationPrompt(lines, {
              sourceLang: ctx.sourceLang,
              targetLang: ctx.targetLang,
              glossary: ctx.glossary,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new TranslationError(
        `Anthropic request failed (${res.status}): ${text.slice(0, 400)}`,
        /rate.?limit|quota|credit/i.test(text)
          ? 'quota'
          : classifyStatus(res.status),
        'anthropic',
        res.status
      );
    }

    const json: any = await res.json();
    const raw: string | undefined = json?.content?.[0]?.text;
    if (!raw) {
      throw new TranslationError(
        `Anthropic returned no content (${json?.stop_reason ?? 'unknown'})`,
        'other',
        'anthropic'
      );
    }
    return finishBatch(
      'anthropic',
      lines,
      parseTranslationJson(raw, 'anthropic')
    );
  },
};

const PROVIDERS: Record<string, TranslationProvider> = {
  [geminiProvider.id]: geminiProvider,
  [anthropicProvider.id]: anthropicProvider,
};
for (const [id, meta] of Object.entries(constants.TRANSLATION_PROVIDERS)) {
  if (meta.api !== 'openai') continue;
  PROVIDERS[id] = openAiCompatibleProvider(id, {
    baseUrl: meta.baseUrl,
    model: meta.defaultModel,
  });
}

export function getTranslationProvider(id: string): TranslationProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown translation provider: ${id}`);
  return p;
}

/**
 * Translate all cues: strip to text, chunk, translate each chunk carrying the
 * glossary forward, then re-marry translated text onto the original timings.
 * Timing is never touched, so the exact-file path (§4.2) stays in sync by
 * construction (spec §4.4).
 */
export async function translateCues(
  req: TranslationRequest,
  provider: TranslationProvider = geminiProvider
): Promise<SrtCue[]> {
  return translateCuesWithFailover(req.cues, {
    sourceLang: req.sourceLang,
    targetLang: req.targetLang,
    providers: [
      {
        provider,
        apiKey: req.apiKey,
        model: req.model,
      },
    ],
  });
}

/** One configured provider attempt, in priority order. */
export interface TranslationAttempt {
  provider: TranslationProvider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Translate every cue, falling over to the next configured provider when one
 * refuses.
 *
 * Failover is per BATCH, not per file: if the first provider does batches 1–3
 * and is then rate-limited, the second picks up at batch 4 rather than
 * restarting. That preserves the work already paid for, and — because the
 * accumulated glossary carries across the handover — keeps names and recurring
 * terms consistent either side of the switch.
 *
 * Once a provider fails it is dropped for the rest of the file: a quota that
 * just ran out will not have refilled a few seconds later, and retrying it per
 * batch would stall every remaining batch behind the same timeout.
 */
export async function translateCuesWithFailover(
  cues: SrtCue[],
  opts: {
    sourceLang?: string;
    targetLang: string;
    providers: TranslationAttempt[];
  }
): Promise<SrtCue[]> {
  if (opts.providers.length === 0) {
    throw new Error('No translation provider is configured');
  }
  const out: SrtCue[] = new Array(cues.length);
  const glossary: Record<string, string> = {};
  const remaining = [...opts.providers];
  const failures: string[] = [];

  for (let start = 0; start < cues.length; start += BATCH_SIZE) {
    const slice = cues.slice(start, start + BATCH_SIZE);
    let done = false;

    while (!done) {
      const attempt = remaining[0];
      if (!attempt) {
        throw new Error(
          `All translation providers failed: ${failures.join('; ')}`
        );
      }
      try {
        const { lines, glossary: extra } =
          await attempt.provider.translateBatch(
            slice.map((c) => c.text),
            {
              sourceLang: opts.sourceLang,
              targetLang: opts.targetLang,
              apiKey: attempt.apiKey,
              model: attempt.model,
              baseUrl: attempt.baseUrl,
              glossary,
            }
          );
        Object.assign(glossary, extra ?? {});
        slice.forEach((cue, i) => {
          // Keep original timings + index; swap only the text.
          out[start + i] = { ...cue, text: lines[i] ?? cue.text };
        });
        done = true;
      } catch (err) {
        const kind =
          err instanceof TranslationError ? err.kind : ('other' as const);
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${attempt.provider.id}: ${message}`);
        remaining.shift();
        logger.warn(
          {
            provider: attempt.provider.id,
            kind,
            batchStart: start,
            fallbacksLeft: remaining.length,
            err: message,
          },
          remaining.length > 0
            ? 'translation provider failed; falling over to the next'
            : 'translation provider failed and no fallback remains'
        );
      }
    }

    logger.debug(
      {
        done: Math.min(start + BATCH_SIZE, cues.length),
        total: cues.length,
        provider: remaining[0]?.provider.id,
      },
      'translated subtitle batch'
    );
  }

  return out;
}
