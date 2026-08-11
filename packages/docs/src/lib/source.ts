import { changelog, docs } from 'fumadocs-mdx:collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [],
});

export const changelogSource = loader({
  baseUrl: '/changelog',
  source: toFumadocsSource(changelog, []),
});

export type ChangelogEntry = InferPageType<typeof changelogSource>;

/** Entries newest first. Drafts are only listed outside production builds. */
export function getChangelogEntries(): ChangelogEntry[] {
  return changelogSource
    .getPages()
    .filter(
      (page) => !page.data.draft || process.env.NODE_ENV === 'development'
    )
    .sort(
      (a, b) =>
        new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
    );
}

export function formatChangelogDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, 'image.webp'];

  return {
    segments,
    url: `/og/${segments.join('/')}`,
  };
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title}

${processed}`;
}
