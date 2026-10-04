import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRebaseRecord, deriveStage, hasUnresolvedThreads, isMovedBranchPushRejection, keepMergeableAttemptKey, keepMergeableClaudeArgs, keepMergeablePermissions, MY_PRS_FIX_ALLOW_RULES, MY_PRS_FIX_DENY_RULES, keepMergeableFixesToCancel, keepMergeableHandoff, keepMergeablePrompt, keepMergeablePushArgs, keepMergeablePushTarget, keepMergeablePushUrl, shouldFixMergeability, shouldAutoRebase, mergedSinceDate, myPrsShouldStart, prunedKeepMergeableState, sortedMyPrs, threadExcerpt, toMyPr, toMyPrThreads, truncatedSearchNote } from '../server/core/my-prs-core.ts';
import { MyPrSearchNode } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrSearchNode as MyPrSearchNodeType, MyPrThreadNode } from '../shared/contracts/my-prs.ts';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const SHA = 'a'.repeat(40);
function searchNode(): MyPrSearchNodeType {
  return {
    __typename: 'PullRequest', id: 'PR_node', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', isDraft: false,
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T11:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: SHA, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true }] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }] },
    latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: '2026-09-28T10:00:00Z', author: { login: 'bob' } }] },
  };
}
function readyPr(): MyPr { return toMyPr(searchNode(), 0); }

test('keep mergeable dispatches only flagged open conflicting or failing heads once per head', () => {
  const pr = readyPr();
  const flaggedKeys = new Set([pr.key]);
  const conflict = { ...pr, mergeable: 'CONFLICTING' as const };
  const attemptKey = keepMergeableAttemptKey(conflict);
  assert.equal(attemptKey, `${pr.key}@${SHA}`);
  assert.equal(shouldFixMergeability(conflict, new Set(), new Set()), false);
  assert.equal(shouldFixMergeability(conflict, flaggedKeys, new Set()), true);
  assert.equal(shouldFixMergeability(conflict, flaggedKeys, new Set([attemptKey])), false);
  assert.equal(shouldFixMergeability({ ...conflict, headRefOid: 'b'.repeat(40) }, flaggedKeys, new Set([attemptKey])), true);
  for (const state of ['FAILURE', 'ERROR'] as const) {
    assert.equal(shouldFixMergeability({ ...pr, checks: { ...pr.checks, state } }, flaggedKeys, new Set()), true);
  }
  for (const state of ['SUCCESS', 'PENDING', 'EXPECTED', null] as const) {
    assert.equal(shouldFixMergeability({ ...pr, checks: { ...pr.checks, state } }, flaggedKeys, new Set()), false);
  }
  assert.equal(shouldFixMergeability({ ...pr, mergeStateStatus: 'BEHIND', behindBy: 3 }, flaggedKeys, new Set()), false);
  assert.equal(shouldFixMergeability({ ...pr, mergeStateStatus: 'DIRTY' }, flaggedKeys, new Set()), false);
  for (const state of ['CLOSED', 'MERGED'] as const) {
    assert.equal(shouldFixMergeability({ ...conflict, state }, flaggedKeys, new Set()), false);
  }
});

test('keep mergeable prompt pins the local checkout and asks for repairs committed locally, never pushed or merged', () => {
  const pr = { ...readyPr(), headRefName: 'fix/checks', isCrossRepository: true };
  const prompt = keepMergeablePrompt(pr);
  for (const text of [pr.key, pr.headRefName, pr.baseRefName, pr.headRefOid, 'Fix merge conflicts', 'fix failing checks', 'commit the repairs locally', 'Do not push and do not merge', 'no network access to GitHub', 'anything under .github/', 'CODEOWNERS', 'credential or secret files']) {
    assert.ok(prompt.includes(text), text);
  }
  for (const text of ['gh repo clone', 'gh pr checkout', 'push to the PR head branch', 'fork remote']) {
    assert.equal(prompt.includes(text), false, text);
  }
});

