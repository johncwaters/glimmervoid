import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { sitePath } from '../lib/site-path.ts';

const UNLISTED_PAGE_FILES = new Set(['./next.astro']);
const STATIC_PAGE_FILES = Object.keys(import.meta.glob('./**/*.astro')).filter((pageFile) => !UNLISTED_PAGE_FILES.has(pageFile));

function pathWithinSiteOf(pageFile: string): string | null {
  if (pageFile.includes('[')) return null;
  const pathWithoutExtension = pageFile.replace(/^\.\//, '').replace(/\.astro$/, '');
  if (pathWithoutExtension === 'index') return '';
  return `${pathWithoutExtension.replace(/\/index$/, '')}/`;
}

function sitemapEntry(pageUrl: string, lastModified: Date | null): string {
  const lastModifiedTag = lastModified ? `<lastmod>${lastModified.toISOString().slice(0, 10)}</lastmod>` : '';
  return `<url><loc>${pageUrl}</loc>${lastModifiedTag}</url>`;
}

export const GET: APIRoute = async ({ site }) => {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const pageUrlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  const newestPostDate = posts.reduce<Date | null>((newest, post) => (newest === null || post.data.updatedDate > newest ? post.data.updatedDate : newest), null);
  const staticPaths = STATIC_PAGE_FILES.map(pathWithinSiteOf).filter((pathWithinSite) => pathWithinSite !== null).sort();
  const entries = [
    ...staticPaths.map((pathWithinSite) => sitemapEntry(pageUrlOf(pathWithinSite), pathWithinSite === 'blog/' ? newestPostDate : null)),
    ...posts.map((post) => sitemapEntry(pageUrlOf(`blog/${post.id}/`), post.data.updatedDate)),
  ];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
