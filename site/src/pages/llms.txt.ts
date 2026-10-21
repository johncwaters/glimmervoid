import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { markdownResponse } from '../lib/agent-markdown.ts';
import { REPOSITORY_URL } from '../lib/product-facts.ts';
import { sitePath } from '../lib/site-path.ts';

export const GET: APIRoute = async ({ site }) => {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const urlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  const postLines = posts
    .toSorted((earlier, later) => later.data.pubDate.valueOf() - earlier.data.pubDate.valueOf())
    .map((post) => `- [${post.data.title}](${urlOf(`blog/${post.id}.md`)}): ${post.data.description}`);
  return markdownResponse([
    '# Glimmervoid',
    '',
    '> Local orchestrator for coding agents such as Claude Code and Codex: one git worktree per agent, status from the agents\' own hooks, and a browser dashboard that shows which session needs you.',
    '',
    '## Product',
    '',
    `- [Glimmervoid fact sheet](${urlOf('index.md')}): what it is, install commands, supported agents, features and CLI commands`,
    `- [Source and README](${REPOSITORY_URL})`,
    `- [Changelog](${REPOSITORY_URL}/blob/main/CHANGELOG.md)`,
    '',
    '## Blog',
    '',
    ...postLines,
    '',
  ].join('\n'), 'text/plain');
};
