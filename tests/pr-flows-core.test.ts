import './helpers/isolate-home.ts';
import test from 'node:test';
import { z } from 'zod';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { GithubPr, GithubPrDetailNode } from '../shared/contracts/github-prs.ts';
import type { MyPrThread, MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { myPrFromGithubPr } from '../shared/my-pr-merge.ts';
import { PR_ACTION_REPORT_URL_ENV, PR_ACTION_TOKEN_ENV, prActionReportPath, PrFlowCommand, PrFlowPrAction, PrFlowRule, PrFlowSourceCommand, PrFlowSourceOutput, PrFlowsState } from '../shared/contracts/pr-flows.ts';
import type { PrFlowsStatus } from '../shared/contracts/pr-flows.ts';
import { createPrFlowsWiring } from '../server/github/pr-flows-wiring.ts';
import { createPrFlowsExternal } from '../server/github/pr-flows-external.ts';
import { readConfigFile, runPrActionReport, runPrFlowsCheck } from '../server/pr-flows-cli.ts';
import { checkPack, packCheckHasProblem, packReportText } from '../server/packs/pack-check.ts';
import { once } from 'node:events';
import { packDirsUnder, readPackDir } from '../server/packs/pack-files.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { packJsonSchemaText } from '../shared/contracts/pack.ts';
import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { runCommandSafely } from '../server/child-process-safe.ts';
import { configFileViewOf, readSettingsForAgent } from '../server/core/settings-readout-core.ts';
import { commandFingerprint, expandPlaceholders, packPathsOf, mergeItems, plannedActions, prFlowsConfig, savedRuleFor, sourceCandidates, teammateThreadItems, threadCandidates } from '../server/github/core/pr-flows-core.ts';
import { draftsNewestFirst } from '../server/github/core/team-review-core.ts';
import { ReviewDraft, TeamReviewThreadNode } from '../shared/contracts/team-review.ts';
import { isIncludedByDefault, otherReviewRows } from '../public/github/team-review-view-core.ts';
import { DEFAULT_CONFIG, validateConfig } from '../server/config-store.ts';
import { threadRows } from '../public/github/my-prs-view-core.ts';

function openPr(): GithubPrDetailNode {
  return GithubPrDetailNode.parse({
    __typename: 'PullRequest', id: 'PR_1', number: 1, title: 'PR 1', url: 'https://github.com/acme/app/pull/1',
    repository: { nameWithOwner: 'acme/app', viewerDefaultMergeMethod: 'SQUASH' },
    author: { login: 'operator' }, labels: { nodes: [] }, comments: { totalCount: 0 },
    isDraft: false, state: 'OPEN', createdAt: '', mergedAt: null, updatedAt: '',
    baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: 'feature-1', isCrossRepository: false, headRefOid: 'b'.repeat(40),
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] },
    reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  });
}

function threadNode(id: string, path: string, line: number | null, author: string, bodyText: string, isResolved = false): MyPrThreadNode {
  const comment = { author: { login: author }, bodyText, url: `https://github.com/acme/app/pull/1#${id}`, createdAt: '2026-11-01T00:00:00Z' };
  return { id, isResolved, isOutdated: false, path, line, firstComment: { totalCount: 1, nodes: [comment] }, lastComment: { nodes: [comment] } };
}

test('a store PR reaches My PRs with unresolved threads merged by path and nearby lines, unlined ones by body prefix', () => {
  const storePr = GithubPr.parse(normalizeGithubPr(openPr(), 0, [
    threadNode('t1', 'src/a.ts', 10, 'greptile[bot]', 'Null name writes undefined'),
    threadNode('t2', 'src/a.ts', 13, 'copilot[bot]', 'Guard the name'),
    threadNode('t3', 'src/a.ts', 30, 'copilot[bot]', 'Unrelated'),
    threadNode('t4', 'src/b.ts', 10, 'greptile[bot]', 'Other file'),
    threadNode('t5', 'docs/x.md', null, 'a', 'Typo  in Title'),
    threadNode('t6', 'docs/x.md', null, 'b', 'typo in title'),
    threadNode('t7', 'src/a.ts', 11, 'c', 'Already handled', true),
  ]));
  const items = myPrFromGithubPr(storePr).reviewItems;
  assert.deepEqual(items.map((item) => [item.path, item.lineStart, item.lineEnd, item.sources.map((source) => source.threadId)]), [
    ['docs/x.md', null, null, ['t5', 't6']],
    ['src/a.ts', 10, 13, ['t1', 't2']],
    ['src/a.ts', 30, 30, ['t3']],
    ['src/b.ts', 10, 10, ['t4']],
  ]);
  assert.ok(items.every((item) => item.priority === 'unknown'));
});

test('dismissing an item replies and resolves each of its threads once, and the dismissal hides it after a push until a comment changes or a new one joins it', async () => {
  let threads = [threadNode('PRRT_1', 'src/a.ts', 10, 'greptile[bot]', 'Null name writes undefined'), threadNode('PRRT_2', 'src/a.ts', 12, 'copilot[bot]', 'Guard the name')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const githubCalls: string[] = [];
  let failNextResolve = true;
  const frames: PrFlowsStatus[] = [];
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: (frame) => frames.push(frame), log: console,
    linkedSession: () => null, readConfigFile: async () => ({}), appendRule: async () => true,
    github: {
      unresolveReviewThread: async () => ({ ok: true, err: '' }),
      replyToReviewThread: async (threadId, body) => { githubCalls.push(`reply ${threadId} ${body}`); return { ok: true, err: '' }; },
      resolveReviewThread: async (threadId) => {
        githubCalls.push(`resolve ${threadId}`);
        if (threadId === 'PRRT_2' && failNextResolve) {
          failNextResolve = false;
          return { ok: false, err: 'HTTP 502' };
        }
        return { ok: true, err: '' };
      },
    },
  });
  const [item] = myPr().reviewItems;
  assert.ok(item);
  const dismissal = { prKey: 'acme/app#1', itemKey: item.key, action: 'dismiss', reason: 'Names are validated upstream' } as const;
  assert.deepEqual(await prFlows.dispose(dismissal), { ok: false, error: 'Replied, but could not resolve the thread: HTTP 502' });
  assert.deepEqual(await prFlows.dispose(dismissal), { ok: true });
  assert.deepEqual(githubCalls, ['reply PRRT_1 Names are validated upstream', 'resolve PRRT_1', 'reply PRRT_2 Names are validated upstream', 'resolve PRRT_2', 'resolve PRRT_2']);
  const handled = frames.at(-1)?.handledByPr['acme/app#1'] ?? [];
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined')];
  assert.deepEqual(threadRows(myPr(), 'operator', handled), []);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name writes undefined'), threadNode('PRRT_10', 'src/a.ts', 15, 'alice', 'This also leaks the token')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  threads = [threadNode('PRRT_9', 'src/a.ts', 14, 'greptile[bot]', 'Null name now crashes the export')];
  assert.equal(threadRows(myPr(), 'operator', handled).length, 1);
  assert.deepEqual(await prFlows.dispose({ prKey: 'acme/app#1', itemKey: myPr().reviewItems[0]?.key ?? '', action: 'fix-local' }), { ok: false, error: 'No live session is linked to this pull request.' });
});

