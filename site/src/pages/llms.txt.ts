import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/agent-markdown.ts';
import { PRODUCT_SUMMARY, REPOSITORY_URL } from '../lib/product-facts.ts';
import { sitePath } from '../lib/site-path.ts';

export const GET: APIRoute = ({ site }) => {
  const urlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  return markdownResponse([
    '# Glimmervoid',
    '',
    `> ${PRODUCT_SUMMARY}`,
    '',
    '## Product',
    '',
    `- [Glimmervoid fact sheet](${urlOf('index.md')}): what it is, install commands, supported agents, features and CLI commands`,
    `- [Source and README](${REPOSITORY_URL})`,
    `- [Changelog](${REPOSITORY_URL}/blob/main/CHANGELOG.md)`,
    '',
    '## Glimmervoid Cloud',
    '',
    `- [Terms of service](${urlOf('terms/')}): the terms for Glimmervoid Cloud`,
    `- [Refund policy](${urlOf('refunds/')}): how to ask for a refund and what it ends`,
    '',
  ].join('\n'), 'text/plain');
};
