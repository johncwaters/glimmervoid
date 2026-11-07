import crypto from 'node:crypto';
import { GITHUB_API_HOST } from '../../shared/contracts/watcher-link.ts';
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
const GRAPHQL_URL = `https://${GITHUB_API_HOST}/graphql`;
const NOTIFICATIONS_URL = `https://${GITHUB_API_HOST}/notifications`;
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
  return { id, laneId: GITHUB_STORE_LANE_ID, everyMs, method: 'POST', url: GRAPHQL_URL, body: JSON.stringify({ query, variables }), credential: 'github' };
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
  const lightProbes = batchesOf(inputs.knownPrs, LIGHT_BATCH_SIZE).map((batch, index) => graphqlProbe(`${POLL_PROBE_PREFIX}light:${index}`, LIGHT_EVERY_MS, githubPrsLightByKeyQuery(batch)));
  const behindProbes = batchesOf(inputs.behindPrs, BEHIND_BATCH_SIZE).map((batch, index) => graphqlProbe(`${POLL_PROBE_PREFIX}behind:${index}`, GITHUB_STORE_BEHIND_INTERVAL_MS, behindCountsQuery(batch)));
  const notificationsProbes: Probe[] = inputs.isNotificationsReadable
    ? [{ id: `${POLL_PROBE_PREFIX}notifications`, laneId: GITHUB_STORE_LANE_ID, everyMs: NOTIFICATIONS_EVERY_MS, method: 'GET', url: NOTIFICATIONS_URL, body: null, credential: 'github' }]
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