test('only GitHub slugs get a keep mergeable push url', () => {
  assert.equal(keepMergeablePushUrl('Acme/app'), 'https://github.com/Acme/app.git');
  for (const repo of ['Acme', 'Acme/app/extra', '-x/app', 'Acme/app.git --upload-pack=x', '../app']) assert.equal(keepMergeablePushUrl(repo), null, repo);
});

test('keep mergeable pushes with a lease pinned to the exact head the repair started from and never a plain force', () => {
  const pushArgs = keepMergeablePushArgs('https://github.com/Acme/app.git', 'fix/checks', 'a'.repeat(40), 'b'.repeat(40));
  assert.deepEqual(pushArgs, ['push', '--no-verify', '--quiet', `--force-with-lease=refs/heads/fix/checks:${'a'.repeat(40)}`, 'https://github.com/Acme/app.git', `${'b'.repeat(40)}:refs/heads/fix/checks`]);
  assert.ok(!pushArgs.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('+')), pushArgs.join(' '));
});

test('keep mergeable pushes only to the open same-repository PR branch whose listed head is still the scheduled one', () => {
  const pr = { ...readyPr(), headRefName: 'fix/checks' };
  assert.deepEqual(keepMergeablePushTarget(pr, pr), { push: true, url: 'https://github.com/Acme/app.git', branch: 'fix/checks' });
  const refusals: [string, ReturnType<typeof keepMergeablePushTarget>][] = [
    ['fork', keepMergeablePushTarget({ ...pr, isCrossRepository: true }, { ...pr, isCrossRepository: true })],
    ['fork', keepMergeablePushTarget({ ...pr, isCrossRepository: true }, undefined)],
    ['fork', keepMergeablePushTarget(pr, { ...pr, isCrossRepository: true })],
    ['no longer listed', keepMergeablePushTarget(pr, undefined)],
    ['closed', keepMergeablePushTarget(pr, { ...pr, state: 'CLOSED' })],
    ['merged', keepMergeablePushTarget(pr, { ...pr, state: 'MERGED' })],
    ['head moved', keepMergeablePushTarget(pr, { ...pr, headRefOid: 'c'.repeat(40) })],
    ['branch changed', keepMergeablePushTarget(pr, { ...pr, headRefName: 'other' })],
    ['not a GitHub repository', keepMergeablePushTarget({ ...pr, repo: '../app' }, pr)],
  ];
  for (const [reason, decision] of refusals) {
    assert.equal(decision.push, false, reason);
    assert.match(JSON.stringify(decision), new RegExp(reason), reason);
  }
  for (const headRefName of ['-x', '+main', 'a..b', 'a b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[b', 'a\\b', 'a@{1}', 'a/', 'a.', 'a.lock', 'a//b', 'a/.b', '/a', '.a']) {
    const branchPr = { ...pr, headRefName };
    assert.equal(keepMergeablePushTarget(branchPr, branchPr).push, false, headRefName);
  }
  for (const headRefName of ['main', 'feature/x-1', 'release/2026.10', 'user@host']) {
    const branchPr = { ...pr, headRefName };
    assert.equal(keepMergeablePushTarget(branchPr, branchPr).push, true, headRefName);
  }
});

test('keep mergeable recognises a moved branch push rejection from the non-fast-forward and lease wordings', () => {
  assert.equal(isMovedBranchPushRejection(' ! [rejected]        abc -> fix/checks (non-fast-forward)\nerror: failed to push some refs'), true);
  assert.equal(isMovedBranchPushRejection(' ! [rejected]        abc -> fix/checks (fetch first)\nerror: failed to push some refs'), true);
  assert.equal(isMovedBranchPushRejection(' ! [rejected]        abc -> fix/checks (stale info)\nerror: failed to push some refs'), true);
  assert.equal(isMovedBranchPushRejection('fatal: Authentication failed'), false);
  assert.equal(isMovedBranchPushRejection(' ! [remote rejected] abc -> fix/checks (protected branch hook declined)'), false);
});

