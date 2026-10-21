import type { APIRoute } from 'astro';
import { sitePath } from '../lib/site-path.ts';

export const GET: APIRoute = ({ site }) => new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL(sitePath('sitemap.xml'), site).href}\n`, {
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});
