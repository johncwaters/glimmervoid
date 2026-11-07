import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowsSearch } from '../cloud/watchees/workflows/workflows-search.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createWorkflowsPoller } from '../server/workflows-poller.ts';
import { createWorkflowsWiring } from '../server/workflows-wiring.ts';
import { GithubPrDetailNode, GithubPrLightSearchNode, comparablePrKey } from '../shared/contracts/github-prs.ts';
import { waitFor } from './helpers/wait-for.ts';

const REPO = 'acme/widgets';

function pullRequestNode(reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED', updatedAt: string): GithubPrDetailNode {
  return GithubPrDetailNode.parse({
    __typename: 'PullRequest', id: 'PR_1', number: 1, title: 'Widen the widget', url: `https://github.com/${REPO}/pull/1`,
    repository: { nameWithOwner: REPO, viewerDefaultMergeMethod: 'SQUASH' },
    author: { login: 'operator' }, labels: { nodes: [] }, comments: { totalCount: 0 },
    isDraft: false, state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', mergedAt: null, updatedAt,
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: 'widen', isCrossRepository: false, headRefOid: 'b'.repeat(40),
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision,
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  });
}

function watcherStore(currentNode: () => GithubPrDetailNode, now: () => number) {
  const keyOf = (node: GithubPrDetailNode) => comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number });
  return createGithubStorePoller({
    github: {
      async viewer() { return 'operator'; },
      async searchPrsLight(qualifiers: string) {
        const items = qualifiers.startsWith('is:open') ? [GithubPrLightSearchNode.parse(currentNode())] : [];
        return { ok: true, items, isComplete: true, totalCount: items.length, error: '' };
      },
      async prsLightByKey() { return { byKey: new Map([[keyOf(currentNode()), GithubPrLightSearchNode.parse(currentNode())]]), goneKeys: new Set<string>() }; },
      async prDetails() { return { byKey: new Map([[keyOf(currentNode()), currentNode()]]), goneKeys: new Set<string>() }; },
      async notificationsSince() { return { kind: 'unchanged' as const }; },
      async behindCounts(prs) { return new Map<string, number | null>(prs.map((pr) => [`${pr.repo}#${pr.number}`, 0])); },
      async reviewThreadsBatch() { return new Map(); },
      async rateLimitWaitMs() { return null; },
      async viewPr() { assert.fail('Unexpected PR view'); },
      async prDiff() { assert.fail('Unexpected PR diff'); },
      async prHead() { assert.fail('Unexpected PR head'); },
    },
    now, isDashboardConnected: () => true, exclusive: (work) => work(),
    setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, log: { warn() {} },
  });
}

test('a pull request list from the watcher drives a workflow rule: approving the operator pull request labels it once, using the viewer the watcher looked up', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-watchee-'));
  let nowMs = Date.parse('2026-11-06T12:00:00Z');
  let node = pullRequestNode('REVIEW_REQUIRED', '2026-11-06T11:00:00Z');
  const labels: string[] = [];
  const search = createWorkflowsSearch({ store: watcherStore(() => node, () => nowMs), now: () => nowMs });
  const config = {
    workflows: { enabled: true, rules: [{ id: 'label-approved', name: 'Label approved', enabled: true, repos: [REPO], filters: { mine: true }, trigger: 'approved', actions: [{ type: 'label', name: 'ready' }] }] },
  };
  const wiring = createWorkflowsWiring({
    config, homeDir, log: { warn() {} },
    notificationManager: { trigger() {} },
    spawnSession: async () => {},
    github: {
      addPrLabel: async ({ repo, number, name }) => { labels.push(`${repo}#${number}:${name}`); return { ok: true, err: '' }; },
      commentOnPr: async () => ({ ok: true, err: '' }),
    },
    store: { rateLimitWaitMs: async () => null },
    createPoller: (dependencies) => createWorkflowsPoller({ ...dependencies, now: () => nowMs, firstTickDelayMs: () => 0, setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {} }),
  });
  const deliverList = async () => {
    const searched = await search.search({ enabled: true, repos: [REPO], intervalMinutes: 5 });
    assert.ok(searched.ok);
    for (const payload of searched.payloads) await wiring.acceptCandidates({ payload });
  };
  const statePath = path.join(homeDir, 'workflows-state.json');
  const savedPolledAtMs = async () => JSON.parse(await fs.readFile(statePath, 'utf8')).repos[REPO]?.polledAtMs ?? null;
  try {
    wiring.startPoller();
    await deliverList();
    let polledAtMs: number | null = null;
    await waitFor(() => { void savedPolledAtMs().then((saved) => { polledAtMs = saved; }, () => {}); return polledAtMs === nowMs; }, 'the first list was planned', 3000);
    assert.deepEqual(labels, []);
    node = pullRequestNode('APPROVED', '2026-11-06T12:04:00Z');
    nowMs += 5 * 60_000;
    await deliverList();
    await waitFor(() => labels.length > 0, 'the approved pull request was labelled', 3000);
    assert.deepEqual(labels, [`${REPO}#1:ready`]);
    nowMs += 5 * 60_000;
    await deliverList();
    await waitFor(() => { void savedPolledAtMs().then((saved) => { polledAtMs = saved; }, () => {}); return polledAtMs === nowMs; }, 'the repeated list was planned', 3000);
    assert.deepEqual(labels, [`${REPO}#1:ready`]);
  } finally {
    search.stop();
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