test('keep mergeable hands off only a new commit on top of the head that leaves workflows as head or base had them', () => {
  const headSha = 'a'.repeat(40);
  const resultSha = 'b'.repeat(40);
  const handoff = (changedFromHead: string[], changedFromBase: string[], overrides: { resultSha?: string; isResultOnTopOfHead?: boolean } = {}) => keepMergeableHandoff({
    headSha, resultSha: overrides.resultSha ?? resultSha, isResultOnTopOfHead: overrides.isResultOnTopOfHead ?? true, changedFromHead, addedFromHead: [], changedFromBase,
  });
  assert.deepEqual(handoff(['src/a.ts'], ['src/a.ts']), { push: true });
  assert.deepEqual(handoff(['.github/workflows/ci.yml', 'src/a.ts'], ['src/a.ts']), { push: true });
  assert.deepEqual(handoff(['src/a.ts'], ['.github/workflows/ci.yml']), { push: true });
  assert.equal(handoff(['.github/workflows/evil.yml'], ['.github/workflows/evil.yml']).push, false);
  assert.match(JSON.stringify(handoff(['.github/workflows/evil.yml'], ['.github/workflows/evil.yml'])), /workflow/);
  assert.equal(handoff([], [], { resultSha: headSha }).push, false);
  assert.equal(handoff(['src/a.ts'], ['src/a.ts'], { isResultOnTopOfHead: false }).push, false);
});

test('keep mergeable refuses a change anywhere in the .github tree, including the bare entry, and allows a lookalike sibling', () => {
  const handoff = (changedPath: string) => keepMergeableHandoff({ headSha: 'a'.repeat(40), resultSha: 'b'.repeat(40), isResultOnTopOfHead: true, changedFromHead: [changedPath], addedFromHead: [], changedFromBase: [changedPath] });
  for (const githubPath of ['.github', '.github/workflows', '.github/CODEOWNERS', '.github/dependabot.yml', '.github/actions/setup/action.yml', '.github\\actions\\setup\\action.yml']) {
    assert.equal(handoff(githubPath).push, false, githubPath);
  }
  assert.match(JSON.stringify(handoff('.github/actions/setup/action.yml')), /\.github\/actions\/setup\/action\.yml/);
  assert.equal(handoff('.githubx').push, true);
  assert.equal(handoff('docs/.github/notes.md').push, true);
});

test('keep mergeable refuses a session commit that adds a credential-like file neither head nor base had', () => {
  const handoff = ({ addedFromHead, changedFromBase }: { addedFromHead: string[]; changedFromBase: string[] }) => keepMergeableHandoff({
    headSha: 'a'.repeat(40), resultSha: 'b'.repeat(40), isResultOnTopOfHead: true, changedFromHead: addedFromHead, addedFromHead, changedFromBase,
  });
  for (const credentialPath of ['.env', '.env.local', 'config/server.pem', 'keys/id_rsa', 'keys/id_rsa.pub', '.npmrc', 'home/.netrc', 'credentials.json', 'tls/server.key', 'nested\\dir\\.env']) {
    const decision = handoff({ addedFromHead: ['src/a.ts', credentialPath], changedFromBase: ['src/a.ts', credentialPath] });
    assert.equal(decision.push, false, credentialPath);
    assert.match(JSON.stringify(decision), /credential/, credentialPath);
  }
  assert.deepEqual(handoff({ addedFromHead: ['.env.example'], changedFromBase: [] }), { push: true }, 'a credential-like file the merge brought from base is allowed');
  assert.deepEqual(handoff({ addedFromHead: ['src/env.ts', 'src/keys.ts', 'docs/credential-rotation.md'], changedFromBase: ['src/env.ts', 'src/keys.ts', 'docs/credential-rotation.md'] }), { push: true });
  const modifiedNotAdded = keepMergeableHandoff({ headSha: 'a'.repeat(40), resultSha: 'b'.repeat(40), isResultOnTopOfHead: true, changedFromHead: ['.env.example'], addedFromHead: [], changedFromBase: ['.env.example'] });
  assert.deepEqual(modifiedNotAdded, { push: true }, 'editing a file head already had is not an add');
});

