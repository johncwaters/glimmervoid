import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMyPrsWiring } from '../server/my-prs-wiring.ts';
import { createMyPrsPoller } from '../server/my-prs-poller.ts';
import { createPrGh } from '../server/pr-gh.ts';
import type { CommandResult } from '../server/pr-gh.ts';
import { myPrsStatus, toMyPr } from '../server/core/my-prs-core.ts';
import type { MyPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const SEEN_HEAD = 'a'.repeat(40);
const NEWER_HEAD = 'b'.repeat(40);
const KEY = 'Acme/app#7';

interface MergeFrame {
  type: string;
  requestId?: string | null;
  key?: string;
  ok?: boolean;
  kind?: string;
  error?: string;
}

function readyNode(overrides: Partial<MyPrSearchNode> = {}): MyPrSearchNode {
  return {
    __typename: 'PullRequest', id: 'PR_node', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', isDraft: false,
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: SEEN_HEAD, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }] },
    latestReviews: { nodes: [] },
    ...overrides,
  };
}

function mergeStateResponse(state: string, isInMergeQueue: boolean): CommandResult {
  return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { state, isInMergeQueue, autoMergeRequest: null } } } }), err: '' };
}

const MERGED_STATE = mergeStateResponse('MERGED', false);

test('keep mergeable control reaches the real lane, persists across restarts, and does not dispatch the same head again', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-my-pr-keep-mergeable-'));
  const fixes: string[] = [];
  const statuses: ReturnType<typeof myPrsStatus>[] = [];
  const github = {
    ...createPrGh(homeDir),
    viewer: async () => 'me',
    searchMyPrs: async () => ({ ok: true as const, items: [readyNode({ mergeable: 'CONFLICTING' })], totalCount: 1, error: '' }),
    behindCounts: async () => new Map<string, number>(),
    reviewThreadsBatch: async () => new Map(),
    rateLimitWaitMs: async () => null,
  };
  async function startWiring() {
    let markPolled: () => void = () => {};
    const firstPoll = new Promise<void>((resolve) => { markPolled = resolve; });
    const wiring = createMyPrsWiring({
      homeDir, config: { teamReview: { enabled: true, org: 'Acme' } }, github,
      log: { warn() {} },
      broadcast: (status) => { statuses.push(status); if (status.prs.length > 0 && !status.isRefreshing) markPolled(); },
      createPoller: (dependencies) => createMyPrsPoller({
        ...dependencies, firstTickDelayMs: () => 0,
        setIntervalFn: () => ({ unref() {} }) as NodeJS.Timeout, clearIntervalFn: () => {},
      }),
      fixMergeability: async (pr) => { fixes.push(`${pr.key}@${pr.headRefOid}`); },
    });
    wiring.startPoller();
    await firstPoll;
    return wiring;
  }
  const wiring = await startWiring();
  try {
    const server = createControlServer(controlDeps({ projects: [] }, { myPrs: wiring }));
    const connection = connectControl<MergeFrame>(server);
    connection.sent.length = 0;
    const request = { type: 'my-pr-keep-mergeable', requestId: 'toggle-1', repo: 'Acme/app', number: 7, keepMergeable: true };
    await connection.send(request);
    assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-keep-mergeable-result', requestId: 'toggle-1', key: KEY, ok: true });
    assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, true);
    assert.deepEqual(fixes, [`${KEY}@${SEEN_HEAD}`]);
    const savedState = JSON.parse(await fs.readFile(path.join(homeDir, 'my-prs-state.json'), 'utf8'));
    assert.deepEqual(savedState, { keepMergeableKeys: [KEY], keepMergeableAttemptKeys: [`${KEY}@${SEEN_HEAD}`] });
    await wiring.stopPoller();
    const restarted = await startWiring();
    try {
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, true);
      assert.equal(fixes.length, 1);
      const restartedServer = createControlServer(controlDeps({ projects: [] }, { myPrs: restarted }));
      const restartedConnection = connectControl<MergeFrame>(restartedServer);
      await restartedConnection.send({ ...request, requestId: 'toggle-off', keepMergeable: false });
      assert.equal(restartedConnection.sent.at(-1)?.ok, true);
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, false);
      await restartedConnection.send({ ...request, requestId: 'unknown', number: 8 });
      assert.equal(restartedConnection.sent.at(-1)?.ok, false);
      assert.match(restartedConnection.sent.at(-1)?.error ?? '', /tracked/);
      for (const keepMergeable of ['true', null, undefined]) {
        await restartedConnection.send({ ...request, requestId: 'malformed', keepMergeable });
        assert.equal(restartedConnection.sent.at(-1)?.type, 'my-pr-keep-mergeable-result');
        assert.equal(restartedConnection.sent.at(-1)?.requestId, 'malformed');
        assert.equal(restartedConnection.sent.at(-1)?.ok, false);
      }
      assert.equal(statuses.at(-1)?.prs[0]?.keepMergeable, false);
      assert.equal(fixes.length, 1);
    } finally {
      await restarted.stopPoller();
    }
  } finally {
    await wiring.stopPoller();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('keep mergeable control replies with its request ID when the lane is unavailable', async () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<MergeFrame>(server);
  await connection.send({ type: 'my-pr-keep-mergeable', requestId: 'unavailable', repo: 'Acme/app', number: 7, keepMergeable: true });
  assert.deepEqual(connection.sent.at(-1), { type: 'my-pr-keep-mergeable-result', requestId: 'unavailable', key: KEY, ok: false, error: 'My pull requests is not running' });
});

