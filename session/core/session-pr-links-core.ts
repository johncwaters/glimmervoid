import { LinkedPr as LinkedPrSchema, SESSION_PR_LINKS_MAX } from '../../shared/contracts/my-prs.ts';
import type { LinkedPr, SessionPrLinks } from '../../shared/contracts/my-prs.ts';

function comparableLinkKey(link: Pick<LinkedPr, 'repo' | 'number'>): string {
  return `${link.repo}#${link.number}`.toLowerCase();
}

function isUnlinked(current: SessionPrLinks, comparableKey: string): boolean {
  return current.unlinkedKeys.some((unlinkedKey) => unlinkedKey.toLowerCase() === comparableKey);
}

function seedSessionPrLinks(persisted: SessionPrLinks | undefined): SessionPrLinks {
  return persisted ?? { links: [], unlinkedKeys: [] };
}

function mergeSessionPrLink(current: SessionPrLinks, incoming: LinkedPr): SessionPrLinks {
  const incomingKey = comparableLinkKey(incoming);
  if (isUnlinked(current, incomingKey)) return current;
  if (current.links.some((link) => comparableLinkKey(link) === incomingKey)) return current;
  const firstOlderIndex = current.links.findIndex((link) => link.linkedAt <= incoming.linkedAt);
  const insertAt = firstOlderIndex === -1 ? current.links.length : firstOlderIndex;
  if (insertAt >= SESSION_PR_LINKS_MAX) return current;
  const links = [...current.links.slice(0, insertAt), incoming, ...current.links.slice(insertAt)].slice(0, SESSION_PR_LINKS_MAX);
  return { links, unlinkedKeys: current.unlinkedKeys };
}

function withManualPrLink(current: SessionPrLinks, link: LinkedPr): SessionPrLinks {
  const key = comparableLinkKey(link);
  if (!isUnlinked(current, key)) return mergeSessionPrLink(current, link);
  return mergeSessionPrLink({ links: current.links, unlinkedKeys: current.unlinkedKeys.filter((unlinkedKey) => unlinkedKey.toLowerCase() !== key) }, link);
}

function withoutPrLink(current: SessionPrLinks, pullRequestKey: string): SessionPrLinks {
  const comparableKey = pullRequestKey.toLowerCase();
  const links = current.links.filter((link) => comparableLinkKey(link) !== comparableKey);
  const isAlreadyUnlinked = isUnlinked(current, comparableKey);
  if (isAlreadyUnlinked && links.length === current.links.length) return current;
  return { links, unlinkedKeys: isAlreadyUnlinked ? current.unlinkedKeys : [...current.unlinkedKeys, pullRequestKey] };
}

type KnownPr = Pick<LinkedPr, 'repo' | 'number' | 'url'> & { key: string };

function manualPrLink(pullRequestKey: string, knownPrs: readonly KnownPr[], nowMs: number): LinkedPr | null {
  const separatorIndex = pullRequestKey.lastIndexOf('#');
  const repo = pullRequestKey.slice(0, separatorIndex);
  const number = Number(pullRequestKey.slice(separatorIndex + 1));
  const comparableKey = pullRequestKey.toLowerCase();
  const knownPr = knownPrs.find((pr) => pr.key.toLowerCase() === comparableKey);
  const canonicalPr = knownPr ?? { repo, number, url: `https://github.com/${repo}/pull/${number}` };
  const parsed = LinkedPrSchema.safeParse({ repo: canonicalPr.repo, number: canonicalPr.number, url: canonicalPr.url, source: 'manual', linkedAt: nowMs });
  return parsed.success ? parsed.data : null;
}

export { manualPrLink, mergeSessionPrLink, seedSessionPrLinks, withManualPrLink, withoutPrLink };