test('keep mergeable refuses a non-ASCII, tab, quote or newline workflow path', () => {
  const awkwardWorkflowPaths = ['.github/workflows/\u00e9.yml', '.github/workflows/a\tb.yml', '.github/workflows/"q".yml', '.github/workflows/line\nbreak.yml', '.github/workflows/trailing .yml '];
  const changedPaths = ['src/a.ts', ...awkwardWorkflowPaths];
  for (const workflowPath of awkwardWorkflowPaths) {
    const decision = keepMergeableHandoff({ headSha: 'a'.repeat(40), resultSha: 'b'.repeat(40), isResultOnTopOfHead: true, changedFromHead: ['src/a.ts', workflowPath], addedFromHead: [], changedFromBase: changedPaths });
    assert.equal(decision.push, false, JSON.stringify(workflowPath));
  }
});

test('keep mergeable cancels in-flight fixes whose flag is gone or whose PR is listed and no longer open', () => {
  const flaggedKeys = new Set(['Acme/app#1', 'Acme/app#2', 'Acme/app#3']);
  const prs = [{ key: 'Acme/app#1', state: 'OPEN' as const }, { key: 'Acme/app#2', state: 'MERGED' as const }];
  assert.deepEqual(keepMergeableFixesToCancel(['Acme/app#1', 'Acme/app#2', 'Acme/app#3', 'Acme/app#4'], flaggedKeys, prs), ['Acme/app#2', 'Acme/app#4']);
});

test('normalizes failing checks, pending checks, requests, approvals, and unresolved threads', () => {
  const node = searchNode();
  node.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'lint', conclusion: 'TIMED_OUT', status: 'COMPLETED' },
    { __typename: 'CheckRun', name: 'build', conclusion: null, status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'test', state: 'ERROR' },
  ] } };
  node.reviewThreads.nodes.push({ isResolved: false });
  node.reviewRequests.nodes.push({ requestedReviewer: { __typename: 'Team', slug: 'docs', avatarUrl: 'https://github.com/Acme.png', organization: { login: 'Acme' } } });
  node.reviewRequests.nodes.push({ requestedReviewer: { __typename: 'User', login: 'ana' } });
  const pr = toMyPr(node, 3);
  assert.deepEqual(pr.checks, { state: 'FAILURE', failing: ['lint', 'test'], pendingCount: 1 });
  assert.equal(pr.unresolvedThreads, 1);
  assert.deepEqual(pr.reviewRequests, [
    { name: 'Acme/docs', isTeam: true, avatarUrl: 'https://github.com/Acme.png' },
    { name: 'ana', isTeam: false, avatarUrl: null },
  ]);
  assert.equal(pr.approvals, 1);
  assert.equal(pr.behindBy, 3);
  assert.equal(pr.stage, 'checks-failing');
});

