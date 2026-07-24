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
      glossary: Record<string, string>;
    }
  ): Promise<{ lines: string[]; glossary?: Record<string, string> }>;
}

/** Cues per model call. Kept modest so one bad batch is cheap to retry. */
const BATCH_SIZE = 80;

const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

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

    const glossaryLines = Object.entries(ctx.glossary)
      .slice(0, 200)
      .map(([k, v]) => `- ${k} => ${v}`)
      .join('\n');

    const prompt = [
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
      `Return ONLY JSON matching the schema.`,
      ``,
      `Lines:`,
      ...lines.map((l, i) => `${i}: ${l.replace(/\n/g, '\\n')}`),
    ]
      .filter(Boolean)
      .join('\n');

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
      throw new Error(
        `Gemini request failed (${res.status}): ${text.slice(0, 400)}`
      );
    }

    const json: any = await res.json();
    const raw: string | undefined =
      json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      const reason = json?.candidates?.[0]?.finishReason ?? 'no content';
      throw new Error(`Gemini returned no text (${reason})`);
    }

    let parsed: {
      translations?: { i?: number; t?: string }[];
      glossary?: { term: string; translation: string }[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Gemini returned unparseable JSON');
    }

    // Map translations back to their original index. Resilient to the model
    // merging/dropping a line: any index it skips keeps the original text
    // rather than failing (or misaligning) the whole subtitle.
    const { lines: mapped, missing } = reassembleTranslations(
      lines,
      parsed.translations ?? []
    );
    if (missing > 0) {
      logger.debug(
        { returned: parsed.translations?.length ?? 0, expected: lines.length, missing },
        'some subtitle lines were not translated; kept original text'
      );
    }

    const glossary: Record<string, string> = {};
    for (const g of parsed.glossary ?? []) {
      if (g?.term && g?.translation) glossary[g.term] = g.translation;
    }

    return { lines: mapped, glossary };
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

const PROVIDERS: Record<string, TranslationProvider> = {
  [geminiProvider.id]: geminiProvider,
};

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
  const { cues } = req;
  const out: SrtCue[] = new Array(cues.length);
  const glossary: Record<string, string> = {};

  for (let start = 0; start < cues.length; start += BATCH_SIZE) {
    const slice = cues.slice(start, start + BATCH_SIZE);
    const { lines, glossary: extra } = await provider.translateBatch(
      slice.map((c) => c.text),
      {
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        apiKey: req.apiKey,
        model: req.model,
        glossary,
      }
    );
    Object.assign(glossary, extra ?? {});
    slice.forEach((cue, i) => {
      // Keep original timings + index; swap only the text.
      out[start + i] = { ...cue, text: lines[i] ?? cue.text };
    });
    logger.debug(
      { done: Math.min(start + BATCH_SIZE, cues.length), total: cues.length },
      'translated subtitle batch'
    );
  }

  return out;
}
