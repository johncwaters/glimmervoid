import { createHash } from 'node:crypto';
import { PackSourceSlug } from '../../../shared/contracts/pack-bridge.ts';

const SLUG_HASH_CHARS = 10;
const SLUG_PREFIX_MAX_CHARS = 80 - SLUG_HASH_CHARS - 1;

type PackSourceTarget = { ok: true; url: string; slug: string } | { ok: false; error: string };

export function packSourceOf(requestedUrl: string): PackSourceTarget {
  const refusal = `${requestedUrl} is not a pack source: give the https URL of a git repository, such as https://github.com/owner/packs`;
  if (!URL.canParse(requestedUrl)) return { ok: false, error: refusal };
  const parsed = new URL(requestedUrl);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return { ok: false, error: refusal };
  const repoPath = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (repoPath === '' || repoPath.split('/').some((segment) => segment === '.' || segment === '..')) return { ok: false, error: refusal };
  const url = `https://${parsed.host}${repoPath}`;
  const readablePrefix = `${parsed.hostname}${repoPath}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, SLUG_PREFIX_MAX_CHARS).replace(/[-.]+$/, '');
  const urlHash = createHash('sha256').update(url.toLowerCase()).digest('hex').slice(0, SLUG_HASH_CHARS);
  const slug = readablePrefix === '' ? urlHash : `${readablePrefix}-${urlHash}`;
  if (!PackSourceSlug.safeParse(slug).success) return { ok: false, error: refusal };
  return { ok: true, url, slug };
}
