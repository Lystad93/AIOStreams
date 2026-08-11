import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared palette for generated link-preview images, so docs and changelog
 * cards look like one family. Values mirror the frontend's `--color-brand-*`
 * (packages/frontend/src/app/globals.css).
 */
export const ogBrand = {
  /** brand-500, the frontend's default */
  primary: '#6152df',
  /** brand-400, legible as text on the dark card */
  primaryText: '#9f92ff',
  background: '#0c0c0c',
  /** low-alpha brand-500, used for the corner wash */
  wash: 'rgba(97,82,223,0.35)',
} as const;

/**
 * The white-on-dark logo, inlined: these images are rendered at build time,
 * when there is no server to fetch `/logo-dark.png` from.
 */
export const ogLogo = `data:image/png;base64,${readFileSync(
  join(process.cwd(), 'public', 'logo-dark.png')
).toString('base64')}`;
