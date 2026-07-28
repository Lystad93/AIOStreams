/**
 * The vocabulary for subtitle-row rendering.
 *
 * Deliberately a leaf module with no imports: the settings UI needs these
 * names, and pulling them out of `render.ts` would drag the server-only config
 * and logger chain into the browser bundle.
 */

export const HEADER_TOKENS = [
  'rank',
  'langCode',
  'languages',
  'score',
  'eta',
] as const;
export const DETAIL_TOKENS = [
  'score',
  'eta',
  'state',
  'pack',
  'duration',
  'diffs',
  'mt',
  'fps',
  'source',
] as const;

export type HeaderToken = (typeof HEADER_TOKENS)[number];
export type DetailToken = (typeof DETAIL_TOKENS)[number];

export const DEFAULT_HEADER: HeaderToken[] = ['rank', 'languages'];
export const DEFAULT_DETAIL: DetailToken[] = [
  'score',
  'eta',
  'state',
  'pack',
  'duration',
  'diffs',
  'mt',
  'fps',
  'source',
];

/** Human-facing names + one-line explanations, reused by the settings UI. */
export const TOKEN_DETAILS: Record<
  string,
  { name: string; description: string }
> = {
  rank: { name: 'Rank', description: 'Position in the ranked list, e.g. `2#`' },
  langCode: {
    name: 'Standard language code',
    description:
      'ISO 639-2 code, e.g. `nor`. What the Stremio SDK expects — use this if your player shows rows as "Unknown".',
  },
  languages: {
    name: 'Languages',
    description: 'Target and source, e.g. `NOR<ENG`',
  },
  score: { name: 'Match score', description: 'e.g. `90%`' },
  state: {
    name: 'What the row does',
    description:
      'Whether clicking translates, a job is running, or the subtitle is ready — e.g. `(Translate Embedded)`, `(…in progress)`, `(Finished translation)`',
  },
  eta: { name: 'ETA', description: 'Estimated time for a translation job' },
  pack: { name: 'Season pack marker', description: 'e.g. `(S01)`' },
  duration: {
    name: 'Duration',
    description: '`(✓)` when runtimes agree, the runtime or `(X …)` otherwise',
  },
  diffs: {
    name: 'Differences',
    description: 'How the subtitle`s release differs, e.g. `(+AMZN)`',
  },
  mt: {
    name: 'Machine-translated flag',
    description: '`(MT)` when the source is already machine output',
  },
  source: {
    name: 'Source',
    description: 'Provider and rank, e.g. `(SubDL-2)`',
  },
};
