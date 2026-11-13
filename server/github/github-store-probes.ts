import crypto from 'node:crypto';
import { githubApiOrigin } from '../../shared/contracts/watcher-link.ts';
import type { Probe } from '../../shared/contracts/watcher-link.ts';
import { GITHUB_STORE_BEHIND_INTERVAL_MS } from './core/github-store-core.ts';
import { behindCountsQuery, githubPrsLightByKeyQuery, githubPrsLightSearchQuery } from './pr-gh/pr-gh-queries.ts';
import type { PrHeadReference, PrReference } from './pr-gh/pr-gh-queries.ts';

type GithubStorePoll = 'light' | 'behind' | 'notifications';

interface GithubStoreProbeInputs {
  watches: readonly { name: string; qualifiers: string; maxMembers?: number; intervalMs?: number }[];
  knownPrs: readonly PrReference[];
  behindPrs: readonly PrHeadReference[];
  viewerLogin: string | null;
  isNotificationsReadable: boolean;
}

const GITHUB_STORE_LANE_ID = 'github-store';
const WATCH_PROBE_PREFIX = 'github:watch:';
const POLL_PROBE_PREFIX = 'github:';
const LIGHT_BATCH_SIZE = 50;
const BEHIND_BATCH_SIZE = 25;
const LIGHT_EVERY_MS = 60_000;
const MEMBERSHIP_EVERY_MS = 300_000;
const NOTIFICATIONS_EVERY_MS = 60_000;
const SELF_QUALIFIER = /(^|[\s:])@me\b/;
const EVERY_SELF_QUALIFIER = new RegExp(SELF_QUALIFIER.source, 'g');

function batchesOf<Item>(items: readonly Item[], batchSize: number): Item[][] {
  const batches: Item[][] = [];
  for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize));
  return batches;
}

function graphqlProbe(id: string, everyMs: number, query: string, variables: Record<string, string> = {}): Probe {
  return { id, laneId: GITHUB_STORE_LANE_ID, everyMs, method: 'POST', url: new URL('/graphql', githubApiOrigin(process.env)).toString(), body: JSON.stringify({ query, variables }), credential: 'github' };
}

function ownerOf(reference: PrReference): string {
  return reference.repo.split('/')[0].toLowerCase();
}

function ownerBatchesOf<Reference extends PrReference>(references: readonly Reference[], batchSize: number): { githubOwner: string; batch: Reference[] }[] {
  const owners = [...new Set(references.map(ownerOf))];
  const referencesByOwner = owners.map((githubOwner): [string, Reference[]] => [githubOwner, references.filter((reference) => ownerOf(reference) === githubOwner)]);
  return referencesByOwner.flatMap(([githubOwner, ownedReferences]) => batchesOf(ownedReferences, batchSize).map((batch) => ({ githubOwner, batch })));
}

function watchProbeId(watchName: string): string {
  return `${WATCH_PROBE_PREFIX}${crypto.createHash('sha256').update(watchName).digest('hex').slice(0, 24)}`;
}

function coveredProbeKey(probe: Probe): string {
  return `${probe.id}\n${probe.method} ${probe.url}\n${probe.body ?? ''}`;
}

function qualifiersForViewer(qualifiers: string, viewerLogin: string | null): string | null {
  if (!SELF_QUALIFIER.test(qualifiers)) return qualifiers;
  if (viewerLogin === null) return null;
  return qualifiers.replace(EVERY_SELF_QUALIFIER, (_match, before: string) => `${before}${viewerLogin}`);
}

function githubStoreProbes(inputs: GithubStoreProbeInputs): Probe[] {
  const watchProbes = inputs.watches.flatMap((watch) => {
    const qualifiers = qualifiersForViewer(watch.qualifiers, inputs.viewerLogin);
    if (qualifiers === null) return [];
    return [graphqlProbe(watchProbeId(watch.name), Math.max(LIGHT_EVERY_MS, watch.intervalMs ?? MEMBERSHIP_EVERY_MS), githubPrsLightSearchQuery(watch.maxMembers), { searchQuery: `is:pr ${qualifiers}` })];
  });
  const lightProbes = ownerBatchesOf(inputs.knownPrs, LIGHT_BATCH_SIZE).map(({ githubOwner, batch }, index) => ({ ...graphqlProbe(`${POLL_PROBE_PREFIX}light:${index}`, LIGHT_EVERY_MS, githubPrsLightByKeyQuery(batch)), githubOwner }));
  const behindProbes = ownerBatchesOf(inputs.behindPrs, BEHIND_BATCH_SIZE).map(({ githubOwner, batch }, index) => ({ ...graphqlProbe(`${POLL_PROBE_PREFIX}behind:${index}`, GITHUB_STORE_BEHIND_INTERVAL_MS, behindCountsQuery(batch)), githubOwner }));
  const notificationsProbes: Probe[] = inputs.isNotificationsReadable
    ? [{ id: `${POLL_PROBE_PREFIX}notifications`, laneId: GITHUB_STORE_LANE_ID, everyMs: NOTIFICATIONS_EVERY_MS, method: 'GET', url: new URL('/notifications', githubApiOrigin(process.env)).toString(), body: null, credential: 'github' }]
    : [];
  return [...watchProbes, ...lightProbes, ...behindProbes, ...notificationsProbes];
}

function nudgedStorePoll(probeId: string, watchNames: readonly string[]): { watchName: string } | { poll: GithubStorePoll } | null {
  if (probeId.startsWith(WATCH_PROBE_PREFIX)) {
    const watchName = watchNames.find((name) => watchProbeId(name) === probeId);
    return watchName === undefined ? null : { watchName };
  }
  const poll = probeId.slice(POLL_PROBE_PREFIX.length).split(':')[0];
  if (poll === 'light' || poll === 'behind' || poll === 'notifications') return { poll };
  return null;
}

export { GITHUB_STORE_LANE_ID, coveredProbeKey, githubStoreProbes, nudgedStorePoll, watchProbeId };
export type { GithubStorePoll, GithubStoreProbeInputs };
