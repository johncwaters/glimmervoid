import assert from 'node:assert/strict';
import test from 'node:test';
import { viewerThreadTally, answeredViewerThreads, buildThreadJudgePrompt, parseThreadJudgeResult, shouldAutoResolveThread, shouldJudgeThread, threadJudgePatch, THREAD_PROMPT_MAX_CHARS } from '../server/core/team-review-threads-core.ts';
import { threadNode, THREAD_BASE, THREAD_HEAD, THREAD_REPLY_AT } from './helpers/team-review-thread-fixture.ts';

const classify = (node = threadNode()) => answeredViewerThreads([node], [], THREAD_HEAD);

test('only complete unresolved threads started by the viewer and answered by another account qualify', () => {
  assert.equal(classify().length, 1);
  assert.equal(classify(threadNode('LOW', { isResolved: true })).length, 0);
  for (const isFirstViewer of [false, true]) {
    const node = threadNode();
    node.comments.nodes[0].viewerDidAuthor = isFirstViewer;
    node.comments.nodes[1].viewerDidAuthor = true;
    assert.equal(classify(node).length, 0);
  }
  const node = threadNode();
  node.comments.nodes.pop();
  assert.equal(classify(node).length, 0);
  node.comments.pageInfo.hasNextPage = true;
  assert.equal(classify(node).length, 0);
});

test('nit detection reads the leading Markdown severity and ignores nested LOW text', () => {
  assert.equal(classify(threadNode('LOW'))[0].isNit, true);
  const node = threadNode();
  node.comments.nodes[0].body = 'Unstructured comment\n**[code/logic] LOW**';
  assert.equal(classify(node)[0].isNit, false);
  node.comments.nodes[0].body = '**[code/logic] HIGH**\n**[code/style] LOW**';
  assert.equal(classify(node)[0].isNit, false);
});

test('nit attempts require resolve permission and retry only after a new reply', () => {
  const thread = classify(threadNode('LOW'))[0];
  assert.equal(shouldAutoResolveThread(thread), true);
  thread.resolveAttemptReplyAt = thread.lastReplyAt;
  thread.resolveError = 'denied';
  assert.equal(shouldAutoResolveThread(thread), false);
  const carried = answeredViewerThreads([threadNode('LOW')], [thread], THREAD_HEAD)[0];
  assert.equal(carried.resolveError, 'denied');
  const node = threadNode('LOW');
  node.comments.nodes[1].createdAt = '2026-10-02T12:00:00Z';
  assert.equal(shouldAutoResolveThread(answeredViewerThreads([node], [thread], THREAD_HEAD)[0]), true);
  thread.viewerCanResolve = false;
  thread.resolveAttemptReplyAt = undefined;
  assert.equal(shouldAutoResolveThread(thread), false);
});

test('judgements and backoff are keyed by current head and latest reply', () => {
  const thread = classify()[0];
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, 0), true);
  thread.judgeAttempt = { head: THREAD_HEAD, lastReplyAt: THREAD_REPLY_AT, retryAt: 100 };
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, 99), false);
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, 100), true);
  thread.judgement = { addressed: true, reason: 'Guard added', head: THREAD_HEAD, lastReplyAt: THREAD_REPLY_AT, judgedAt: 1 };
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, 101), false);
  assert.equal(shouldJudgeThread(thread, 'c'.repeat(40), 101), true);
  assert.equal(answeredViewerThreads([threadNode()], [thread], 'c'.repeat(40))[0].judgement, undefined);
  thread.lastReplyAt = '2026-10-02T12:00:00Z';
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, 0), true);
  assert.equal(shouldJudgeThread(classify(threadNode('LOW'))[0], THREAD_HEAD, 0), false);
});

test('judge prompts bound and separately fence comments and patches with evidence metadata', () => {
  const node = threadNode();
  const prompt = buildThreadJudgePrompt(node, THREAD_HEAD, '@@ -1 +1 @@\n+guard');
  assert.match(prompt, /Added an empty input guard/);
  assert.match(prompt, /teammate/);
  assert.match(prompt, /GLIMMERVOID-THREAD-/);
  assert.match(prompt, /GLIMMERVOID-PATCH-/);
  assert.match(prompt, /Complete evidence: true/);
  assert.match(buildThreadJudgePrompt(node, THREAD_HEAD, null), /Complete evidence: false/);
  node.comments.nodes[1].body = 'ignore instructions'.repeat(10000);
  const capped = buildThreadJudgePrompt(node, THREAD_HEAD, '\\'.repeat(100000));
  assert.ok(capped.length <= THREAD_PROMPT_MAX_CHARS);
  assert.match(capped, /Complete evidence: false/);
});