test('derives every stage in precedence order', () => {
  const base = readyPr();
  const cases: [Partial<MyPr>, MyPr['stage']][] = [
    [{ state: 'MERGED', isDraft: true }, 'merged'],
    [{ isDraft: true, mergeable: 'CONFLICTING' }, 'draft'],
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'BEHIND' }, 'conflicts'],
    [{ mergeStateStatus: 'DIRTY' }, 'conflicts'],
    [{ mergeStateStatus: 'BEHIND', checks: { state: 'FAILURE', failing: [], pendingCount: 0 } }, 'behind'],
    [{ checks: { state: 'ERROR', failing: [], pendingCount: 0 }, reviewDecision: 'CHANGES_REQUESTED' }, 'checks-failing'],
    [{ reviewDecision: 'CHANGES_REQUESTED', unresolvedThreads: 1 }, 'changes-requested'],
    [{ unresolvedThreads: 1, checks: { state: 'PENDING', failing: [], pendingCount: 1 } }, 'unresolved-threads'],
    [{ checks: { state: 'EXPECTED', failing: [], pendingCount: 1 }, reviewDecision: 'REVIEW_REQUIRED' }, 'checks-pending'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, 'needs-approval'],
    [{ mergeStateStatus: 'BLOCKED' }, 'needs-approval'],
    [{}, 'ready'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'unknown'],
  ];
  for (const [changes, expected] of cases) assert.equal(deriveStage({ ...base, ...changes }), expected);
});

test('retains merged PRs for 24 hours and sorts work before waiting, ready, drafts, merged', () => {
  assert.equal(mergedSinceDate(NOW), '2026-09-27');
  const base = readyPr();
  const make = (stage: MyPr['stage'], number: number): MyPr => ({ ...base, key: `Acme/app#${number}`, number, stage });
  const merged = { ...make('merged', 4), state: 'MERGED' as const, mergedAt: new Date(NOW - 86400000).toISOString() };
  const olderMerged = { ...merged, number: 5, mergedAt: new Date(NOW - 86400001).toISOString() };
  const closed = { ...make('unknown', 6), state: 'CLOSED' as const };
  const prs = sortedMyPrs([merged, olderMerged, closed, make('draft', 3), make('ready', 2), make('needs-approval', 1), make('conflicts', 9)], NOW);
  assert.deepEqual(prs.map((pr) => pr.number), [9, 1, 2, 3, 4]);
});

test('a bot review request keeps the pull request and lists no reviewer for it', () => {
  const node = { ...searchNode(), reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Bot' } }, { requestedReviewer: { __typename: 'User', login: 'ana' } }] } };
  const parsed = MyPrSearchNode.safeParse(node);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success ? toMyPr(parsed.data, 0).reviewRequests : null, [{ name: 'ana', isTeam: false, avatarUrl: null }]);
});

test('myPrsShouldStart refuses when team review is disabled', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: false, org: 'Acme' }), { start: false, reason: 'Team review is disabled' });
});

test('myPrsShouldStart refuses without an organization', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: true, org: '' }), { start: false, reason: 'Team review needs an organization' });
});

test('myPrsShouldStart starts with an organization and no team', () => {
  assert.deepEqual(myPrsShouldStart({ enabled: true, org: 'Acme' }), { start: true });
});

test('truncatedSearchNote names the shown and total counts only when the search was cut', () => {
  assert.equal(truncatedSearchNote(50, 73), 'Showing the 50 most recently updated of 73 pull requests.');
  assert.equal(truncatedSearchNote(12, 12), null);
  assert.equal(truncatedSearchNote(0, 0), null);
});

