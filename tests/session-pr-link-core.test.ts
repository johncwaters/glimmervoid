import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createSessionPrLinkWiring } from '../server/github/session-pr-link-wiring.ts';
import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import { createSerialQueue } from '../server/spawn-gate.ts';
import { GithubPrDetailNode, GithubPrLightSearchNode, comparablePrKey } from '../shared/contracts/github-prs.ts';
import type { SessionPrLinks } from '../shared/contracts/my-prs.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { manualTimers } from './helpers/manual-timers.ts';

const LINKED_AT_MS = 1_700_000_000_000;

function storeHarness(context: TestContext, initialNodes: GithubPrDetailNode[] = []) {
  let nodes = initialNodes;
  const timers = manualTimers();
  const queue = createSerialQueue();
  const detailCalls: string[][] = [];
  const store = createGithubStorePoller({
    github: {
      async searchPrsLight() {
        const items = nodes.filter((node) => node.author?.login === 'operator').map((node) => GithubPrLightSearchNode.parse(node));
        return { ok: true, items, isComplete: true, totalCount: items.length, error: '' };
      },
      async prDetails(references) {
        const keys = references.map(comparablePrKey);
        detailCalls.push(keys);
        return new Map(nodes.filter((node) => keys.includes(comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number })))
          .map((node) => [comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), node]));
      },
      async notificationsSince() { return { kind: 'unchanged' }; },
      async behindCounts() { return new Map<string, number>(); },
      async reviewThreadsBatch() { return new Map(); },
      async rateLimitWaitMs() { return null; },
      async viewPr() { assert.fail('Unexpected PR view'); },
      async prDiff() { assert.fail('Unexpected PR diff'); },
      async compareCommits() { assert.fail('Unexpected commit comparison'); },
      async prHead() { assert.fail('Unexpected PR head'); },
      async reviewThreads() { assert.fail('Unexpected review threads'); },
    },
    now: () => LINKED_AT_MS, isDashboardConnected: () => true, exclusive: queue.run,
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
    log: { warn: (message: string) => assert.fail(message) },
  });
  context.after(() => { for (const timer of timers.pending) timers.clearTimeoutFn(timer.handle); });
  return {
    store: {
      ...store,
      subscribe: (event: 'snapshot-changed', listener: () => void) => {
        store.events.on(event, listener);
        return () => { store.events.off(event, listener); };
      },
    },
    detailCalls,
    setNodes: (nextNodes: GithubPrDetailNode[]) => { nodes = nextNodes; },
    async flushRefreshes() {
      for (const timer of timers.pending.filter((timer) => !timer.cleared)) {
        timers.clearTimeoutFn(timer.handle);
        timer.fn();
      }
      await queue.idle();
    },
  };
}

function makeLinkedSession(context: TestContext, { ephemeral = false } = {}) {
  const session = new Session({ id: 'pr-link-test', name: 'pr-link-test', path: process.cwd(), ephemeral });
  createSessionPrLinkWiring({ store: storeHarness(context).store, now: () => LINKED_AT_MS }).attachSession(session);
  return session;
}

function bashResult(gitOperation: Record<string, unknown>): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command: 'gh pr' }, tool_response: { stdout: '', gitOperation } };
}

function prOperation(action: string, number: number) {
  return { pr: { action, number, url: `https://github.com/acme/widgets/pull/${number}` } };
}

