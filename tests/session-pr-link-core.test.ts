import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createSessionPrLinkWiring } from '../server/github/session-pr-link-wiring.ts';
import { MyPr } from '../shared/contracts/my-prs.ts';
import type { MyPrsStatus, SessionPrLinks } from '../shared/contracts/my-prs.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

const LINKED_AT_MS = 1_700_000_000_000;

function makeLinkedSession({ ephemeral = false } = {}) {
  const session = new Session({ id: 'pr-link-test', name: 'pr-link-test', path: process.cwd(), ephemeral });
  createSessionPrLinkWiring({ now: () => LINKED_AT_MS }).attachSession(session);
  return session;
}

function bashResult(gitOperation: Record<string, unknown>): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command: 'gh pr' }, tool_response: { stdout: '', gitOperation } };
}

function prOperation(action: string, number: number) {
  return { pr: { action, number, url: `https://github.com/acme/widgets/pull/${number}` } };
}

test('gh pr create and gh pr edit link the PR the moment the Bash hook lands', () => {
  const session = makeLinkedSession();
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

test('commenting on a PR, pushing a branch, a commit, or a non-github host links nothing', () => {
  const session = makeLinkedSession();
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

test('an ephemeral session never gains hook links', () => {
  const session = makeLinkedSession({ ephemeral: true });
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

function openPr(repo: string, number: number, headRefOid: string): MyPr {
  return MyPr.parse({
    key: `${repo}#${number}`, repo, number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`,
    isDraft: false, state: 'OPEN', createdAt: '', mergedAt: null, updatedAt: '',
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: `feature-${number}`, isCrossRepository: false, headRefOid,
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], behindBy: null,
    reviewRequests: [], approvals: 0, reviews: [], stage: 'ready',
  });
}

test('a my-prs-status publish links each session to the open PRs whose head its local HEAD reaches', { skip: !hasGit() }, async () => {
  const pushing = makeRepoAheadOfOrigin('git@github.com:acme/widgets.git', { commitsAhead: 2 });
  const mainAdvance = pushing.commitOnTop(pushing.baseSha);
  const mergeMasterHead = pushing.commitOnTop(pushing.headSha, mainAdvance);
  const settled = makeRepoAheadOfOrigin('https://github.com/acme/gadgets', { commitsAhead: 0 });
  const elsewhere = makeRepoAheadOfOrigin('https://gitlab.com/acme/widgets.git', { commitsAhead: 1 });
  const wiring = createSessionPrLinkWiring({ now: () => LINKED_AT_MS, git: createGitWorkspace() });
  const sessionFor = (id: string, repoDir: string) => {
    const session = new Session({ id, name: id, path: repoDir });
    wiring.attachSession(session);
    return session;
  };
  const pushingSession = sessionFor('pushing', pushing.repoDir);
  const settledSession = sessionFor('settled', settled.repoDir);
  const elsewhereSession = sessionFor('elsewhere', elsewhere.repoDir);
  const status: MyPrsStatus = {
    type: 'my-prs-status', ts: LINKED_AT_MS, configured: true, viewer: 'operator', prs: [
      openPr('acme/widgets', 1, pushing.headSha),
      openPr('acme/widgets', 2, mergeMasterHead),
      openPr('acme/widgets', 3, mainAdvance),
      openPr('acme/widgets', 4, 'f'.repeat(40)),
      openPr('acme/widgets', 6, elsewhere.headSha),
      openPr('acme/gadgets', 5, settled.commitOnTop(settled.headSha)),
    ],
  };
  try {
    await wiring.onMyPrsStatus(status);
    await wiring.onMyPrsStatus(status);
    assert.deepEqual(pushingSession.linkedPrs.map((link) => [link.number, link.source]).sort(), [[1, 'sha'], [2, 'sha']]);
    assert.deepEqual(settledSession.linkedPrs, []);
    assert.deepEqual(elsewhereSession.linkedPrs, []);
  } finally {
    for (const repoDir of [pushing.repoDir, settled.repoDir, elsewhere.repoDir]) fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
