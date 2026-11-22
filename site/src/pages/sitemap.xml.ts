import type { APIRoute } from 'astro';
import { sitePath } from '../lib/site-path.ts';

const STATIC_PAGE_FILES = Object.keys(import.meta.glob('./**/*.astro'));

function pathWithinSiteOf(pageFile: string): string | null {
  if (pageFile.includes('[')) return null;
  const pathWithoutExtension = pageFile.replace(/^\.\//, '').replace(/\.astro$/, '');
  if (pathWithoutExtension === 'index') return '';
  return `${pathWithoutExtension.replace(/\/index$/, '')}/`;
}

function sitemapEntry(pageUrl: string): string {
  return `<url><loc>${pageUrl}</loc></url>`;
}

export const GET: APIRoute = ({ site }) => {
  const pageUrlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  const staticPaths = STATIC_PAGE_FILES.map(pathWithinSiteOf).filter((pathWithinSite) => pathWithinSite !== null).sort();
  const entries = staticPaths.map((pathWithinSite) => sitemapEntry(pageUrlOf(pathWithinSite)));
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
