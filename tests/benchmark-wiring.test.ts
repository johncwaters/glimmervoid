import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createBenchmarkWiring } from '../server/benchmark-wiring.ts';
import type { BenchmarkWiringOptions } from '../server/benchmark-wiring.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createRepoCache } from '../server/git/repo-cache.ts';
import type { LaneSpawn } from '../server/lanes/lane-spawn.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../server/lanes/core/lane-permissions-core.ts';
import { absolutePathReadRule } from '../server/github/core/team-review-core.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES, teamReviewAcceptEditsPermissions } from '../server/github/team-review-wiring.ts';
import type { TeamReviewSpawn } from '../server/github/team-review-wiring.ts';
import { BenchmarkRun, BenchmarkStatus } from '../shared/contracts/benchmark.ts';
import type { BenchmarkStatus as BenchmarkStatusType } from '../shared/contracts/benchmark.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

const ARM_TOKEN = 'arm-oauth-token-value';

type SubjectRequest = Parameters<TeamReviewSpawn>[0];
type JudgeRequest = Parameters<LaneSpawn>[0];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function manualSuite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ladder',
    title: 'Ladder',
    caseSource: { kind: 'manual' },
    workspace: { kind: 'none' },
    subject: { promptTemplate: 'Review it and write findings to {resultPath}.', output: 'review-findings', timeoutSeconds: 60 },
    arms: [
      { id: 'baseline', env: { CLAUDE_CONFIG_DIR: '/stage/baseline/.claude', CODEX_HOME: '/home/codex' } },
      { id: 'candidate', env: { CLAUDE_CONFIG_DIR: '/stage/candidate/.claude' }, extraArgs: ['--model', 'opus'] },
    ],
    baselineArm: 'baseline',
    trials: 1,
    scorer: { kind: 'llm-judge-match', model: 'opus' },
    ...overrides,
  };
}

function manualCase(id: string, input: Record<string, unknown> = {}) {
  return {
    id,
    input,
    references: [{ id: 'r1', text: 'Revocation runs on a cancellable context', tags: ['human'] }],
    source: { kind: 'manual' },
  };
}

const FINDINGS_OUTPUT = [
  'STRUCTURED_FINDINGS:',
  '- file: src/dispatch.ts | line: 9 | side: RIGHT | severity: HIGH | reviewer: code/race | body: Revoke runs on the request context.',
  '',
  'OVERALL_SUMMARY:',
  'One finding. Degraded: none.',
].join('\n');

function runsRootFor(root: string): string {
  return `${root}-runs`;
}

function harness({ root, suite, cases, overrides = {} }: { root: string; suite: Record<string, unknown>; cases: Record<string, unknown>[]; overrides?: Partial<BenchmarkWiringOptions> }) {
  writeJson(path.join(root, 'ladder', 'suite.json'), suite);
  for (const benchmarkCase of cases) writeJson(path.join(root, 'ladder', 'cases', `${String(benchmarkCase.id)}.json`), benchmarkCase);
  const subjectRequests: SubjectRequest[] = [];
  const judgeRequests: JudgeRequest[] = [];
  const statuses: BenchmarkStatusType[] = [];
  const armCommands: { command: string; args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }[] = [];
  const wiring = createBenchmarkWiring({
    benchmarksRoot: root,
    runsRoot: runsRootFor(root),
    isEnabled: () => true,
    broadcast: (status) => statuses.push(BenchmarkStatus.parse(status)),
    store: {
      requestMergedPrs: async () => ({ isRateLimited: false, value: { ok: false, reason: 'not used' } }),
      requestBenchmarkReviewData: async () => ({ isRateLimited: false, value: new Map() }),
      requestCompareCommits: async () => ({ isRateLimited: false, value: null }),
    },
    repoCache: { ensureRepo: async () => null, hydrateSince: async () => false },
    gitWorkspace: createGitWorkspace({}),
    spawnSubject: async (request) => {
      subjectRequests.push(request);
      fs.writeFileSync(path.join(request.cwd, 'subject-output.md'), FINDINGS_OUTPUT);
    },
    spawnJudge: async (request) => {
      judgeRequests.push(request);
      const shownIndex = /F0/.test(request.prompt) ? [0] : [];
      fs.writeFileSync(path.join(request.cwd, 'judge-result.json'), JSON.stringify({ judgements: [{ referenceId: 'r1', verdict: 'found', findingIndexes: shownIndex }] }));
    },
    credentials: { resolveArmToken: async () => ({ ok: true, token: ARM_TOKEN }) },
    claudeCommand: () => '/usr/local/bin/claude',
    runArmCommand: async (command, args, options) => {
      armCommands.push({ command, args, env: options.env, signal: options.signal });
      return { ok: true, stdout: 'BENCHMARK-ARM-READY', stderr: '' };
    },
    baseEnv: { PATH: '/bin' },
    log: { warn: () => {} },
    ...overrides,
  });
  return { wiring, subjectRequests, judgeRequests, statuses, armCommands };
}

