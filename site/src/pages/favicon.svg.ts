import type { APIRoute } from 'astro';
import dashboardFavicon from '../../../public/favicon.svg?raw';

export const GET: APIRoute = () => new Response(dashboardFavicon, { headers: { 'Content-Type': 'image/svg+xml' } });
