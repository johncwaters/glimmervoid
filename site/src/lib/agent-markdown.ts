export function agentMarkdownPage({ title, pageUrl, indexUrl, body }: { title: string; pageUrl: string; indexUrl: string; body: string }): string {
  return `# ${title}\n\n> AI agents: this is the Markdown version of ${pageUrl}. Index of every Markdown page on this site: ${indexUrl}\n\n${body}\n`;
}

export function markdownResponse(markdown: string, contentType = 'text/markdown'): Response {
  return new Response(markdown, { headers: { 'Content-Type': `${contentType}; charset=utf-8` } });
}