async function runToCompletion(wiring: ReturnType<typeof createBenchmarkWiring>, statuses: BenchmarkStatusType[]) {
  const started = await wiring.submitAction({ suiteId: 'ladder', action: 'run' });
  assert.equal(started.ok, true, String(started.error));
  await waitFor(() => statuses.at(-1)?.inFlight === null && statuses.at(-1)?.suites[0]?.latestReport?.status !== 'running' && statuses.at(-1)?.suites[0]?.latestReport !== null, 'run finished', 10000);
  return started.runId ?? '';
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-bench-'));
}

test('each arm env and the injected token reach only that arm subject spawn, and the judge runs on the read-only lane spawn', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, judgeRequests, statuses, armCommands } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  assert.equal(subjectRequests.length, 2);
  const baselineSpawn = subjectRequests.find((request) => request.spawnEnv.CLAUDE_CONFIG_DIR === '/stage/baseline/.claude');
  const candidateSpawn = subjectRequests.find((request) => request.spawnEnv.CLAUDE_CONFIG_DIR === '/stage/candidate/.claude');
  assert.equal(baselineSpawn?.spawnEnv.CODEX_HOME, '/home/codex');
  assert.equal(baselineSpawn?.spawnEnv.CLAUDE_CODE_OAUTH_TOKEN, ARM_TOKEN);
  assert.equal(candidateSpawn?.spawnEnv.CODEX_HOME, undefined);
  assert.equal(candidateSpawn?.extraClaudeArgs.slice(1, 3).join(' '), '--model opus');
  assert.equal(baselineSpawn?.spawnEnv.GH_TOKEN, '');
  assert.ok(baselineSpawn?.extraClaudeArgs.includes('--strict-mcp-config'));
  assert.equal(judgeRequests.length, 2);
  assert.ok(judgeRequests.every((request) => request.model === 'opus' && !('spawnEnv' in request)));
  assert.deepEqual(armCommands.map((command) => command.env.CLAUDE_CONFIG_DIR), ['/stage/baseline/.claude', '/stage/candidate/.claude']);
  assert.ok(armCommands.every((command) => command.env.CLAUDE_CODE_OAUTH_TOKEN === ARM_TOKEN));
});

test('the arm token never appears in a run record or a status push', async () => {
  const root = tempRoot();
  const { wiring, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  const runId = await runToCompletion(wiring, statuses);
  const runText = fs.readFileSync(path.join(root, 'ladder', 'runs', `${runId}.json`), 'utf8');
  const run = BenchmarkRun.parse(JSON.parse(runText));
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.cells.map((cell) => cell.status), ['scored', 'scored']);
  assert.equal(runText.includes(ARM_TOKEN), false);
  assert.equal(JSON.stringify(statuses).includes(ARM_TOKEN), false);
  assert.equal(statuses.at(-1)?.suites[0]?.latestReport?.totals.baseline.recall, 1);
});

function reviewedChangeRepo(): { repo: string; baseSha: string; reviewedSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-bench-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'bench@example.com'], repo);
  git(['config', 'user.name', 'Bench'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'uploadpack.allowFilter', 'true'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'change.txt'), 'before review\n');
  fs.writeFileSync(path.join(repo, 'deleted.txt'), 'removed during review\n');
  fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const baseSha = git(['rev-parse', 'HEAD'], repo).trim();
  fs.writeFileSync(path.join(repo, 'change.txt'), 'change\n');
  fs.rmSync(path.join(repo, 'deleted.txt'));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'change'], repo);
  return { repo, baseSha, reviewedSha: git(['rev-parse', 'HEAD'], repo).trim() };
}