test('a matching rule dismisses an item on the next poll and records it, Undo reopens its thread for good, and Save as rule appends a rule', async () => {
  let threads = [threadNode('PRRT_1', 'dist/app.js', 3, 'copilot[bot]', 'Minified line is long'), threadNode('PRRT_2', 'src/a.ts', 10, 'alice', 'Rename this')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const githubCalls: string[] = [];
  const savedRules: unknown[] = [];
  const frames: PrFlowsStatus[] = [];
  const configFile = { prFlows: {
    repoRules: { 'acme/app': [{ name: 'generated', paths: ['dist/'], action: 'dismiss', reason: 'Generated output' }] },
    rules: [{ name: 'broken', action: 'dismiss' }, { name: 'elsewhere', authors: ['alice'], repos: ['acme/other'], action: 'dismiss', reason: 'Other repo' }, { name: 'resolve bots', authors: ['ALICE'], repos: ['ACME/app'], action: 'run:resolve' }],
  } };
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: (frame) => frames.push(frame), log: console,
    linkedSession: () => null, readConfigFile: async () => configFile, appendRule: async (rule) => { savedRules.push(rule); return true; },
    github: {
      replyToReviewThread: async (threadId, body) => { githubCalls.push(`reply ${threadId} ${body}`); return { ok: true, err: '' }; },
      resolveReviewThread: async (threadId) => { githubCalls.push(`resolve ${threadId}`); return { ok: true, err: '' }; },
      unresolveReviewThread: async (threadId) => { githubCalls.push(`unresolve ${threadId}`); return { ok: true, err: '' }; },
    },
  });
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1']);
  const status = frames.at(-1);
  assert.deepEqual(status?.handledByPr['acme/app#1']?.map((entry) => [entry.ruleName, entry.location]), [['generated', 'dist/app.js:3']]);
  assert.deepEqual(status?.warnings, [
    'prFlows.repoRules is deprecated: move each rule into prFlows.rules with "repos": ["<owner/name>"]',
    "prFlows.rules[0] was skipped: a dismiss rule needs a reason",
    "Rule 'resolve bots' names run:resolve, which no entry in prFlows.actions defines, so its items wait for you.",
  ]);
  const handledItemKey = status?.handledByPr['acme/app#1']?.[0]?.itemKey ?? '';
  assert.deepEqual(await prFlows.undo({ prKey: 'acme/app#1', itemKey: handledItemKey }), { ok: true });
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1', 'unresolve PRRT_1']);
  assert.equal(threadRows(myPr(), 'operator', frames.at(-1)?.handledByPr['acme/app#1'] ?? []).length, 2);
  threads = [...threads, threadNode('PRRT_3', 'dist/app.js', 4, 'bob', 'Also generated')];
  await prFlows.applyRules();
  assert.deepEqual(githubCalls, ['reply PRRT_1 Generated output', 'resolve PRRT_1', 'unresolve PRRT_1']);
  const aliceItem = myPr().reviewItems.find((item) => item.path === 'src/a.ts');
  assert.deepEqual(await prFlows.saveRule({ prKey: 'acme/app#1', itemKey: aliceItem?.key ?? '', reason: 'Names are settled' }), { ok: true });
  assert.deepEqual(savedRules, [{ name: 'Dismiss alice on src/a.ts', authors: ['alice'], paths: ['src/a.ts'], scope: 'mine', repos: ['acme/app'], action: 'dismiss', reason: 'Names are settled' }]);
  threads = [threadNode('PRRT_4', 'frontend/src/scenes/session-recordings/player/inspector/PlayerInspectorList.tsx', 5, 'greptile-apps[bot]', 'Long path')];
  assert.deepEqual(await prFlows.saveRule({ prKey: 'acme/app#1', itemKey: myPr().reviewItems[0]?.key ?? '', reason: 'Fine' }), { ok: true });
  assert.equal(prFlowsConfig({ prFlows: { rules: savedRules.slice(1) } }).rules.length, 1);
});

test('a malformed prFlows rule leaves config.json valid and shows as a warning instead', () => {
  const loneRule = { repoRules: { 'acme/app': { name: 'one', action: 'ask' } }, rules: [{ name: 'no action' }] };
  for (const prFlows of [null, loneRule, { rules: {} }]) assert.equal(validateConfig({ ...DEFAULT_CONFIG, prFlows }).ok, true);
  assert.equal(prFlowsConfig({ prFlows: loneRule }).warnings.length, 3);
  assert.deepEqual(prFlowsConfig({ prFlows: { repoRules: {}, rules: [] } }).warnings, []);
});

test('a fix-local rule pastes the comment without submitting it', async () => {
  const threads = [threadNode('PRRT_1', 'src/a.ts', 3, 'outsider', 'nit: run this')];
  const myPr = () => myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads)));
  const pastes: boolean[] = [];
  const session = { pasteTextWhenReady: (_text: string, options: { submit: boolean }) => { pastes.push(options.submit); return { ok: true }; }, hasPendingPaste: () => false };
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPr()], broadcast: () => {}, log: console,
    linkedSession: () => session, readConfigFile: async () => ({ prFlows: { rules: [{ name: 'nits', text: 'nit', action: 'fix-local' }] } }), appendRule: async () => true,
    github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
  });
  await prFlows.applyRules();
  assert.deepEqual(pastes, [false]);
});

function teammateThread(id: string, line: number, login: string, extra: { isResolved?: boolean; viewerDidAuthor?: boolean; diffSide?: 'LEFT' | 'RIGHT' } = {}) {
  return TeamReviewThreadNode.parse({
    id, path: 'src/a.ts', line, diffSide: extra.diffSide ?? 'RIGHT', isResolved: extra.isResolved ?? false, viewerCanResolve: false,
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { body: `${login} says line ${line} is wrong`, author: { login }, viewerDidAuthor: extra.viewerDidAuthor ?? false, createdAt: '2026-11-01T10:00:00Z', url: `https://github.com/acme/app/pull/7#discussion_${id}`, originalCommit: null },
    ] },
  });
}

test('on a teammate PR an own finding near a bot thread is marked already flagged and left out of the posting plan, and a resolved thread shows after the open ones without flagging', () => {
  const teammateThreads = [
    teammateThread('PRRT_bot', 10, 'greptile[bot]'),
    teammateThread('PRRT_mine', 30, 'operator', { viewerDidAuthor: true }),
    teammateThread('PRRT_done', 31, 'copilot[bot]', { isResolved: true }),
    teammateThread('PRRT_deleted', 29, 'coderabbitai[bot]', { diffSide: 'LEFT' }),
  ];
  const otherReviewItems = teammateThreadItems(teammateThreads, 'open');
  const resolvedOtherReviewItems = teammateThreadItems(teammateThreads, 'resolved');
  const draft = ReviewDraft.parse({
    key: 'acme/app#7', repo: 'acme/app', number: 7, title: 'PR 7', url: 'https://github.com/acme/app/pull/7', author: 'teammate', tier: 'full', reasons: [],
    reviewedHead: 'c'.repeat(40), verdict: 'COMMENT', summary: '', body: '', status: 'ready',
    comments: [
      { path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'Off by one', severity: 'HIGH' },
      { path: 'src/a.ts', line: 30, side: 'RIGHT', body: 'Unrelated', severity: 'HIGH' },
    ],
  });

  const [presented] = draftsNewestFirst({ 'acme/app#7': { draft, reviewedHead: draft.reviewedHead, inFlight: false, reviewAttempts: 1, updatedAt: 1, otherReviewItems, resolvedOtherReviewItems } });
  assert.ok(presented);

  assert.deepEqual(otherReviewRows(presented).map((row) => `${row.location} ${row.reviewers} ${row.isResolved}`), ['src/a.ts coderabbitai[bot] false', 'src/a.ts:10 greptile[bot] false', 'src/a.ts:31 copilot[bot] true']);
  assert.deepEqual(presented.comments.map((comment) => comment.flaggedBy ?? []), [['greptile[bot]'], []]);
  assert.deepEqual(presented.comments.map(isIncludedByDefault), [false, true]);
});