test('prunedKeepMergeableState drops flags and head attempts for unlisted PRs only when the search is complete', () => {
  const listedHead = keepMergeableAttemptKey({ key: 'Acme/app#1', headRefOid: 'a'.repeat(40) });
  const prefixTwinHead = keepMergeableAttemptKey({ key: 'Acme/app#10', headRefOid: 'b'.repeat(40) });
  const saved = { keepMergeableKeys: ['Acme/app#1', 'Acme/app#10'], keepMergeableAttemptKeys: [listedHead, prefixTwinHead] };
  const listedPrKeys = new Set(['Acme/app#1']);
  assert.deepEqual(prunedKeepMergeableState({ ...saved, listedPrKeys, returnedCount: 1, totalCount: 1 }), { keepMergeableKeys: ['Acme/app#1'], keepMergeableAttemptKeys: [listedHead] });
  assert.deepEqual(prunedKeepMergeableState({ ...saved, listedPrKeys, returnedCount: 50, totalCount: 73 }), saved);
  assert.deepEqual(prunedKeepMergeableState({ ...saved, listedPrKeys: new Set(), returnedCount: 0, totalCount: 0 }), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
});

function threadNode(overrides: Partial<MyPrThreadNode> = {}): MyPrThreadNode {
  return {
    isResolved: false, isOutdated: false, path: 'src/app.ts', line: 12,
    firstComment: { totalCount: 3, nodes: [{ author: { login: 'bob' }, bodyText: 'Please\n\n rename   this', url: 'https://github.com/Acme/app/pull/7#discussion_r1', createdAt: '2026-09-28T09:00:00Z' }] },
    lastComment: { nodes: [{ author: { login: 'alice' }, createdAt: '2026-09-28T10:00:00Z' }] },
    ...overrides,
  };
}

test('toMyPrThreads keeps unresolved threads with location, excerpt, and last reply', () => {
  const threads = toMyPrThreads([threadNode(), threadNode({ isResolved: true })], 'https://github.com/Acme/app/pull/7');
  assert.deepEqual(threads, [{
    path: 'src/app.ts', line: 12, isOutdated: false, url: 'https://github.com/Acme/app/pull/7#discussion_r1',
    author: 'bob', excerpt: 'Please rename this', commentCount: 3, lastAuthor: 'alice', lastActivityAt: '2026-09-28T10:00:00Z',
  }]);
});

test('toMyPrThreads falls back to the pull request link and a null author when comments are gone', () => {
  const [thread] = toMyPrThreads([threadNode({ firstComment: { totalCount: 0, nodes: [] }, lastComment: { nodes: [] } })], 'https://github.com/Acme/app/pull/7');
  assert.equal(thread.url, 'https://github.com/Acme/app/pull/7');
  assert.equal(thread.author, null);
  assert.equal(thread.lastAuthor, null);
  assert.equal(thread.commentCount, 1);
});

test('threadExcerpt cuts long comments at a word boundary', () => {
  const excerpt = threadExcerpt(`${'word '.repeat(60)}end`);
  assert.ok(excerpt.endsWith('word...'));
  assert.ok(excerpt.length <= 203);
  assert.equal(threadExcerpt('short'), 'short');
});

test('toMyPr carries thread detail beside the unresolved count', () => {
  const node = searchNode();
  node.reviewThreads.nodes.push({ isResolved: false });
  const pr = toMyPr(node, 0, [threadNode()]);
  assert.equal(pr.unresolvedThreads, 1);
  assert.equal(pr.threads.length, 1);
  assert.equal(pr.stage, 'unresolved-threads');
});

test('toMyPr never counts fewer unresolved threads than the detail lists', () => {
  const node = searchNode();
  node.reviewThreads.nodes.push({ isResolved: false });
  const pr = toMyPr(node, 0, [threadNode(), threadNode({ path: 'src/b.ts' }), threadNode({ path: 'src/c.ts' })]);
  assert.equal(pr.unresolvedThreads, 3);
  assert.equal(pr.threads.length, 3);
});

test('toMyPr carries the opened time and each latest review with its reviewer and time', () => {
  const node = searchNode();
  node.latestReviews.nodes.push({ state: 'COMMENTED', submittedAt: null, author: null });
  const pr = toMyPr(node, 0);
  assert.equal(pr.createdAt, '2026-09-25T00:00:00Z');
  assert.deepEqual(pr.reviews, [
    { reviewer: 'bob', state: 'APPROVED', submittedAt: '2026-09-28T10:00:00Z' },
    { reviewer: null, state: 'COMMENTED', submittedAt: null },
  ]);
});

test('hasUnresolvedThreads asks for detail when the first page is all resolved but more pages exist', () => {
  const node = searchNode();
  assert.equal(hasUnresolvedThreads(node), false);
  node.reviewThreads.pageInfo.hasNextPage = true;
  assert.equal(hasUnresolvedThreads(node), true);
});

test('auto-rebase picks only an open, ready, behind pull request without conflicts, running checks or a failed attempt at its head', () => {
  const noFailures = new Set<string>();
  assert.equal(shouldAutoRebase(searchNode(), 3, noFailures), true);
  assert.equal(shouldAutoRebase(searchNode(), 0, noFailures), false);
  assert.equal(shouldAutoRebase(searchNode(), null, noFailures), false);
  assert.equal(shouldAutoRebase({ ...searchNode(), isDraft: true }, 3, noFailures), false);
  assert.equal(shouldAutoRebase({ ...searchNode(), state: 'MERGED' }, 3, noFailures), false);
  assert.equal(shouldAutoRebase({ ...searchNode(), isInMergeQueue: true }, 3, noFailures), false);
  assert.equal(shouldAutoRebase({ ...searchNode(), mergeable: 'CONFLICTING' }, 3, noFailures), false);
  assert.equal(shouldAutoRebase({ ...searchNode(), mergeStateStatus: 'DIRTY' }, 3, noFailures), false);
  for (const state of ['PENDING', 'EXPECTED'] as const) {
    const running = searchNode();
    running.commits.nodes[0].commit.statusCheckRollup = { state, contexts: { nodes: [] } };
    assert.equal(shouldAutoRebase(running, 3, noFailures), false, state);
  }
  const failing = searchNode();
  failing.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE', contexts: { nodes: [] } };
  assert.equal(shouldAutoRebase(failing, 3, noFailures), true);
  assert.equal(shouldAutoRebase({ ...searchNode(), commits: { nodes: [] } }, 3, noFailures), true);
  assert.equal(shouldAutoRebase(searchNode(), 3, new Set([`Acme/app#7@${SHA}`])), false);
  assert.equal(shouldAutoRebase(searchNode(), 3, new Set([`Acme/app#7@${'b'.repeat(40)}`])), true);
});

test('auto-rebase records name the base on success and the first error line on failure', () => {
  assert.deepEqual(autoRebaseRecord({ ok: true, err: '' }, 'main', NOW), { outcome: 'rebased', at: NOW, message: 'Rebased onto main' });
  assert.deepEqual(autoRebaseRecord({ ok: false, err: '\n  conflict in a.ts\nsecond' }, 'main', NOW), { outcome: 'failed', at: NOW, message: 'conflict in a.ts' });
  assert.deepEqual(autoRebaseRecord({ ok: false, err: '' }, 'main', NOW), { outcome: 'failed', at: NOW, message: 'GitHub refused the rebase' });
});

test('keep mergeable is bounded by acceptEdits with only the probed git allow rules and never a bare Write allow', () => {
  const permissions = keepMergeablePermissions();
  assert.equal(permissions.defaultMode, 'acceptEdits');
  assert.notEqual(permissions.defaultMode, 'bypassPermissions');
  assert.deepEqual(permissions.deny, [...MY_PRS_FIX_DENY_RULES]);
  assert.equal(Object.hasOwn(permissions, 'allow'), false);
  assert.deepEqual([...MY_PRS_FIX_ALLOW_RULES], ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git merge:*)']);
  for (const rule of MY_PRS_FIX_ALLOW_RULES) assert.equal(/^(Write|Edit|Bash)$|^(Write|Edit)\(/.test(rule), false, rule);
});

test('keep mergeable ends its variadic tool lists with an option, or the bootstrap prompt is eaten as a rule', () => {
  const args = keepMergeableClaudeArgs();
  assert.deepEqual(args, ['-p', '--allowedTools', ...MY_PRS_FIX_ALLOW_RULES, '--disallowedTools', ...MY_PRS_FIX_DENY_RULES, '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local']);
  assert.equal(args[args.indexOf('--disallowedTools') + MY_PRS_FIX_DENY_RULES.length + 1], '--strict-mcp-config', 'probed: a trailing --disallowedTools list ate the prompt with "Input must be provided"');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});