const CHECKOUT_PROMPT_TEMPLATE = 'Review {repoPath} from {baseSha} and write to {resultPath}.';

test('a blobless cached checkout exposes only reviewed refs, keeps the base diff, and replaces a dirtied checkout', { skip: !hasGit() }, async (context) => {
  const root = tempRoot();
  const { repo, baseSha, reviewedSha } = reviewedChangeRepo();
  const cacheRoot = `${root}-cache`;
  context.after(() => {
    for (const directory of [root, repo, cacheRoot, runsRootFor(root)]) fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(repo, 'change.txt'), 'the post-review fix\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'post-review fix'], repo);
  const postReviewSha = git(['rev-parse', 'HEAD'], repo).trim();
  const repoCache = createRepoCache({ rootDir: cacheRoot, remoteUrlFor: () => pathToFileURL(repo).href });
  const cachedRepo = await repoCache.ensureRepo('Acme/gateway');
  assert.ok(cachedRepo);
  assert.match(git(['rev-list', '--objects', '--all', '--missing=print'], cachedRepo), /^\?/m);
  const checkoutPaths: string[] = [];
  const reachableCommitsBySubject: string[][] = [];
  const baseDiffsBySubject: string[] = [];
  const changeTextBySubject: string[] = [];
  let subjectCount = 0;
  const { wiring, statuses } = harness({
    root,
    suite: manualSuite({ workspace: { kind: 'pr-checkout' }, subject: { promptTemplate: CHECKOUT_PROMPT_TEMPLATE, output: 'review-findings', timeoutSeconds: 60 } }),
    cases: [manualCase('case-1', { repo: 'Acme/gateway', number: 7, reviewedSha, baseSha, changedFiles: ['change.txt'] })],
    overrides: {
      repoCache,
      spawnSubject: async (request) => {
        subjectCount += 1;
        const prompt = fs.readFileSync(path.join(request.cwd, 'subject-prompt.md'), 'utf8');
        const checkoutPath = /Review (\S+) from/.exec(prompt)?.[1] ?? '';
        checkoutPaths.push(checkoutPath);
        assert.equal(request.cwd, path.join(path.dirname(checkoutPath), 'work'));
        assert.deepEqual(git(['for-each-ref', '--format=%(refname)'], checkoutPath).trim().split('\n'), ['refs/benchmark/base', 'refs/heads/review']);
        assert.equal(git(['remote'], checkoutPath).trim(), '');
        assert.match(git(['diff', `${baseSha}...HEAD`], checkoutPath), /-before review/);
        assert.equal(fs.readFileSync(path.join(checkoutPath, 'base.txt'), 'utf8'), 'base\n');
        assert.deepEqual(fs.readFileSync(path.join(checkoutPath, 'binary.bin')), Buffer.from([0, 1, 2, 3]));
        reachableCommitsBySubject.push(git(['log', '--all', '--format=%H'], checkoutPath).trim().split('\n').sort());
        baseDiffsBySubject.push(git(['diff', '--name-only', `${baseSha}...HEAD`], checkoutPath).trim());
        changeTextBySubject.push(fs.readFileSync(path.join(checkoutPath, 'change.txt'), 'utf8'));
        if (subjectCount === 1) fs.writeFileSync(path.join(checkoutPath, 'change.txt'), 'edited by the subject\n');
        fs.writeFileSync(path.join(request.cwd, 'subject-output.md'), FINDINGS_OUTPUT);
      },
    },
  });
  const runId = await runToCompletion(wiring, statuses);
  const run = BenchmarkRun.parse(JSON.parse(fs.readFileSync(path.join(root, 'ladder', 'runs', `${runId}.json`), 'utf8')));
  assert.deepEqual(run.cells.map((cell) => cell.status), ['invalid', 'scored']);
  assert.match(String(run.cells[0].error), /changed files in the checkout/);
  assert.equal(path.relative(runsRootFor(root), checkoutPaths[0]).split(path.sep).join('/'), `ladder/${runId}/case-1/checkout`);
  const reviewedHistory = [reviewedSha, baseSha].sort();
  assert.deepEqual(reachableCommitsBySubject, [reviewedHistory, reviewedHistory]);
  assert.ok(reachableCommitsBySubject.every((commits) => !commits.includes(postReviewSha)));
  assert.deepEqual(baseDiffsBySubject, ['change.txt\ndeleted.txt', 'change.txt\ndeleted.txt']);
  assert.deepEqual(changeTextBySubject, ['change\n', 'change\n']);
  assert.equal(fs.existsSync(checkoutPaths[1]), false);
  assert.equal(git(['worktree', 'list', '--porcelain'], cachedRepo).includes(checkoutPaths[1]), false);
});

test('the subject Read permission rules deny every suite answer-key folder', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  const deny = subjectRequests[0]?.settingsPermissions.deny ?? [];
  for (const folder of ['cases', 'candidates', 'runs']) {
    const absoluteFolder = path.join(root, 'ladder', folder).split(path.sep).join('/').replace(/^\/+/, '');
    assert.ok(deny.includes(`Read(//${absoluteFolder}/**)`), folder);
  }
  for (const rule of TEAM_REVIEW_SESSION_DENY_RULES) assert.ok(deny.includes(rule), rule);
});

test('the subject runs under acceptEdits with the lane config edit denies, the hooksPath pin and no skip flag', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  assert.equal(subjectRequests.length, 2);
  for (const request of subjectRequests) {
    assert.equal(request.settingsPermissions.defaultMode, 'acceptEdits');
    assert.equal(JSON.stringify(request).includes('bypassPermissions'), false);
    assert.equal(request.extraClaudeArgs.includes('--dangerously-skip-permissions'), false);
    for (const rule of LANE_CONFIG_EDIT_DENY_RULES) assert.ok(request.settingsPermissions.deny.includes(rule), rule);
    assert.deepEqual(request.extraClaudeArgs.slice(request.extraClaudeArgs.indexOf('--disallowedTools') + 1, -1), [...TEAM_REVIEW_SESSION_DENY_RULES]);
    assert.equal(request.extraClaudeArgs.includes('--allowedTools'), false);
    assert.equal(request.spawnEnv.GIT_CONFIG_KEY_2, 'core.hooksPath');
    assert.equal(request.spawnEnv.GIT_CONFIG_VALUE_2, '');
  }
});