async function harness({ trackedPrs = [toMyPr(readyNode(), 0)], ghOutcome = { ok: true, out: '', err: '' }, prStateAfterMerge = MERGED_STATE }: { trackedPrs?: MyPr[]; ghOutcome?: CommandResult; prStateAfterMerge?: CommandResult } = {}) {
  const ghCalls: { command: string; args: string[] }[] = [];
  let refreshCount = 0;
  const github = createPrGh('/home', async (command, args) => {
    ghCalls.push({ command, args });
    return args[1] === 'graphql' ? prStateAfterMerge : ghOutcome;
  });
  const myPrs = createMyPrsWiring({
    config: { teamReview: { enabled: true, org: 'Acme' } },
    broadcast: () => {},
    log: { warn() {} },
    github,
    createPoller: ({ onTickComplete }) => ({
      start: async () => { onTickComplete(myPrsStatus({ ts: 1, configured: true, viewer: 'me', prs: trackedPrs })); },
      stop: async () => {},
      tick: async () => { refreshCount += 1; },
      refresh: async () => { refreshCount += 1; return { ok: true }; },
      setKeepMergeable: async () => ({ ok: false, error: 'Not available in this merge fixture' }),
    }),
  });
  myPrs.startPoller();
  await new Promise((resolve) => setImmediate(resolve));
  const server = createControlServer(controlDeps({ projects: [] }, { myPrs }));
  const connection = connectControl<MergeFrame>(server);
  connection.sent.length = 0;
  return {
    send: (message: Record<string, unknown> = {}) => Promise.resolve(connection.send({
      type: 'my-pr-merge', requestId: 'merge-1', repo: 'Acme/app', number: 7, headRefOid: SEEN_HEAD, ...message,
    })),
    results: () => connection.sent.filter((frame) => frame.type === 'my-pr-merge-result'),
    ghCalls,
    refreshCount: () => refreshCount,
  };
}

test('a ready pull request at the seen head is merged with the repository default method and pinned to that head', async () => {
  const h = await harness();
  await h.send();
  assert.deepEqual(h.ghCalls[0], { command: 'gh', args: ['pr', 'merge', '7', '--repo', 'Acme/app', '--squash', '--match-head-commit', SEEN_HEAD] });
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: true, kind: 'merged' }]);
  assert.equal(h.refreshCount(), 1);
});

test('a merge that GitHub only queues is reported as queued, not merged', async () => {
  const h = await harness({ prStateAfterMerge: mergeStateResponse('OPEN', true) });
  await h.send();
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: true, kind: 'queued' }]);
  assert.equal(h.refreshCount(), 1);
});

test('a merge for a head the poll no longer sees is refused without calling gh', async () => {
  const h = await harness({ trackedPrs: [toMyPr(readyNode({ headRefOid: NEWER_HEAD }), 0)] });
  await h.send();
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.ok, false);
  assert.match(String(h.results()[0]?.error), /new commits/);
  assert.equal(h.refreshCount(), 0);
});

test('a pull request that is not ready is refused without calling gh', async () => {
  const failing = readyNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } } }] } });
  const h = await harness({ trackedPrs: [toMyPr(failing, 0)] });
  await h.send();
  assert.deepEqual(h.ghCalls, []);
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: false, error: 'Checks are failing' }]);
});

test('a pull request outside the tracked list is refused without calling gh', async () => {
  const h = await harness();
  await h.send({ repo: 'Acme/other' });
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.key, 'Acme/other#7');
  assert.match(String(h.results()[0]?.error), /not one of your tracked/);
});

test('a malformed merge request is answered with a failed result and never reaches gh', async () => {
  const h = await harness();
  await h.send({ headRefOid: 'main' });
  assert.deepEqual(h.ghCalls, []);
  assert.equal(h.results()[0]?.ok, false);
  assert.equal(h.results()[0]?.key, KEY);
});

test('a refused gh merge replies with its first error line and skips the refresh', async () => {
  const h = await harness({ ghOutcome: { ok: false, out: '', err: '\nX Pull request Acme/app#7 is not mergeable: the head commit changed.\nmore detail\n' } });
  await h.send();
  assert.equal(h.ghCalls.length, 1);
  assert.deepEqual(h.results(), [{ type: 'my-pr-merge-result', requestId: 'merge-1', key: KEY, ok: false, error: 'X Pull request Acme/app#7 is not mergeable: the head commit changed.' }]);
  assert.equal(h.refreshCount(), 0);
});
