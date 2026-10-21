import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { sitePath } from '../lib/site-path.ts';

function sitemapEntry(pageUrl: string, lastModified: Date | null): string {
  const lastModifiedTag = lastModified ? `<lastmod>${lastModified.toISOString().slice(0, 10)}</lastmod>` : '';
  return `<url><loc>${pageUrl}</loc>${lastModifiedTag}</url>`;
}

export const GET: APIRoute = async ({ site }) => {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const pageUrlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  const newestPostDate = posts.reduce<Date | null>((newest, post) => (newest === null || post.data.pubDate > newest ? post.data.pubDate : newest), null);
  const entries = [
    sitemapEntry(pageUrlOf(''), null),
    sitemapEntry(pageUrlOf('blog/'), newestPostDate),
    ...posts.map((post) => sitemapEntry(pageUrlOf(`blog/${post.id}/`), post.data.pubDate)),
  ];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