test('a checkout subject is allowed to Read exactly its staged checkout', { skip: !hasGit() }, async () => {
  const root = tempRoot();
  const { repo, baseSha, reviewedSha } = reviewedChangeRepo();
  const allowedReadRules: string[][] = [];
  const checkoutPaths: string[] = [];
  const { wiring, statuses } = harness({
    root,
    suite: manualSuite({ workspace: { kind: 'pr-checkout' }, subject: { promptTemplate: CHECKOUT_PROMPT_TEMPLATE, output: 'review-findings', timeoutSeconds: 60 } }),
    cases: [manualCase('case-1', { repo: 'Acme/gateway', number: 7, reviewedSha, baseSha, changedFiles: ['change.txt'] })],
    overrides: {
      repoCache: { ensureRepo: async () => repo, hydrateSince: async () => true },
      spawnSubject: async (request) => {
        const prompt = fs.readFileSync(path.join(request.cwd, 'subject-prompt.md'), 'utf8');
        checkoutPaths.push(/Review (\S+) from/.exec(prompt)?.[1] ?? '');
        const args = request.extraClaudeArgs;
        allowedReadRules.push(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--strict-mcp-config')));
        fs.writeFileSync(path.join(request.cwd, 'subject-output.md'), FINDINGS_OUTPUT);
      },
    },
  });
  await runToCompletion(wiring, statuses);
  assert.equal(allowedReadRules.length, 2);
  allowedReadRules.forEach((rules, index) => {
    assert.deepEqual(rules, [absolutePathReadRule(checkoutPaths[index] ?? '')]);
  });
});

test('the subject may run codex exec, write its dispatch prompt and read its answer while team review permissions allow nothing', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  assert.deepEqual(subjectRequests[0]?.settingsPermissions.allow, ['Bash(codex exec *)', 'Edit(//tmp/codex-dispatch-*.txt)', 'Read(//tmp/codex-dispatch-*.out)']);
  assert.equal(Object.hasOwn(teamReviewAcceptEditsPermissions(), 'allow'), false);
});