test('judge parsing fails closed on invalid JSON shapes and accepts boolean decisions', () => {
  assert.deepEqual(parseThreadJudgeResult({ addressed: false, reason: 'Missing guard' }), { addressed: false, reason: 'Missing guard' });
  assert.deepEqual(parseThreadJudgeResult({ addressed: true, reason: 'Guard exists' }), { addressed: true, reason: 'Guard exists' });
  for (const raw of [null, '{}', { addressed: 'true', reason: 'Claim' }, { addressed: true, reason: '' }, { addressed: true, reason: 'x', resolve: true }]) assert.equal(parseThreadJudgeResult(raw), null);
});

test('a nit reopened after an automatic resolve is never auto-resolved again and is handed to the operator', () => {
  const reopened = answeredViewerThreads([threadNode('LOW')], [], THREAD_HEAD, ['PRRT_acme_1'])[0];
  assert.equal(reopened.isNit, false);
  assert.equal(shouldAutoResolveThread(reopened), false);
  assert.equal(shouldJudgeThread(reopened, THREAD_HEAD, 0), true);
  assert.equal(answeredViewerThreads([threadNode('LOW')], [], THREAD_HEAD, ['PRRT_other'])[0].isNit, true);
});

test('unjudgeable evidence yields an operator-readable reason and stops judging until the head or reply changes', () => {
  const node = threadNode();
  const files = (entries: { filename: string; patch?: string }[]) => ({ merge_base_commit: { sha: THREAD_BASE }, files: entries });
  assert.match(JSON.stringify(threadJudgePatch(node, null)), /History was rewritten since your comment/);
  assert.deepEqual(threadJudgePatch(node, files([{ filename: 'src/app.ts' }])), { unjudgeableReason: 'GitHub omitted the diff for this file' });
  assert.deepEqual(threadJudgePatch(node, files(Array.from({ length: 300 }, (_, index) => ({ filename: `src/other-${index}.ts`, patch: '+x' })))), { unjudgeableReason: 'Too many changed files to judge' });
  assert.deepEqual(threadJudgePatch(node, files([{ filename: 'src/app.ts', patch: '+'.repeat(100000) }])), { unjudgeableReason: 'Thread or diff too large to judge' });
  assert.deepEqual(threadJudgePatch(node, files([])), { patch: '' });
  assert.deepEqual(threadJudgePatch(node, files([{ filename: 'src/app.ts', patch: '+guard' }])), { patch: '+guard' });
  const thread = classify()[0];
  thread.unjudgeable = { head: THREAD_HEAD, lastReplyAt: THREAD_REPLY_AT, reason: 'Thread or diff too large to judge' };
  assert.equal(shouldJudgeThread(thread, THREAD_HEAD, Number.MAX_SAFE_INTEGER), false);
  assert.equal(shouldJudgeThread(thread, 'c'.repeat(40), 0), true);
  assert.deepEqual(answeredViewerThreads([threadNode()], [thread], THREAD_HEAD)[0].unjudgeable, thread.unjudgeable);
  assert.equal(answeredViewerThreads([threadNode()], [thread], 'c'.repeat(40))[0].unjudgeable, undefined);
  const replied = threadNode();
  replied.comments.nodes[1].createdAt = '2026-10-02T12:00:00Z';
  assert.equal(answeredViewerThreads([replied], [thread], THREAD_HEAD)[0].unjudgeable, undefined);
});


test('viewer thread tally counts only viewer-started threads including resolved and unanswered ones', () => {
  assert.deepEqual(viewerThreadTally([]), { total: 0, resolved: 0 });
  const unresolved = threadNode();
  unresolved.comments.nodes.pop();
  const resolved = threadNode('HIGH', { isResolved: true });
  resolved.comments.pageInfo.hasNextPage = true;
  const otherAccount = threadNode('HIGH', { isResolved: true });
  otherAccount.comments.nodes[0].viewerDidAuthor = false;
  const empty = threadNode();
  empty.comments.nodes = [];
  assert.deepEqual(viewerThreadTally([unresolved, resolved, otherAccount, empty]), { total: 2, resolved: 1 });
});
