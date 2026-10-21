const MEDIA_ATTRIBUTE_PATTERN = /\s([a-z-]+)="([^"]*)"/g;

function attributesOf(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(MEDIA_ATTRIBUTE_PATTERN)].map(([, name, value]) => [name, value]));
}

function figureAsMarkdown(figureHtml: string, pageUrl: URL): string {
  const captionMatch = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(figureHtml);
  const caption = captionMatch ? captionMatch[1].trim() : '';
  const imageTag = /<img\b[^>]*>/.exec(figureHtml)?.[0];
  const videoTag = /<video\b[^>]*>/.exec(figureHtml)?.[0];
  const mediaLines: string[] = [];
  if (imageTag) {
    const image = attributesOf(imageTag);
    mediaLines.push(`![${image.get('alt') ?? caption}](${new URL(image.get('src') ?? '', pageUrl).href})`);
  }
  if (videoTag) {
    const video = attributesOf(videoTag);
    mediaLines.push(`[Video: ${video.get('aria-label') ?? caption}](${new URL(video.get('src') ?? '', pageUrl).href})`);
  }
  if (caption) mediaLines.push(`*${caption}*`);
  return mediaLines.join('\n\n');
}

export function postBodyAsAgentMarkdown(postSource: string, pageUrl: URL): string {
  return postSource
    .replace(/<figure>[\s\S]*?<\/figure>/g, (figureHtml) => figureAsMarkdown(figureHtml, pageUrl))
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/g, '$1')
    .replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_link, target: string) => `](${new URL(target, pageUrl).href})`)
    .trim();
}

export function agentMarkdownPage({ title, pageUrl, indexUrl, body }: { title: string; pageUrl: string; indexUrl: string; body: string }): string {
  return `# ${title}\n\n> AI agents: this is the Markdown version of ${pageUrl}. Index of every Markdown page on this site: ${indexUrl}\n\n${body}\n`;
}

export function markdownResponse(markdown: string, contentType = 'text/markdown'): Response {
  return new Response(markdown, { headers: { 'Content-Type': `${contentType}; charset=utf-8` } });
}
