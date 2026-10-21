import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { agentMarkdownPage, markdownResponse, postBodyAsAgentMarkdown } from '../../lib/agent-markdown.ts';
import { sitePath } from '../../lib/site-path.ts';

export const getStaticPaths = (async () => {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ post: CollectionEntry<'blog'> }> = ({ props: { post }, site }) => {
  const pageUrl = new URL(sitePath(`blog/${post.id}/`), site);
  const body = [
    `Published ${post.data.pubDate.toISOString().slice(0, 10)} by John C. Waters.`,
    post.data.description,
    postBodyAsAgentMarkdown(post.body ?? '', pageUrl),
  ].join('\n\n');
  return markdownResponse(agentMarkdownPage({ title: post.data.title, pageUrl: pageUrl.href, indexUrl: new URL(sitePath('llms.txt'), site).href, body }));
};