async function frameMatching(frames: readonly PrFlowsStatus[], isWanted: (frame: PrFlowsStatus) => boolean): Promise<PrFlowsStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(isWanted);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no matching frame among ${frames.length}`);
}

test('a configured source runs only after the operator approves its exact command, and its findings join the PR as items under its label', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-flows-source-'));
  try {
    const scriptPath = path.join(homeDir, 'source.mjs');
    fs.writeFileSync(scriptPath, [
      "const [prUrl, head] = process.argv.slice(2);",
      "const leaked = process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN ?? process.env.GLIMMERVOID_POSTHOG_READ_API_KEY ?? 'none';",
      "console.log(JSON.stringify({ findings: [{ path: 'src/a.ts', lineStart: 40, lineEnd: 41, priority: 'high', body: 'seen ' + prUrl + ' at ' + head.slice(0, 4) + ' env ' + process.env.GLIMMERVOID_PR_NUMBER + ' token ' + leaked }], status: [{ label: 'verdict', state: 'must fix' }] }));",
    ].join('\n'));
    let source: Record<string, unknown> = { id: 'scanner', label: 'scanner', command: [process.execPath, scriptPath, '{prUrl}', '{head}'] };
    const frames: PrFlowsStatus[] = [];
    const prFlows = createPrFlowsWiring({
      statePath: null, openPrs: () => [myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, [])))], broadcast: (frame) => frames.push(frame), log: console,
      linkedSession: () => null, readConfigFile: async () => ({ prFlows: { sources: [source] } }), appendRule: async () => true,
      external: createPrFlowsExternal({ homeDir, baseEnv: () => ({ ...process.env, GLIMMERVOID_TELEGRAM_BOT_TOKEN: 'secret-token', GLIMMERVOID_POSTHOG_READ_API_KEY: 'secret-read-key' }) }),
      github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
    });

    await prFlows.applyRules();
    const waiting = prFlows.statusFrame();
    assert.deepEqual(waiting.pendingApprovals.map((approval) => [approval.kind, approval.id]), [['source', 'scanner']]);
    assert.deepEqual(waiting.sourceRunsByPr, {});
    assert.equal((await prFlows.approve({ fingerprint: 'not-a-listed-entry' })).ok, false);

    assert.deepEqual(await prFlows.approve({ fingerprint: waiting.pendingApprovals[0]?.fingerprint ?? '' }), { ok: true });
    const ran = await frameMatching(frames, (frame) => (frame.reviewItemsByPr['acme/app#1'] ?? []).length > 0);
    assert.deepEqual(ran.pendingApprovals, []);
    assert.deepEqual(ran.sourceRunsByPr['acme/app#1'], [{ label: 'scanner', status: [{ label: 'verdict', state: 'must fix' }], error: null }]);
    const [item] = ran.reviewItemsByPr['acme/app#1'] ?? [];
    assert.deepEqual([item?.priority, item?.sources.map((itemSource) => `${itemSource.kind}:${itemSource.name}`)], ['high', ['configured:scanner']]);
    assert.equal(item?.excerpt, 'seen https://github.com/acme/app/pull/1 at bbbb env 1 token none');

    source = { ...source, command: [process.execPath, scriptPath, '{prUrl}', '{head}', '--extra'] };
    frames.length = 0;
    await prFlows.applyRules();
    const edited = prFlows.statusFrame();
    assert.deepEqual(edited.pendingApprovals.map((approval) => approval.id), ['scanner']);
    assert.deepEqual(edited.reviewItemsByPr, {});
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a source that fails or prints no findings JSON shows its error on the PR and adds no items', async () => {
  const external = createPrFlowsExternal({ homeDir: os.tmpdir() });
  const pr = { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, headRefOid: 'b'.repeat(40) };
  const failing = await external.runSource({ id: 'broken', label: 'broken', command: [process.execPath, '-e', "process.stderr.write('boom'); process.exit(3)"], timeoutSeconds: 30 }, pr);
  assert.deepEqual(failing, { ok: false, error: 'The command failed: boom' });
  const chatty = await external.runSource({ id: 'chatty', label: 'chatty', command: [process.execPath, '-e', "console.log('hello')"], timeoutSeconds: 30 }, pr);
  assert.equal(chatty.ok, false);
  const unknown = await external.runSource({ id: 'typo', label: 'typo', command: ['echo', '{pr_url}'], timeoutSeconds: 30 }, pr);
  assert.deepEqual(unknown, { ok: false, error: '{pr_url} is not a placeholder of a source; use {prUrl}, {repo}, {number}, {head}' });
});

test('a scanner rule never dismisses a carbon unit thread merged into the same item, and scanner output stays inert', () => {
  const thread: MyPrThread = { id: 'T1', path: 'src/a.ts', line: 10, isOutdated: false, url: 'https://github.com/acme/app/pull/1#r1', author: 'teammate', excerpt: 'Please rename this.', commentCount: 1, lastAuthor: 'teammate', lastActivityAt: '2026-11-01T00:00:00Z' };
  const scanner = sourceCandidates({ id: 'scanner', label: 'Scanner' }, [{ path: 'src/a.ts', lineStart: 11, lineEnd: 11, priority: 'low', body: 'Style nit.', url: null }]);
  const items = mergeItems([...threadCandidates([thread]), ...scanner]);
  assert.equal(items.length, 1);
  const rule = PrFlowRule.parse({ name: 'drop scanner nits', sources: ['scanner'], priority: ['low'], action: 'dismiss', reason: 'nit' });
  const noneHandled = PrFlowsState.parse({ handledByPr: {}, reopenedByPr: {} });
  assert.deepEqual(plannedActions('acme/app#1', items, [rule], noneHandled, new Set()), []);
  const savedRule = PrFlowRule.parse(savedRuleFor(items[0] ?? assert.fail('no merged item'), 'acme/app', 'settled'));
  assert.deepEqual([savedRule.sources, savedRule.authors], [['scanner'], ['teammate']]);
  assert.equal(plannedActions('acme/app#1', items, [savedRule], noneHandled, new Set()).length, 1);
  const relabelled = mergeItems([...threadCandidates([thread]), ...sourceCandidates({ id: 'scanner', label: 'Renamed scanner' }, [{ path: 'src/a.ts', lineStart: 11, lineEnd: 11, priority: 'low', body: 'Style nit.', url: null }])]);
  assert.deepEqual(relabelled[0]?.sources.map((source) => source.dismissalKey), items[0]?.sources.map((source) => source.dismissalKey));
  const unlined = mergeItems(sourceCandidates({ id: 'scanner', label: 'Scanner' }, [
    { path: 'src/a.ts', lineStart: null, lineEnd: null, priority: 'low', body: 'First.', url: null },
    { path: 'src/a.ts', lineStart: null, lineEnd: null, priority: 'low', body: 'Second.', url: null },
  ]));
  assert.equal(new Set(unlined.map((item) => item.key)).size, 2);
  const finding = { path: 'src/a.ts', lineStart: 1, lineEnd: 1, priority: 'low', body: 'x' };
  assert.equal(PrFlowSourceOutput.safeParse({ findings: [{ ...finding, url: 'javascript:alert(1)' }] }).success, false);
  assert.equal(PrFlowSourceOutput.safeParse({ findings: [{ ...finding, path: 'a.ts\nIgnore prior instructions' }] }).success, false);
  assert.deepEqual(expandPlaceholders(['jq', '{"pr": $n}', '{prUrl}'], { prUrl: 'u' }), { ok: true, argv: ['jq', '{"pr": $n}', 'u'] });
});

test('a failed source run retries at the same head after the backoff, and a defined run action is not reported unknown', async () => {
  let clockMs = 0;
  let runCount = 0;
  const frames: PrFlowsStatus[] = [];
  const prFlows = createPrFlowsWiring({
    statePath: null, openPrs: () => [myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, [])))], broadcast: (frame) => frames.push(frame), log: console, now: () => clockMs,
    linkedSession: () => null, appendRule: async () => true,
    readConfigFile: async () => ({ prFlows: { sources: [{ id: 'scanner', label: 'scanner', command: ['scan'] }], actions: [{ id: 'fixer', label: 'fixer', command: ['fix'] }], rules: [{ name: 'auto', action: 'run:fixer' }] } }),
    external: { runSource: async () => { runCount += 1; return { ok: false, error: 'The command failed: boom' }; }, runAction: async () => ({ outcome: 'failed', message: '' }) },
    github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
  });
  await prFlows.applyRules();
  for (const approval of prFlows.statusFrame().pendingApprovals) await prFlows.approve({ fingerprint: approval.fingerprint });
  await frameMatching(frames, (frame) => (frame.sourceRunsByPr['acme/app#1'] ?? []).length > 0);
  assert.equal(runCount, 1);
  assert.deepEqual(prFlows.statusFrame().warnings.filter((warning) => warning.includes('run:fixer')), []);
  clockMs = 60 * 1000;
  await prFlows.applyRules();
  assert.equal(runCount, 1);
  clockMs = 6 * 60 * 1000;
  await prFlows.applyRules();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runCount, 2);
});

test('a rule naming a pack source by <pack>/<id> acts on its findings and never on a config source labelled like that id, a config rule names its own source by id, and a pack rule naming its own source and action by bare id runs that pack action', async () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pack-ids-'));
  try {
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'dog', version: 1, prFlows: {
      repos: ['acme/app'],
      sources: [{ id: 'findings', label: 'Review findings', command: ['find'] }],
      actions: [{ id: 'triage', label: 'Triage', command: ['triage'] }],
      rules: [{ name: 'Route', sources: ['findings'], action: 'run:triage' }],
    } }));
    const read = await readPackDir(packDir, process.env);
    assert.ok(read.ok);
    const findingPathsBySourceId: Record<string, string[]> = { 'dog/findings': ['src/a.ts', 'src/c.ts'], scan: ['src/b.ts'], 'look-alike': ['src/c.ts'] };
    const findingLineBySourceId: Record<string, number> = { 'look-alike': 90 };
    const ranActions: string[] = [];
    const frames: PrFlowsStatus[] = [];
    const prFlows = createPrFlowsWiring({
      statePath: null, openPrs: () => [myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, [])))], broadcast: (frame) => frames.push(frame), log: console,
      linkedSession: () => null, appendRule: async () => true, loadPacks: async () => ({ packs: [read.pack], warnings: [] }),
      readConfigFile: async () => ({ prFlows: {
        sources: [{ id: 'scan', label: 'Scanner', command: ['scan'] }, { id: 'look-alike', label: 'dog/findings', command: ['look'] }],
        rules: [{ name: 'Pack findings by id', sources: ['dog/findings'], paths: ['src/c.ts'], action: 'dismiss', reason: 'noise' }, { name: 'Config scan', sources: ['scan'], action: 'dismiss', reason: 'scanner' }],
      } }),
      external: {
        runSource: async (source) => ({ ok: true, output: PrFlowSourceOutput.parse({ findings: (findingPathsBySourceId[source.id] ?? []).map((findingPath) => ({ path: findingPath, lineStart: findingLineBySourceId[source.id] ?? 1, lineEnd: findingLineBySourceId[source.id] ?? 1, priority: 'low', body: 'seen' })) }) }),
        runAction: async (action) => { ranActions.push(action.id); return { outcome: 'done', message: '' }; },
      },
      github: NO_GITHUB_WRITES,
    });
    await prFlows.applyRules();
    for (const approval of prFlows.statusFrame().pendingApprovals) await prFlows.approve({ fingerprint: approval.fingerprint });
    await frameMatching(frames, (frame) => (frame.reviewItemsByPr['acme/app#1'] ?? []).length === 4);
    await prFlows.applyRules();
    await frameMatching(frames, (frame) => (frame.handledByPr['acme/app#1'] ?? []).length >= 3);
    await prFlows.applyRules();
    const handled = prFlows.statusFrame();
    assert.deepEqual(handled.handledByPr['acme/app#1']?.map((entry) => [entry.ruleName, entry.location]).sort(), [['Config scan', 'src/b.ts:1'], ['Pack findings by id', 'src/c.ts:1'], ['Route', 'src/a.ts:1']]);
    assert.deepEqual(ranActions, ['dog/triage']);
    assert.deepEqual(handled.warnings, []);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
});

test('a configured action runs on an item by rule or click, shows done or failed, and the linked session hears when the branch moved under it', async () => {
  let head = 'b'.repeat(40);
  const pastes: string[] = [];
  const session = { pasteTextWhenReady: (text: string) => { pastes.push(text); return { ok: true }; }, hasPendingPaste: () => false };
  const frames: PrFlowsStatus[] = [];
  const threads = [threadNode('t1', 'src/a.ts', 10, 'greptile[bot]', 'Null name'), threadNode('t2', 'src/b.ts', 5, 'carol', 'Rename')];
  const currentPr = () => ({ ...myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, threads))), headRefOid: head });
  const actions = [
    { id: 'resolve', label: 'Resolve', command: [process.execPath, '-e', 'process.exit(0)', '{itemPath}', '{itemLine}'] },
    { id: 'broken', label: 'Broken', command: [process.execPath, '-e', "process.stderr.write('no token'); process.exit(2)"] },
  ];
  const external = createPrFlowsExternal({ homeDir: os.tmpdir() });
  const prFlows = createPrFlowsWiring({
    statePath: null, broadcast: (frame) => frames.push(frame), log: console, linkedSession: () => session, appendRule: async () => true,
    openPrs: () => [currentPr()],
    readConfigFile: async () => ({ prFlows: { actions, rules: [{ name: 'bots', authors: ['greptile[bot]'], action: 'run:resolve' }] } }),
    external: { runSource: external.runSource, runAction: async (action, pr, item) => { const output = await external.runAction(action, pr, item); head = 'c'.repeat(40); return output; } },
    github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
  });
  await prFlows.applyRules();
  assert.deepEqual(prFlows.statusFrame().actions, []);
  for (const approval of prFlows.statusFrame().pendingApprovals) await prFlows.approve({ fingerprint: approval.fingerprint });
  await frameMatching(frames, (frame) => (frame.handledByPr['acme/app#1'] ?? []).length > 0);
  assert.deepEqual(prFlows.statusFrame().actions.map((action) => action.label), ['Resolve', 'Broken']);
  const [handled] = prFlows.statusFrame().handledByPr['acme/app#1'] ?? [];
  assert.deepEqual([handled?.action, handled?.ruleName, handled?.actionLabel, handled?.location], ['run:resolve', 'bots', 'Resolve', 'src/a.ts:10']);
  await prFlows.applyRules();
  assert.equal(pastes.length, 1);
  assert.match(pastes[0] ?? '', /moved to cccccccccccc while Resolve ran/);

  const carolItem = currentPr().reviewItems.find((item) => item.path === 'src/b.ts');
  assert.deepEqual(await prFlows.dispose({ prKey: 'acme/app#1', itemKey: carolItem?.key ?? '', action: 'run:broken' }), { ok: true });
  const failed = await frameMatching(frames, (frame) => (frame.actionRunsByPr['acme/app#1'] ?? []).some((run) => run.actionId === 'broken' && run.state !== 'running'));
  assert.deepEqual((failed.actionRunsByPr['acme/app#1'] ?? []).find((run) => run.actionId === 'broken'), { itemKey: carolItem?.key, actionId: 'broken', label: 'Broken', state: 'failed', message: 'no token' });
  await prFlows.applyRules();
  assert.equal((prFlows.statusFrame().handledByPr['acme/app#1'] ?? []).length, 1);
});

test('an action reporting refused is never taken as done, and a failed rule run is not repeated at the same head after a restart', async () => {
  const pr = { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, headRefOid: 'b'.repeat(40), headRefName: 'feature-1', baseRefName: 'main' };
  const [item] = myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, [threadNode('t1', 'src/a.ts', 10, 'greptile[bot]', 'Null name')]))).reviewItems;
  assert.ok(item);
  const action = { id: 'fmt', label: 'fmt', command: ['fmt'], timeoutSeconds: 30 };
  for (const stdout of [JSON.stringify({ outcome: 'refused', message: 'x'.repeat(201) }), JSON.stringify({ outcome: 'refused', detail: 1 }), `working\n${JSON.stringify({ outcome: 'refused' })}`]) {
    const external = createPrFlowsExternal({ homeDir: os.tmpdir(), runCommand: async () => ({ ok: true, stdout, stderr: '', exitCode: 0, failureCode: null, signal: null, wasKilled: false }) });
    assert.equal((await external.runAction(action, pr, item)).outcome, 'refused');
  }

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-flows-rerun-'));
  try {
    let runCount = 0;
    const wiringAt = () => createPrFlowsWiring({
      statePath: path.join(homeDir, 'pr-flows.json'), broadcast: () => {}, log: console, linkedSession: () => null, appendRule: async () => true,
      openPrs: () => [myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(openPr(), 0, [threadNode('t1', 'src/a.ts', 10, 'greptile[bot]', 'Null name')])))],
      readConfigFile: async () => ({ prFlows: { actions: [action], rules: [{ name: 'auto-fmt', action: 'run:fmt' }] } }),
      external: { runSource: async () => ({ ok: false, error: '' }), runAction: async () => { runCount += 1; return { outcome: 'failed', message: 'boom' }; } },
      github: { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) },
    });
    const first = wiringAt();
    await first.applyRules();
    for (const approval of first.statusFrame().pendingApprovals) await first.approve({ fingerprint: approval.fingerprint });
    await first.applyRules();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runCount, 1);
    const restarted = wiringAt();
    await restarted.applyRules();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runCount, 1);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function myPrIn(repo: string, number: number) {
  const node = GithubPrDetailNode.parse({ ...openPr(), number, url: `https://github.com/${repo}/pull/${number}`, repository: { nameWithOwner: repo, viewerDefaultMergeMethod: 'SQUASH' } });
  return myPrFromGithubPr(GithubPr.parse(normalizeGithubPr(node, 0, [])));
}