test('the override token never reaches an arm command or a subject spawn env', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses, armCommands } = harness({
    root, suite: manualSuite(), cases: [manualCase('case-1')], overrides: { baseEnv: { PATH: '/bin', GLIMMERVOID_CLAUDE_OAUTH_TOKEN: 'setup-token-value' } },
  });
  await runToCompletion(wiring, statuses);
  assert.ok(armCommands.length > 0);
  assert.ok(armCommands.every((command) => !Object.hasOwn(command.env, 'GLIMMERVOID_CLAUDE_OAUTH_TOKEN')));
  assert.ok(subjectRequests.every((request) => request.spawnEnv.GLIMMERVOID_CLAUDE_OAUTH_TOKEN === ''));
});

test('the startup sweep interrupts stale runs and removes scratch dirs and legacy worktree registrations', { skip: !hasGit() }, async (context) => {
  const root = tempRoot();
  context.after(() => {
    for (const directory of [root, runsRootFor(root)]) fs.rmSync(directory, { recursive: true, force: true });
  });
  const { wiring } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  const staleRunPath = path.join(root, 'ladder', 'runs', 'stale.json');
  writeJson(staleRunPath, { id: 'stale', suiteId: 'ladder', status: 'running', startedAt: 1, finishedAt: null, error: null, cells: [] });
  const leftoverCaseDir = path.join(runsRootFor(root), 'ladder', 'old-run', 'case-1');
  const legacyWorkDir = path.join(root, 'ladder', 'work', 'old-run', 'case-1');
  const legacyWorktree = path.join(root, 'ladder', 'worktrees', 'case-1-dead');
  for (const directory of [path.join(leftoverCaseDir, 'checkout'), path.join(leftoverCaseDir, 'work'), legacyWorkDir]) fs.mkdirSync(directory, { recursive: true });
  const repo = path.join(root, 'legacy-cache');
  fs.mkdirSync(repo);
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base'], repo);
  const sha = git(['rev-parse', 'HEAD'], repo).trim();
  assert.equal((await createGitWorkspace({}).stageDetachedWorktree({ owner: 'lane:test', projectPath: repo, worktreePath: legacyWorktree, sha })).ok, true);
  await wiring.sweepLeftovers();
  const settled = BenchmarkRun.parse(JSON.parse(fs.readFileSync(staleRunPath, 'utf8')));
  assert.equal(settled.status, 'interrupted');
  assert.equal(typeof settled.finishedAt, 'number');
  assert.equal(fs.existsSync(runsRootFor(root)), false);
  assert.equal(fs.existsSync(path.join(root, 'ladder', 'work')), false);
  assert.equal(fs.existsSync(path.join(root, 'ladder', 'worktrees')), false);
  assert.ok(fs.existsSync(path.join(root, 'ladder', 'suite.json')));
  assert.equal(git(['worktree', 'list', '--porcelain'], repo).includes(legacyWorktree), false);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'worktrees')), false);
});

test('a subject that echoes its token leaves no trace of it in the run record and bounds each persisted line', async () => {
  const root = tempRoot();
  const leakingOutput = [
    'STRUCTURED_FINDINGS:',
    `- not a finding line ${ARM_TOKEN} ${'x'.repeat(2000)}`,
    '',
    'OVERALL_SUMMARY:',
    `Degraded: leaked ${ARM_TOKEN}.`,
  ].join('\n');
  const { wiring, statuses } = harness({
    root, suite: manualSuite(), cases: [manualCase('case-1')],
    overrides: { spawnSubject: async (request) => { fs.writeFileSync(path.join(request.cwd, 'subject-output.md'), leakingOutput); } },
  });
  const runId = await runToCompletion(wiring, statuses);
  const runText = fs.readFileSync(path.join(root, 'ladder', 'runs', `${runId}.json`), 'utf8');
  const run = BenchmarkRun.parse(JSON.parse(runText));
  assert.equal(runText.includes(ARM_TOKEN), false);
  assert.ok(run.cells.length > 0);
  assert.ok(run.cells.every((cell) => cell.status === 'error' && String(cell.error).includes('[redacted]') && String(cell.error).length <= 400));
  assert.ok(run.cells.every((cell) => cell.degradedReasons.some((reason) => reason.includes('[redacted]'))));
});
