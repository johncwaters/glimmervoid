const AGENT_FETCHER_PATTERN = /\b(?:ChatGPT-User|Claude-User|Perplexity-User)\b/i;

function markdownPathOf(pathname: string): string | null {
  const pathWithoutTrailingSlash = pathname.replace(/\/$/, '');
  if (pathWithoutTrailingSlash === '') return '/index.md';
  if (/\.[a-z0-9]+$/i.test(pathWithoutTrailingSlash)) return null;
  return `${pathWithoutTrailingSlash}.md`;
}

function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/markdown')) return true;
  return AGENT_FETCHER_PATTERN.test(request.headers.get('user-agent') ?? '') && !accept.includes('text/html');
}

export default async function serveMarkdownToAgents(request: Request): Promise<Response | undefined> {
  if (!wantsMarkdown(request)) return undefined;
  const pageUrl = new URL(request.url);
  const markdownPath = markdownPathOf(pageUrl.pathname);
  if (!markdownPath) return undefined;
  const markdown = await fetch(new URL(markdownPath, pageUrl.origin));
  if (!markdown.ok) return undefined;
  return new Response(markdown.body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept, User-Agent', 'Cache-Control': 'public, max-age=0, must-revalidate' },
  });
}

export const config = { path: ['/', '/blog/*'] };