const NO_GITHUB_WRITES = { replyToReviewThread: async () => ({ ok: true, err: '' }), resolveReviewThread: async () => ({ ok: true, err: '' }), unresolveReviewThread: async () => ({ ok: true, err: '' }) };

test('a PR action shows on its listed repos once approved, runs its exact argv with the PR facts one run at a time, and a run in flight at restart shows interrupted', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-actions-'));
  try {
    const recordPath = path.join(homeDir, 'record.json');
    const scriptPath = path.join(homeDir, 'trigger.mjs');
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GLIMMERVOID_'))) }));`,
      "console.log(JSON.stringify({ outcome: 'started', message: 'Task https://example.test/tasks/1' }));",
    ].join('\n'));
    let prAction: Record<string, unknown> = { id: 'agent-merge', label: 'Merge via agent', repos: ['ACME/app'], command: [process.execPath, scriptPath, '{prUrl}', '{headRef}', '{baseRef}'] };
    const prs = [myPrIn('acme/app', 1), myPrIn('other/lib', 2)];
    const head = prs[0]?.headRefOid ?? '';
    const frames: PrFlowsStatus[] = [];
    const prFlows = createPrFlowsWiring({
      statePath: null, openPrs: () => prs, broadcast: (frame) => frames.push(frame), log: console, linkedSession: () => null, appendRule: async () => true,
      readConfigFile: async () => ({ prFlows: { prActions: [prAction] } }), github: NO_GITHUB_WRITES,
      external: createPrFlowsExternal({ homeDir, baseEnv: () => ({ ...process.env, GLIMMERVOID_TELEGRAM_BOT_TOKEN: 'secret-token' }) }),
    });
    await prFlows.applyRules();
    const [approval] = prFlows.statusFrame().pendingApprovals;
    assert.deepEqual([approval?.kind, approval?.repos], ['pr-action', ['acme/app']]);
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, {});
    const click = { repo: 'acme/app', number: 1, actionId: 'agent-merge', head };
    assert.equal((await prFlows.runPrAction(click)).ok, false);

    await prFlows.approve({ fingerprint: approval?.fingerprint ?? '' });
    const shown = await frameMatching(frames, (frame) => Object.keys(frame.prActionsByPr).length > 0);
    assert.deepEqual(shown.prActionsByPr, { 'acme/app#1': [{ id: 'agent-merge', label: 'Merge via agent' }] });
    assert.equal((await prFlows.runPrAction({ ...click, head: 'c'.repeat(40) })).ok, false);
    assert.equal((await prFlows.runPrAction({ ...click, repo: 'other/lib', number: 2 })).ok, false);

    assert.deepEqual(await prFlows.runPrAction(click), { ok: true });
    const started = await frameMatching(frames, (frame) => (frame.prActionRunsByPr['acme/app#1'] ?? []).some((run) => run.state === 'started'));
    assert.deepEqual(started.prActionRunsByPr['acme/app#1'], [{ actionId: 'agent-merge', label: 'Merge via agent', state: 'started', message: 'Task https://example.test/tasks/1' }]);
    const record = z.object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) }).parse(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
    assert.deepEqual(record.argv, ['https://github.com/acme/app/pull/1', 'feature-1', 'main']);
    assert.deepEqual([record.env.GLIMMERVOID_PR_HEAD, record.env.GLIMMERVOID_PR_HEAD_REF, record.env.GLIMMERVOID_PR_BASE_REF, record.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN], [head, 'feature-1', 'main', undefined]);
    const prJson = z.looseObject({ number: z.number() }).parse(JSON.parse(record.env.GLIMMERVOID_PR_JSON ?? ''));
    assert.deepEqual([prJson.number, 'threads' in prJson, 'reviewItems' in prJson], [1, false, false]);

    prAction = { ...prAction, command: [process.execPath, scriptPath, '{prUrl}', '--edited'] };
    await prFlows.applyRules();
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, {});
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-actions-restart-'));
  try {
    let runCount = 0;
    const pendingRuns: Array<() => void> = [];
    const pr = myPrIn('acme/app', 1);
    const frames: PrFlowsStatus[] = [];
    const wiringAt = () => createPrFlowsWiring({
      statePath: path.join(stateDir, 'pr-flows-state.json'), openPrs: () => [pr], broadcast: (frame) => frames.push(frame), log: console, linkedSession: () => null, appendRule: async () => true,
      readConfigFile: async () => ({ prFlows: { prActions: [{ id: 'slow', label: 'Slow', command: ['slow'] }] } }), github: NO_GITHUB_WRITES,
      external: { runSource: async () => ({ ok: false, error: '' }), runAction: () => new Promise((resolve) => { runCount += 1; pendingRuns.push(() => resolve({ outcome: 'failed', message: 'boom' })); }) },
    });
    const first = wiringAt();
    await first.applyRules();
    for (const approval of first.statusFrame().pendingApprovals) await first.approve({ fingerprint: approval.fingerprint });
    const click = { repo: 'acme/app', number: 1, actionId: 'slow', head: pr.headRefOid };
    assert.deepEqual(await first.runPrAction(click), { ok: true });
    assert.match((await first.runPrAction(click)).error ?? '', /already running/);
    pendingRuns.shift()?.();
    await frameMatching(frames, (frame) => (frame.prActionRunsByPr['acme/app#1'] ?? []).some((run) => run.state === 'failed'));
    assert.deepEqual(await first.runPrAction(click), { ok: true });
    assert.equal(runCount, 2);

    const restarted = wiringAt();
    await restarted.applyRules();
    assert.deepEqual(restarted.statusFrame().prActionRunsByPr['acme/app#1'], [{ actionId: 'slow', label: 'Slow', state: 'interrupted', message: 'Glimmervoid restarted' }]);
    assert.equal(runCount, 2);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a started PR action takes one final report from the holder of its token through pr-action report, across a restart and after its PR merged, with 401 for a wrong token and 409 after the final outcome', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-action-report-'));
  let prFlows: ReturnType<typeof createPrFlowsWiring> | null = null;
  const dashboardAt = () => http.createServer(createBackendHttpApp({
    staticDir: null, configStore: { configPath: path.join(homeDir, 'config.json') }, remote: { allowedOrigins: [] }, remoteAuth: null, allowedHosts: [], listenerPortsFor: () => [], pageToken: 'page',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) }, getSession: () => null, getUsage: () => ({ ingestStatusline: () => {} }), getPrActionReports: () => prFlows,
  }));
  let server = dashboardAt();
  try {
    const dashboardPort = await listenOnLoopback(server);
    const scriptPath = path.join(homeDir, 'trigger.mjs');
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(homeDir)} + '/env-' + process.argv[2] + '.json', JSON.stringify(process.env));`,
      "console.log(JSON.stringify({ outcome: 'started', message: 'Task https://example.test/tasks/1' }));",
    ].join('\n'));
    const mergedPr = myPrIn('acme/app', 1);
    const openPr = myPrIn('acme/app', 2);
    let openPrList = [mergedPr, openPr];
    const frames: PrFlowsStatus[] = [];
    const wiringAt = () => createPrFlowsWiring({
      statePath: path.join(homeDir, 'pr-flows-state.json'), openPrs: () => openPrList, broadcast: (frame) => frames.push(frame), log: console, linkedSession: () => null, appendRule: async () => true,
      readConfigFile: async () => ({ prFlows: { prActions: [{ id: 'agent-merge', label: 'Merge via agent', command: [process.execPath, scriptPath, '{number}'] }] } }), github: NO_GITHUB_WRITES,
      external: createPrFlowsExternal({ homeDir }), reportUrlFor: (runId) => `http://127.0.0.1:${dashboardPort}${prActionReportPath(runId)}`,
    });
    const first = wiringAt();
    prFlows = first;
    await first.applyRules();
    for (const approval of first.statusFrame().pendingApprovals) await first.approve({ fingerprint: approval.fingerprint });
    for (const pr of openPrList) assert.deepEqual(await first.runPrAction({ repo: 'acme/app', number: pr.number, actionId: 'agent-merge', head: pr.headRefOid }), { ok: true });
    await frameMatching(frames, (frame) => ['acme/app#1', 'acme/app#2'].every((prKey) => frame.prActionRunsByPr[prKey]?.[0]?.state === 'started'));
    const commandEnvOf = (number: number) => z.record(z.string(), z.string()).parse(JSON.parse(fs.readFileSync(path.join(homeDir, `env-${number}.json`), 'utf8')));
    const [mergedEnv, openEnv] = [commandEnvOf(1), commandEnvOf(2)];
    assert.match(openEnv[PR_ACTION_TOKEN_ENV] ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(first.statusFrame()).includes(openEnv[PR_ACTION_TOKEN_ENV] ?? 'no token'), false);

    await closeServer(server);
    server = dashboardAt();
    await listenOnLoopback(server, dashboardPort);
    openPrList = [openPr];
    const restarted = wiringAt();
    prFlows = restarted;
    await restarted.applyRules();
    const errors: string[] = [];
    const io = { writeOutput: () => {}, writeError: (text: string) => { errors.push(text); } };
    const report = (env: NodeJS.ProcessEnv, outcome: string) => runPrActionReport({ outcome, message: 'Merged', env }, io);
    const reportUrl = openEnv[PR_ACTION_REPORT_URL_ENV] ?? '';
    const statusOf = async (url: string, token: string) => (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ outcome: 'done' }) })).status;
    assert.equal(await statusOf(reportUrl, 'x'.repeat(43)), 401);
    assert.equal(await report({ ...openEnv, [PR_ACTION_TOKEN_ENV]: 'x'.repeat(43) }, 'done'), 1);
    assert.equal(await report({}, 'done'), 1);
    assert.equal(await report(openEnv, 'merged'), 1);
    assert.equal(await report(openEnv, 'done'), 0);
    assert.deepEqual(restarted.statusFrame().prActionRunsByPr['acme/app#2'], [{ actionId: 'agent-merge', label: 'Merge via agent', state: 'done', message: 'Merged' }]);
    assert.equal(await report(mergedEnv, 'done'), 0);
    assert.equal(await report(openEnv, 'failed'), 1);
    assert.equal(restarted.statusFrame().prActionRunsByPr['acme/app#2']?.[0]?.state, 'done');
    assert.deepEqual([await statusOf(reportUrl, 'x'.repeat(43)), await statusOf(reportUrl.replace(/pr-action\/[^/]+/, 'pr-action/unknown-run'), 'x')], [409, 404]);
    assert.equal(errors.length, 4);
  } finally {
    await closeServer(server);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a pack copied into the packs directory waits for one approval in Settings listing its files, commands and requires, then shows its namespaced buttons and actions in My PRs and stays approved across a restart; any file edit re-asks, even after the folder is replaced, and a missing require turns it off with a note', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-packs-'));
  const statePath = path.join(homeDir, 'packs-state.json');
  const packStore = createPackStore({ homeDir, statePath, env: process.env, log: console, reloadDebounceMs: 10 });
  try {
    const packDir = path.join(homeDir, 'packs', 'sample');
    const copySamplePackScopedToAcmeApp = () => {
      fs.cpSync(path.join(import.meta.dirname, 'fixtures', 'pr-packs', 'sample'), packDir, { recursive: true });
      const samplePackJson = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
      fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ ...samplePackJson, prFlows: { ...samplePackJson.prFlows, repos: ['acme/app'] } }));
    };
    copySamplePackScopedToAcmeApp();
    const linkedDir = path.join(homeDir, 'linked-pack');
    fs.mkdirSync(linkedDir);
    fs.writeFileSync(path.join(linkedDir, 'pack.json'), JSON.stringify({ name: 'linked', version: 1 }));
    fs.symlinkSync('/etc/hosts', path.join(linkedDir, 'hosts'));
    const pr = myPrIn('acme/app', 1);
    const frames: PrFlowsStatus[] = [];
    const configFile = { packs: [linkedDir] };
    await packStore.start();
    const linkedPackRead = once(packStore, 'changed');
    packStore.setListedPaths(packPathsOf(configFile));
    await linkedPackRead;
    const prFlows = createPrFlowsWiring({
      statePath: null, openPrs: () => [pr, myPrIn('acme/other', 2)], broadcast: (frame) => frames.push(frame), log: console, linkedSession: () => null, appendRule: async () => true,
      readConfigFile: async () => configFile, github: NO_GITHUB_WRITES, external: createPrFlowsExternal({ homeDir }),
      loadPacks: (config) => {
        packStore.setListedPaths(packPathsOf(config));
        return packStore.approvedPacks();
      },
    });
    const sampleRow = () => packStore.statusFrame().packs.find((row) => row.name === 'sample');
    const approveThePack = async () => {
      await prFlows.applyRules();
      assert.equal(sampleRow()?.state, 'pending');
      assert.deepEqual(await packStore.approve(sampleRow()?.fingerprint ?? ''), { ok: true });
      await prFlows.applyRules();
    };

    await prFlows.applyRules();
    assert.deepEqual(prFlows.statusFrame().pendingApprovals, []);
    assert.ok(prFlows.statusFrame().warnings.includes("The pack 'sample' waits for your approval in Settings, Packs"));
    assert.deepEqual(packStore.statusFrame().packs.map((row) => [row.name, row.state]), [['sample', 'pending'], ['linked-pack', 'invalid']]);
    assert.deepEqual(sampleRow()?.files, ['hand-off.ts', 'pack.json']);
    const approval = sampleRow()?.prFlows;
    assert.deepEqual(approval?.pack?.commands.map((command) => [command.kind, command.id, command.command[1]]), [
      ['pr-action', 'sample/hand-off', path.join(packDir, 'hand-off.ts')], ['action', 'sample/note', path.join(packDir, 'hand-off.ts')],
    ]);
    assert.deepEqual([approval?.label, approval?.pack?.requires], ['sample v1', { env: [], programs: ['node'] }]);
    assert.match(approval?.pack?.rules.join('\n') ?? '', /^Generated files: .*"paths":\["dist\/"\].*"repos":\["acme\/app"\].*"action":"run:sample\/note"/);
    assert.deepEqual(approval?.pack?.commands.find((command) => command.kind === 'pr-action')?.repos, ['acme/app']);
    assert.ok(prFlows.statusFrame().warnings.some((warning) => warning.includes(linkedDir) && warning.includes('symlink')));
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, {});

    await approveThePack();
    assert.deepEqual(await packStore.approve(sampleRow()?.fingerprint ?? ''), { ok: false, error: 'That pack changed or is already approved; check the list again.' });
    const restartedStore = createPackStore({ homeDir, statePath, env: process.env, log: console });
    await restartedStore.start();
    assert.equal(restartedStore.statusFrame().packs.find((row) => row.name === 'sample')?.state, 'approved');
    restartedStore.stop();
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, { 'acme/app#1': [{ id: 'sample/hand-off', label: 'Hand off' }] });
    assert.deepEqual(prFlows.statusFrame().actions, [{ id: 'sample/note', label: 'Note it' }]);
    assert.equal(prFlows.statusFrame().warnings.some((warning) => warning.includes('run:sample/note')), false);
    assert.deepEqual(await prFlows.runPrAction({ repo: 'acme/app', number: 1, actionId: 'sample/hand-off', head: pr.headRefOid }), { ok: true });
    const started = await frameMatching(frames, (frame) => frame.prActionRunsByPr['acme/app#1']?.[0]?.state === 'started');
    assert.equal(started.prActionRunsByPr['acme/app#1']?.[0]?.message, 'Handed off https://github.com/acme/app/pull/1 feature-1');

    fs.rmSync(packDir, { recursive: true });
    copySamplePackScopedToAcmeApp();
    await prFlows.applyRules();
    assert.equal(prFlows.statusFrame().prActionsByPr['acme/app#1']?.[0]?.id, 'sample/hand-off');
    fs.appendFileSync(path.join(packDir, 'hand-off.ts'), '\n');
    await prFlows.applyRules();
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, {});
    const packJsonPath = path.join(packDir, 'pack.json');
    fs.writeFileSync(packJsonPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(packJsonPath, 'utf8')), requires: { env: ['GLIMMERVOID_PACK_TEST_UNSET'] } }));
    await approveThePack();
    assert.deepEqual(prFlows.statusFrame().prActionsByPr, {});
    assert.ok(prFlows.statusFrame().warnings.includes("The pack 'sample' is off until this machine has env GLIMMERVOID_PACK_TEST_UNSET"));
  } finally {
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a pack approval survives approving another pack while it is unreadable, an approved pack missing a require shows no theme, and an approval that cannot be saved is refused', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-approvals-'));
  const packStore = createPackStore({ homeDir, statePath: path.join(homeDir, 'packs-state.json'), env: process.env, log: { warn: () => {} } });
  const blockedStore = createPackStore({ homeDir, statePath: path.join(homeDir, 'packs', 'alpha', 'pack.json', 'packs-state.json'), env: process.env, log: { warn: () => {} } });
  try {
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(homeDir, 'packs', name), { recursive: true });
      fs.writeFileSync(path.join(homeDir, 'packs', name, 'pack.json'), JSON.stringify({ name, version: 1 }));
    }
    await packStore.start();
    const fingerprintOf = (name: string) => packStore.statusFrame().packs.find((row) => row.name === name)?.fingerprint ?? '';
    assert.deepEqual(await packStore.approve(fingerprintOf('alpha')), { ok: true });
    const alphaManifest = path.join(homeDir, 'packs', 'alpha', 'pack.json');
    const alphaBytes = fs.readFileSync(alphaManifest);
    fs.writeFileSync(alphaManifest, '{"name":');
    await packStore.approvedPacks();
    assert.deepEqual(await packStore.approve(fingerprintOf('beta')), { ok: true });
    fs.writeFileSync(alphaManifest, alphaBytes);
    assert.deepEqual((await packStore.approvedPacks()).packs.map((pack) => pack.header.name).sort(), ['alpha', 'beta']);
    const sampleTheme = {
      id: 'night', label: 'Night', mode: 'dark', accentAnsiSlot: 'none',
      chrome: Object.fromEntries(['bg', 'bg-card', 'bg-header', 'bg-surface', 'border', 'border-dim', 'border-hover', 'text', 'text-dim', 'text-head', 'text-muted', 'accent', 'accent-dim'].map((token) => [token, '#101010'])),
      states: Object.fromEntries(['running', 'waiting', 'failed', 'monitoring', 'done', 'initializing', 'idle', 'starting', 'complete'].map((state) => [state, '#202020'])),
    };
    fs.mkdirSync(path.join(homeDir, 'packs', 'gamma'));
    fs.writeFileSync(path.join(homeDir, 'packs', 'gamma', 'pack.json'), JSON.stringify({ name: 'gamma', version: 1, requires: { env: ['GLIMMERVOID_PACK_TEST_UNSET'] }, ui: { themes: [sampleTheme] } }));
    await packStore.approvedPacks();
    assert.deepEqual(await packStore.approve(fingerprintOf('gamma')), { ok: true });
    assert.deepEqual(packStore.statusFrame().themes, []);
    fs.writeFileSync(alphaManifest, JSON.stringify({ name: 'alpha', version: 2 }));
    await blockedStore.start();
    const blocked = await blockedStore.approve(blockedStore.statusFrame().packs.find((row) => row.name === 'alpha')?.fingerprint ?? '');
    assert.equal(blocked.ok, false);
    assert.equal((await blockedStore.approvedPacks()).packs.some((pack) => pack.header.name === 'alpha'), false);
  } finally {
    packStore.stop();
    blockedStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('the published pack JSON Schema matches the Zod contract, and packs check names schema errors and missing requires without running anything', async () => {
  const publishedPath = path.join(import.meta.dirname, '..', 'site', 'public', 'schema', 'pack.v1.json');
  assert.equal(fs.readFileSync(publishedPath, 'utf8'), packJsonSchemaText(), 'regenerate site/public/schema/pack.v1.json from packJsonSchemaText()');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pack-check-'));
  try {
    const output: string[] = [];
    const check = async (packDir: string) => {
      const report = await checkPack(packDir, process.env, () => false);
      output.push(packReportText(report));
      return packCheckHasProblem(report) ? 1 : 0;
    };
    assert.equal(await check(path.join(import.meta.dirname, 'fixtures', 'pr-packs', 'sample')), 0);
    const brokenDir = path.join(homeDir, 'broken');
    fs.mkdirSync(brokenDir);
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'Bad Name', version: 1 }));
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /error: pack\.json name: a pack name is lowercase/);
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'needs', version: 1, requires: { programs: ['glimmervoid-no-such-program'] } }));
    assert.equal(await check(brokenDir), 0);
    assert.match(output.at(-1) ?? '', /missing on this machine: program glimmervoid-no-such-program/);
    const dogfoodPrFlows = {
      repos: ['PostHog/posthog'],
      prActions: [{ id: 'hand', label: 'Hand to agent', command: ['node', '{packDir}/hand.mjs', '{headRef}'] }],
      sources: [{ id: 'findings', label: 'Review findings', command: ['node', '{packDir}/f.mjs'] }, { id: 'docs-lint', label: 'Docs/lint', command: ['node', '{packDir}/f.mjs'], repos: ['PostHog/posthog'] }],
      actions: [{ id: 'triage', label: 'Triage', command: ['node', '{packDir}/t.mjs'] }],
      rules: [{ name: 'Route', sources: ['findings'], action: 'run:triage' }],
    };
    const writeDogfoodPack = (rule: Record<string, unknown>, section: Record<string, unknown> = {}) => fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'dog', version: 1, prFlows: { ...dogfoodPrFlows, ...section, rules: [{ ...dogfoodPrFlows.rules[0], ...rule }] } }));
    const checkDogfoodPack = async (rule: Record<string, unknown>, section: Record<string, unknown> = {}) => {
      writeDogfoodPack(rule, section);
      return [await check(brokenDir), (output.at(-1) ?? '').split('\n').filter((line) => line.startsWith('error: '))];
    };
    assert.deepEqual(await checkDogfoodPack({}), [0, []]);
    assert.match(output.at(-1) ?? '', /^source dog\/findings \(Review findings\): valid, limited to posthog\/posthog$/m);
    assert.match(output.at(-1) ?? '', /^pr-action dog\/hand \(Hand to agent\): valid, limited to posthog\/posthog$/m);
    assert.match(output.at(-1) ?? '', /^rule Route: \{.*"sources":\["dog\/findings"\].*"action":"run:dog\/triage".*\}$/m);
    assert.doesNotMatch(output.at(-1) ?? '', /^note: /m);
    const docsLintWidened = { sources: [dogfoodPrFlows.sources[0], { ...dogfoodPrFlows.sources[1], repos: ['PostHog/posthog', 'PostHog/posthog.com'] }] };
    assert.deepEqual(await checkDogfoodPack({}, docsLintWidened), [1, ['error: The source dog/docs-lint lists PostHog/posthog.com, which prFlows.repos does not list, so it never reaches it.']]);
    assert.deepEqual((await checkDogfoodPack({ repos: ['acme/app', 'PostHog/posthog'] }))[1], ["error: Rule 'Route' lists acme/app, which prFlows.repos does not list, so it never reaches it."]);
    const twoRepoPack = { repos: ['PostHog/posthog', 'PostHog/posthog.com'], sources: [{ ...dogfoodPrFlows.sources[0], repos: ['PostHog/posthog'] }] };
    assert.deepEqual(await checkDogfoodPack({ repos: ['PostHog/posthog.com'] }, twoRepoPack), [1, ["error: Rule 'Route' is limited to PostHog/posthog.com, but its sources run only on PostHog/posthog, so it never acts."]]);
    assert.deepEqual(await checkDogfoodPack({ sources: ['findings', 'nope'] }), [1, ["error: Rule 'Route' names the source 'nope', which no source of this pack defines, so it never acts on it."]]);
    for (const slashed of [{ sources: ['dog/findings'] }, { action: 'run:dog/triage' }]) {
      const [exitCode, errors] = await checkDogfoodPack(slashed);
      assert.equal(exitCode, 1);
      assert.match(String(errors), /The prFlows section of the pack 'dog' was skipped: pack\.json prFlows\.rules\.0\.(sources\.0|action)/);
    }
    assert.deepEqual(await checkDogfoodPack({ action: 'run:missing' }), [1, ["error: Rule 'Route' names run:dog/missing, which no entry in prFlows.actions defines, so its items wait for you."]]);
    const twoGoButtons = [{ id: 'go', label: 'Go A', command: ['echo', 'a'] }, { id: 'go', label: 'Go B', command: ['echo', 'b'] }];
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'dup', version: 1, prFlows: { prActions: twoGoButtons } }));
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /error: The prFlows section of the pack 'dup' was skipped: pack\.json prFlows\.prActions\.1\.id: the id 'go' is already used in prActions/);
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'dim', version: 1, ui: { themes: [{ id: 'dim', label: 'Dim', mode: 'dim' }] } }));
    assert.equal(await check(brokenDir), 1);
    assert.ok(output.some((line) => line.includes('pack.json ui.themes.0.mode')));
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), '{bad');
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /error: pack\.json is not valid JSON: .*line 1 column 2/);
    fs.mkdirSync(path.join(brokenDir, 'panel'));
    fs.writeFileSync(path.join(brokenDir, 'panel', 'index.html'), '<link rel="stylesheet" href="https://cdn.example.com/x.css"><script src="panel.js"></script><a href="#top">top</a>');
    fs.symlinkSync(path.join(brokenDir, 'pack.json'), path.join(brokenDir, 'link.json'));
    const panels = [{ id: 'one', label: 'One', entry: 'panel/index.html' }, { id: 'two', label: 'Two', entry: 'panel/missing.html' }];
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'many', version: 1, ui: { panels, themes: [{ id: 'dim', label: 'Dim', mode: 'dim' }] } }));
    assert.equal(await check(brokenDir), 1);
    const everyProblem = output.at(-1) ?? '';
    for (const problem of [/link\.json is a symlink/, /ui\.themes\.0\.mode/, /ui\.panels\.1: panel\/missing\.html is not a file in the pack/]) assert.match(everyProblem, problem);
    assert.doesNotMatch(everyProblem, /waits for the operator/);
    fs.rmSync(path.join(brokenDir, 'link.json'));
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'loads', version: 1, ui: { panels: [panels[0]] } }));
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /panel\/index\.html loads https:\/\/cdn\.example\.com\/x\.css, but a panel has no network/);
    assert.match(output.at(-1) ?? '', /panel\/index\.html refers to panel\.js, which is not a file in the pack/);
    assert.doesNotMatch(output.at(-1) ?? '', /#top/);
    fs.writeFileSync(path.join(brokenDir, 'panel', 'panel.js'), "window.glimmervoid.subscribe(['theme', 'usage'], () => {});");
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'loads', version: 1, ui: { panels: [{ ...panels[0], reads: ['theme'] }], themes: [{ id: 'dim', label: 'Dim', mode: 'dark', chrome: { bg: '#2457c' } }] } }));
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /panel\/panel\.js subscribes to 'usage', which panel one does not list under reads/);
    assert.doesNotMatch(output.at(-1) ?? '', /subscribes to 'theme'/);
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), '{ "name": "loads", ');
    assert.equal(await check(brokenDir), 1);
    assert.doesNotMatch(output.at(-1) ?? '', /subscribes to/);
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'loads', version: 1, ui: { panels } }));
    fs.writeFileSync(path.join(brokenDir, 'panel', 'index.html'), '<link rel=stylesheet href=missing.css><img srcset="https://cdn.example/a.png 1x, b.png 2x">');
    assert.equal(await check(brokenDir), 1);
    assert.match(output.at(-1) ?? '', /refers to missing\.css, which is not a file/);
    assert.match(output.at(-1) ?? '', /loads https:\/\/cdn\.example\/a\.png, but a panel has no network/);
    assert.match(output.at(-1) ?? '', /refers to b\.png, which is not a file/);
    fs.writeFileSync(path.join(brokenDir, 'panel', 'index.html'), '<script type="module" src="main.js"></script>');
    fs.writeFileSync(path.join(brokenDir, 'panel', 'main.js'), "import { draw } from './draw.js';\nimport { helper } from './sesion.js';\nimport 'lodash';");
    fs.writeFileSync(path.join(brokenDir, 'panel', 'draw.js'), "export function draw() { window.glimmervoid.subscribe(['usage'], () => {}); }");
    const twoPanels = [{ ...panels[0], reads: ['usage'] }, { id: 'two', label: 'Two', entry: 'panel/two.html', reads: ['theme'] }];
    fs.writeFileSync(path.join(brokenDir, 'panel', 'two.html'), '<script type="module" src="draw.js"></script>');
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'loads', version: 1, ui: { panels: twoPanels } }));
    assert.equal(await check(brokenDir), 1);
    const moduleProblems = output.at(-1) ?? '';
    assert.match(moduleProblems, /panel\/main\.js refers to \.\/sesion\.js, which is not a file in the pack/);
    assert.match(moduleProblems, /panel\/main\.js imports lodash, but a panel has no package resolver/);
    assert.match(moduleProblems, /panel\/draw\.js subscribes to 'usage', which panel two does not list under reads/);
    assert.doesNotMatch(moduleProblems, /which panel one does not list/);
    fs.writeFileSync(path.join(brokenDir, 'panel', 'index.html'), '<script type="module">import{draw}from"./draw.js";import "./gone.js";</script>');
    fs.writeFileSync(path.join(brokenDir, 'panel', 'main.js'), "// import { old } from './old.js';\nconsole.log(1);");
    fs.writeFileSync(path.join(brokenDir, 'pack.json'), JSON.stringify({ name: 'loads', version: 1, ui: { panels: [{ ...panels[0], reads: ['theme'] }] } }));
    assert.equal(await check(brokenDir), 1);
    const inlineProblems = output.at(-1) ?? '';
    assert.match(inlineProblems, /panel\/index\.html refers to \.\/gone\.js, which is not a file in the pack/);
    assert.match(inlineProblems, /panel\/draw\.js subscribes to 'usage', which panel one does not list under reads/);
    assert.doesNotMatch(inlineProblems, /old\.js/);
    const homeWithPacksFile = path.join(homeDir, 'packs-is-a-file');
    fs.mkdirSync(homeWithPacksFile);
    fs.writeFileSync(path.join(homeWithPacksFile, 'packs'), '');
    assert.match((await packDirsUnder(homeWithPacksFile)).warning ?? '', /packs folder .* could not be read/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('an agent reads each PR flows setting with its JSON Schema and a valid example, and pr-flows check names entries, runs sources and prints actions unrun', async () => {
  const view = configFileViewOf('config.json', DEFAULT_CONFIG, {}, false);
  const schemaOf = { 'prFlows.sources': z.array(PrFlowSourceCommand), 'prFlows.actions': z.array(PrFlowCommand), 'prFlows.prActions': z.array(PrFlowPrAction), 'prFlows.rules': z.array(PrFlowRule), 'prFlows.repoRules': z.record(z.string(), z.array(PrFlowRule)) };
  for (const [settingPath, schema] of Object.entries(schemaOf)) {
    const reply = readSettingsForAgent({ command: 'get', path: settingPath }, view);
    assert.ok(reply.ok && 'readout' in reply);
    const readout = z.looseObject({ jsonSchema: z.looseObject({ type: z.string() }), example: z.unknown() }).parse(reply.readout);
    assert.equal(schema.safeParse(readout.example).success, true, settingPath);
  }
  const rulesReply = readSettingsForAgent({ command: 'get', path: 'prFlows.rules' }, view);
  assert.ok(rulesReply.ok && 'readout' in rulesReply);
  const ruleSchema = z.looseObject({ jsonSchema: z.looseObject({ items: z.record(z.string(), z.unknown()) }) }).parse(rulesReply.readout);
  assert.deepEqual(Object.entries(ruleSchema.jsonSchema.items).find(([key]) => key === 'then')?.[1], { required: ['reason'] });

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-flows-check-'));
  try {
    const sourceScript = path.join(homeDir, 'source.mjs');
    fs.writeFileSync(sourceScript, "console.log(JSON.stringify({ findings: [{ path: 'src/a.ts', lineStart: 3, lineEnd: 3, priority: 'high', body: process.argv[2] }] }))");
    const markerPath = path.join(homeDir, 'action-ran');
    const unapprovedMarkerPath = path.join(homeDir, 'unapproved-ran');
    const otherRepoMarkerPath = path.join(homeDir, 'other-repo-ran');
    const otherRepoSource = PrFlowSourceCommand.parse({ id: 'other-repo', label: 'Other repo', repos: ['acme/other'], command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(otherRepoMarkerPath)}, '')`] });
    const scanner = PrFlowCommand.parse({ id: 'scanner', label: 'Scanner', command: [process.execPath, sourceScript, '{head}'] });
    const painter = PrFlowCommand.parse({ id: 'painter', label: 'Painter', command: [process.execPath, '-e', `console.log(JSON.stringify({ findings: [], status: [{ label: 'CI', state: '\\u001b]0;owned' }] }))`] });
    fs.writeFileSync(path.join(homeDir, 'pr-flows-state.json'), JSON.stringify({ handledByPr: {}, reopenedByPr: {}, approvedFingerprints: [commandFingerprint('source', scanner), commandFingerprint('source', painter), commandFingerprint('source', otherRepoSource)] }));
    fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ prFlows: {
      sources: [scanner, painter, { id: 'typo', label: 'Typo', command: ['x', '{pr_url}'] }, { id: 'unapproved', label: 'Unapproved', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(unapprovedMarkerPath)}, '')`] }, otherRepoSource],
      actions: [{ id: 'mark', label: 'Mark', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`, '{itemPath}', '{prUrl}'] }],
    } }));
    let output = '';
    const head = 'd'.repeat(40);
    const env = { ...process.env, GLIMMERVOID_HOME: homeDir, GLIMMERVOID_CONFIG: path.join(homeDir, 'config.json') };
    const exitCode = await runPrFlowsCheck({
      prUrl: 'https://github.com/acme/app/pull/7', isJson: true, homeDir, env, readConfig: () => readConfigFile(env, homeDir),
      runCommand: async (command, args, options) => (command === 'gh' ? { ok: true, stdout: `${head}\n`, stderr: '', exitCode: 0, failureCode: null, signal: null, wasKilled: false } : runCommandSafely(command, args, options)),
    }, { writeOutput: (text) => { output += text; }, writeError: (text) => { output += text; } });
    assert.equal(exitCode, 1);
    const report = z.looseObject({
      entries: z.array(z.looseObject({ id: z.string(), error: z.string().nullable(), argv: z.array(z.string()).nullable() })),
      sourceRuns: z.array(z.looseObject({ id: z.string(), error: z.string().nullable(), output: z.looseObject({ findings: z.array(z.looseObject({ body: z.string() })) }).nullable() })),
      outOfScopeSources: z.array(z.looseObject({ id: z.string(), repos: z.array(z.string()) })),
    }).parse(JSON.parse(output));
    assert.deepEqual(report.entries.map((entry) => [entry.id, entry.error === null]), [['scanner', true], ['painter', true], ['typo', false], ['unapproved', true], ['other-repo', true], ['mark', true]]);
    assert.deepEqual(report.entries.find((entry) => entry.id === 'mark')?.argv?.slice(-2), ['{itemPath}', 'https://github.com/acme/app/pull/7']);
    assert.deepEqual(report.sourceRuns.map((run) => [run.id, run.output?.findings[0]?.body]), [['scanner', head], ['painter', undefined]]);
    assert.match(report.sourceRuns.find((run) => run.id === 'painter')?.error ?? '', /control characters/);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(unapprovedMarkerPath), false);
    assert.deepEqual(report.outOfScopeSources.map((source) => [source.id, source.repos]), [['other-repo', ['acme/other']]]);
    assert.equal(fs.existsSync(otherRepoMarkerPath), false);

    const packDir = path.join(homeDir, 'listed-pack');
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'dog', version: 1, prFlows: { actions: [{ id: 'triage', label: 'Triage', command: ['node', '{packDir}/t.mjs'] }] } }));
    const checkConfig = async (prFlows: unknown) => {
      fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ packs: ['listed-pack'], prFlows }));
      let checkOutput = '';
      const checkExit = await runPrFlowsCheck({ prUrl: null, isJson: false, homeDir, env, readConfig: () => readConfigFile(env, homeDir), runCommand: runCommandSafely }, { writeOutput: (text) => { checkOutput += text; }, writeError: (text) => { checkOutput += text; } });
      return { checkExit, checkOutput };
    };
    const packActionRule = await checkConfig({ rules: [{ name: 'Triage', action: 'run:dog/triage' }] });
    assert.deepEqual([packActionRule.checkExit, packActionRule.checkOutput.match(/^warning: .*/gm)], [0, null]);
    assert.match(packActionRule.checkOutput, /^action dog\/triage \(Triage\): valid/m);
    const missingPackAction = await checkConfig({ rules: [{ name: 'Triage', action: 'run:dog/missing' }] });
    assert.equal(missingPackAction.checkExit, 1);
    assert.match(missingPackAction.checkOutput, /^warning: Rule 'Triage' names run:dog\/missing/m);
    const itemPlaceholderButton = await checkConfig({ prActions: [{ id: 'hand', label: 'Hand', command: ['x', '{headRef}', '{itemPath}'] }] });
    assert.equal(itemPlaceholderButton.checkExit, 1);
    assert.match(itemPlaceholderButton.checkOutput, /^pr-action hand \(Hand\): invalid, \{itemPath\} is not a placeholder of a pr-action; use \{prUrl\}, \{repo\}, \{number\}, \{head\}, \{headRef\}, \{baseRef\}$/m);
    const invalidSection = await checkConfig({ sources: 'not a list' });
    assert.equal(invalidSection.checkExit, 1);
    assert.match(invalidSection.checkOutput, /^warning: prFlows was skipped: /m);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