test('gh pr create and gh pr edit link the PR the moment the Bash hook lands', (context) => {
  const session = makeLinkedSession(context);
  const broadcasts: SessionPrLinks[] = [];
  session.on('pr-links-change', (prLinks: SessionPrLinks) => broadcasts.push(prLinks));
  session.emit('hook-event', { event: 'posttooluse', payload: bashResult(prOperation('created', 42)) });
  session.emit('hook-event', { event: 'posttooluse', payload: bashResult(prOperation('edited', 7)) });
  assert.deepEqual(session.linkedPrs, [
    { repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7', source: 'hook', linkedAt: LINKED_AT_MS },
    { repo: 'acme/widgets', number: 42, url: 'https://github.com/acme/widgets/pull/42', source: 'hook', linkedAt: LINKED_AT_MS },
  ]);
  assert.equal(broadcasts.length, 2);
});

test('commenting on a PR, pushing a branch, a commit, or a non-github host links nothing', (context) => {
  const session = makeLinkedSession(context);
  const ignoredPayloads = [
    bashResult(prOperation('commented', 9)),
    bashResult({ pr: { commented: { number: 9, url: 'https://github.com/acme/widgets/pull/9' } } }),
    bashResult({ push: { branch: 'feature' } }),
    bashResult({ commit: { sha: 'abc123', kind: 'committed', branch: 'feature' } }),
    bashResult({ pr: { action: 'created', url: 'https://gitlab.com/acme/widgets/pull/3' } }),
    { ...bashResult(prOperation('created', 5)), tool_name: 'Read' },
  ];
  for (const payload of ignoredPayloads) session.emit('hook-event', { event: 'posttooluse', payload });
  session.emit('hook-event', { event: 'stop', payload: bashResult(prOperation('created', 5)) });
  assert.deepEqual(session.linkedPrs, []);
});

test('an ephemeral session never gains hook links', (context) => {
  const session = makeLinkedSession(context, { ephemeral: true });
  session.emit('hook-event', { event: 'posttooluse', payload: bashResult(prOperation('created', 42)) });
  assert.deepEqual(session.linkedPrs, []);
});

function makeRepoAheadOfOrigin(originUrl: string, { commitsAhead }: { commitsAhead: number }) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pr-sha-link-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  git(['remote', 'add', 'origin', originUrl], repoDir);
  git(['commit', '-q', '--allow-empty', '-m', `base of ${originUrl}`], repoDir);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repoDir);
  for (let commitIndex = 0; commitIndex < commitsAhead; commitIndex++) git(['commit', '-q', '--allow-empty', '-m', `work ${commitIndex}`], repoDir);
  const commitOnTop = (...parents: string[]) => git(['commit-tree', 'HEAD^{tree}', '-m', 'remote', ...parents.flatMap((parent) => ['-p', parent])], repoDir).trim();
  return { repoDir, headSha: git(['rev-parse', 'HEAD'], repoDir).trim(), baseSha: git(['rev-parse', 'origin/main'], repoDir).trim(), commitOnTop };
}

function openPr(repo: string, number: number, headRefOid: string): GithubPrDetailNode {
  return GithubPrDetailNode.parse({
    __typename: 'PullRequest', id: `PR_${number}`, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`,
    repository: { nameWithOwner: repo, viewerDefaultMergeMethod: 'SQUASH' },
    author: { login: 'operator' }, labels: { nodes: [] }, comments: { totalCount: 0 },
    isDraft: false, state: 'OPEN', createdAt: '', mergedAt: null, updatedAt: '',
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: `feature-${number}`, isCrossRepository: false, headRefOid,
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  });
}

test('a store snapshot links each session to the operator open PRs whose head its local HEAD reaches', { skip: !hasGit() }, async (context) => {
  const pushing = makeRepoAheadOfOrigin('git@github.com:acme/widgets.git', { commitsAhead: 2 });
  const mainAdvance = pushing.commitOnTop(pushing.baseSha);
  const mergeMasterHead = pushing.commitOnTop(pushing.headSha, mainAdvance);
  const settled = makeRepoAheadOfOrigin('https://github.com/acme/gadgets', { commitsAhead: 0 });
  const elsewhere = makeRepoAheadOfOrigin('https://gitlab.com/acme/widgets.git', { commitsAhead: 1 });
  const harness = storeHarness(context, [
    openPr('acme/widgets', 1, pushing.headSha),
    openPr('acme/widgets', 2, mergeMasterHead),
    openPr('acme/widgets', 3, mainAdvance),
    openPr('acme/widgets', 4, 'f'.repeat(40)),
    openPr('acme/widgets', 6, elsewhere.headSha),
    openPr('acme/gadgets', 5, settled.commitOnTop(settled.headSha)),
    { ...openPr('acme/widgets', 7, pushing.headSha), author: { login: 'teammate' } },
  ]);
  const { store } = harness;
  let joinsSettled = Promise.resolve();
  const wiring = createSessionPrLinkWiring({
    store: {
      ...store,
      subscribe: (event, listener) => store.subscribe(event, () => { joinsSettled = Promise.resolve(listener()); }),
    },
    now: () => LINKED_AT_MS, git: createGitWorkspace(),
  });
  const sessionFor = (id: string, repoDir: string) => {
    const session = new Session({ id, name: id, path: repoDir });
    wiring.attachSession(session);
    return session;
  };
  const pushingSession = sessionFor('pushing', pushing.repoDir);
  const settledSession = sessionFor('settled', settled.repoDir);
  const elsewhereSession = sessionFor('elsewhere', elsewhere.repoDir);
  store.registerWatch({ name: 'my-prs-open', qualifiers: 'is:open author:@me', needsDetail: true });
  store.setWatchedKeys('other-lane', ['acme/widgets#7']);
  try {
    await store.tick();
    await joinsSettled;
    await harness.flushRefreshes();
    await joinsSettled;
    assert.deepEqual(pushingSession.linkedPrs.map((link) => [link.number, link.source]).sort(), [[1, 'sha'], [2, 'sha']]);
    assert.deepEqual(settledSession.linkedPrs, []);
    assert.deepEqual(elsewhereSession.linkedPrs, []);
  } finally {
    for (const repoDir of [pushing.repoDir, settled.repoDir, elsewhere.repoDir]) fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a git push hook refreshes linked PR details while session links keep teammate PRs tracked until the last session detaches', async (context) => {
  const firstHead = 'a'.repeat(40);
  const pushedHead = 'b'.repeat(40);
  const teammatePr = { ...openPr('Acme/widgets', 42, firstHead), author: { login: 'teammate' } };
  const createdPr = openPr('acme/widgets', 7, firstHead);
  const { store, detailCalls, setNodes, flushRefreshes } = storeHarness(context, [teammatePr, createdPr]);
  const wiring = createSessionPrLinkWiring({ store, now: () => LINKED_AT_MS });
  const firstSession = new Session({ id: 'first', name: 'first', path: process.cwd() });
  firstSession.linkPr({ repo: 'Acme/widgets', number: 42, url: teammatePr.url, source: 'hook', linkedAt: LINKED_AT_MS });
  wiring.attachSession(firstSession);
  wiring.attachSession(firstSession);
  await flushRefreshes();
  assert.deepEqual(detailCalls, [['acme/widgets#42']]);
  assert.equal(store.getSnapshot().prs['acme/widgets#42'].headRefOid, firstHead);
  setNodes([{ ...teammatePr, headRefOid: pushedHead }, createdPr]);
  const pushPayload = { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, tool_response: { gitOperation: { push: { branch: 'feature' } } } };
  firstSession.emit('hook-event', { event: 'pretooluse', payload: pushPayload });
  firstSession.emit('hook-event', { event: 'posttooluse', payload: { ...pushPayload, tool_name: 'Read' } });
  await flushRefreshes();
  assert.equal(detailCalls.length, 1);
  firstSession.emit('hook-event', { event: 'posttooluse', payload: pushPayload });
  firstSession.emit('hook-event', { event: 'posttooluse', payload: pushPayload });
  await flushRefreshes();
  assert.deepEqual(detailCalls, [['acme/widgets#42'], ['acme/widgets#42']]);
  assert.equal(store.getSnapshot().prs['acme/widgets#42'].headRefOid, pushedHead);
  const secondSession = new Session({ id: 'second', name: 'second', path: process.cwd() });
  wiring.attachSession(secondSession);
  secondSession.linkPr({ repo: 'acme/widgets', number: 42, url: teammatePr.url, source: 'manual', linkedAt: LINKED_AT_MS });
  firstSession.emit('hook-event', { event: 'posttooluse', payload: bashResult(prOperation('created', 7)) });
  await flushRefreshes();
  assert.equal(store.getSnapshot().prs['acme/widgets#7'].number, 7);
  firstSession.unlinkPr('Acme/widgets#42');
  firstSession.emit('teardown');
  await store.tick();
  assert.deepEqual(Object.keys(store.getSnapshot().prs), ['acme/widgets#42']);
  secondSession.emit('teardown');
  secondSession.emit('hook-event', { event: 'posttooluse', payload: pushPayload });
  const callsBeforeTeardownRefresh = detailCalls.length;
  await flushRefreshes();
  assert.equal(detailCalls.length, callsBeforeTeardownRefresh);
  await store.tick();
  assert.deepEqual(store.getSnapshot().prs, {});
});
