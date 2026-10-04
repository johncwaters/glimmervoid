import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBenchmarkWiring } from '../server/benchmark-wiring.ts';
import type { BenchmarkWiringOptions } from '../server/benchmark-wiring.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';
import claudeCode from '../session/adapters/claude-code.ts';
import type { LaneSpawn } from '../server/lane-spawn.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../server/core/lane-permissions-core.ts';
import { absolutePathReadRule } from '../server/core/team-review-core.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES } from '../server/team-review-wiring.ts';
import type { TeamReviewSpawn } from '../server/team-review-wiring.ts';
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

function harness({ root, suite, cases, overrides = {} }: { root: string; suite: Record<string, unknown>; cases: Record<string, unknown>[]; overrides?: Partial<BenchmarkWiringOptions> }) {
  writeJson(path.join(root, 'ladder', 'suite.json'), suite);
  for (const benchmarkCase of cases) writeJson(path.join(root, 'ladder', 'cases', `${String(benchmarkCase.id)}.json`), benchmarkCase);
  const subjectRequests: SubjectRequest[] = [];
  const judgeRequests: JudgeRequest[] = [];
  const statuses: BenchmarkStatusType[] = [];
  const armCommands: { command: string; args: string[]; env: NodeJS.ProcessEnv; signal: AbortSignal }[] = [];
  const wiring = createBenchmarkWiring({
    benchmarksRoot: root,
    isEnabled: () => true,
    broadcast: (status) => statuses.push(BenchmarkStatus.parse(status)),
    github: {
      listMergedPrs: async () => ({ ok: false, reason: 'not used' }),
      benchmarkReviewData: async () => new Map(),
      compareCommits: async () => null,
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
  assert.equal(baselineSpawn?.settingsSandbox.enabled, true);
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

test('a failed arm preflight fails the run with a named cause and spawns no subject', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({
    root, suite: manualSuite(), cases: [manualCase('case-1')],
    overrides: { runArmCommand: async () => ({ ok: false, stdout: '', stderr: 'Not logged in' }) },
  });
  const runId = await runToCompletion(wiring, statuses);
  const run = BenchmarkRun.parse(JSON.parse(fs.readFileSync(path.join(root, 'ladder', 'runs', `${runId}.json`), 'utf8')));
  assert.equal(run.status, 'failed');
  assert.match(String(run.error), /arm baseline preflight failed: Not logged in/);
  assert.deepEqual(run.cells, []);
  assert.equal(subjectRequests.length, 0);
});

test('a second run while one is in flight is refused and cancel interrupts the active run', async () => {
  const root = tempRoot();
  let releaseSubject = () => {};
  const subjectGate = new Promise<void>((resolve) => { releaseSubject = resolve; });
  let subjectStarted = false;
  const { wiring, statuses } = harness({
    root, suite: manualSuite(), cases: [manualCase('case-1')],
    overrides: { spawnSubject: async (request) => { subjectStarted = true; await Promise.race([subjectGate, new Promise((resolve) => request.signal.addEventListener('abort', resolve))]); } },
  });
  const started = await wiring.submitAction({ suiteId: 'ladder', action: 'run' });
  assert.equal(started.ok, true);
  const second = await wiring.submitAction({ suiteId: 'ladder', action: 'run' });
  assert.equal(second.ok, false);
  await waitFor(() => subjectStarted, 'subject spawned', 5000);
  assert.equal((await wiring.submitAction({ suiteId: 'ladder', action: 'cancel' })).ok, true);
  await waitFor(() => statuses.at(-1)?.suites[0]?.latestReport?.status === 'interrupted', 'run interrupted', 5000);
  releaseSubject();
});

test('actions are refused while benchmarks are off, and mining a manual suite or cancelling an idle one is refused', async () => {
  const root = tempRoot();
  const off = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')], overrides: { isEnabled: () => false } });
  assert.deepEqual(await off.wiring.submitAction({ suiteId: 'ladder', action: 'run' }), { suiteId: 'ladder', action: 'run', ok: false, error: 'Benchmarks are off' });
  const on = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  const mined = await on.wiring.submitAction({ suiteId: 'ladder', action: 'mine' });
  assert.equal(mined.ok, false);
  assert.match(String(mined.error), /manual case source/);
  assert.deepEqual(await on.wiring.submitAction({ suiteId: 'ladder', action: 'cancel' }), { suiteId: 'ladder', action: 'cancel', ok: false, error: 'No run of this suite is in flight' });
});

test('a refused sandbox probe refuses the run with its reason before any arm command, subject or run record', async () => {
  const root = tempRoot();
  const refusal = 'not started: the Claude Code sandbox needs bwrap and socat, and bwrap is not on PATH. Install bubblewrap and socat';
  const { wiring, subjectRequests, judgeRequests, armCommands } = harness({
    root, suite: manualSuite(), cases: [manualCase('case-1')], overrides: { sandboxRefusal: () => refusal },
  });
  assert.deepEqual(await wiring.submitAction({ suiteId: 'ladder', action: 'run' }), { suiteId: 'ladder', action: 'run', ok: false, error: refusal });
  assert.deepEqual(armCommands, []);
  assert.deepEqual(subjectRequests, []);
  assert.deepEqual(judgeRequests, []);
  assert.equal(fs.existsSync(path.join(root, 'ladder', 'runs')), false);
});

function reviewedChangeRepo(): { repo: string; baseSha: string; reviewedSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-bench-repo-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'bench@example.com'], repo);
  git(['config', 'user.name', 'Bench'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  const baseSha = git(['rev-parse', 'HEAD'], repo).trim();
  fs.writeFileSync(path.join(repo, 'change.txt'), 'change\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'change'], repo);
  return { repo, baseSha, reviewedSha: git(['rev-parse', 'HEAD'], repo).trim() };
}

const CHECKOUT_PROMPT_TEMPLATE = 'Review {repoPath} from {baseSha} and write to {resultPath}.';

test('a subject that dirties the checkout invalidates its cell and the next cell gets a fresh checkout', { skip: !hasGit() }, async () => {
  const root = tempRoot();
  const { repo, baseSha, reviewedSha } = reviewedChangeRepo();
  const checkoutPaths: string[] = [];
  let subjectCount = 0;
  const { wiring, statuses } = harness({
    root,
    suite: manualSuite({ workspace: { kind: 'pr-checkout' }, subject: { promptTemplate: CHECKOUT_PROMPT_TEMPLATE, output: 'review-findings', timeoutSeconds: 60 } }),
    cases: [manualCase('case-1', { repo: 'Acme/gateway', number: 7, reviewedSha, baseSha, changedFiles: ['change.txt'] })],
    overrides: {
      repoCache: { ensureRepo: async () => repo, hydrateSince: async () => true },
      spawnSubject: async (request) => {
        subjectCount += 1;
        const prompt = fs.readFileSync(path.join(request.cwd, 'subject-prompt.md'), 'utf8');
        const checkoutPath = /Review (\S+) from/.exec(prompt)?.[1] ?? '';
        checkoutPaths.push(checkoutPath);
        if (subjectCount === 1) fs.writeFileSync(path.join(checkoutPath, 'change.txt'), 'edited by the subject\n');
        fs.writeFileSync(path.join(request.cwd, 'subject-output.md'), FINDINGS_OUTPUT);
      },
    },
  });
  const runId = await runToCompletion(wiring, statuses);
  const run = BenchmarkRun.parse(JSON.parse(fs.readFileSync(path.join(root, 'ladder', 'runs', `${runId}.json`), 'utf8')));
  assert.deepEqual(run.cells.map((cell) => cell.status), ['invalid', 'scored']);
  assert.match(String(run.cells[0].error), /changed files in the checkout/);
  assert.notEqual(checkoutPaths[0], checkoutPaths[1]);
  assert.equal(fs.existsSync(checkoutPaths[0]), false);
  assert.equal(fs.existsSync(checkoutPaths[1]), false);
  assert.equal(git(['worktree', 'list', '--porcelain'], repo).includes(checkoutPaths[1]), false);
});

function blockingSubject() {
  const started = { value: false };
  const spawnSubject: TeamReviewSpawn = async (request) => {
    started.value = true;
    await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
  };
  return { started, spawnSubject };
}

test('the subject argv ends the variadic deny list with an option, so the bootstrap prompt is never read as a tool name', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  const baselineSpawn = subjectRequests.find((request) => request.spawnEnv.CLAUDE_CONFIG_DIR === '/stage/baseline/.claude');
  const args = baselineSpawn?.extraClaudeArgs ?? [];
  const lastDenyRule = args.lastIndexOf(TEAM_REVIEW_SESSION_DENY_RULES.at(-1) ?? '');
  assert.ok(lastDenyRule > 0);
  assert.match(args[lastDenyRule + 1] ?? '', /^--/);
});

test('an arm ending in a variadic option cannot swallow the bootstrap prompt in the real claude argv', async () => {
  const root = tempRoot();
  const suite = manualSuite({ arms: [{ id: 'baseline' }, { id: 'candidate', extraArgs: ['--mcp-config', 'a.json'] }] });
  const { wiring, subjectRequests, statuses } = harness({ root, suite, cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  const candidateSpawn = subjectRequests.find((request) => request.extraClaudeArgs.includes('a.json'));
  const extraArgs = candidateSpawn?.extraClaudeArgs ?? [];
  assert.equal(extraArgs.at(-1), '--strict-mcp-config');
  assert.equal(extraArgs[extraArgs.indexOf('a.json') + 1], '--disallowedTools');
  const argv = claudeCode.buildArgs({ extraArgs, initialPrompt: candidateSpawn?.initialPrompt ?? null });
  const promptPosition = argv.indexOf(candidateSpawn?.initialPrompt ?? '');
  assert.ok(promptPosition > 0);
  assert.equal(argv[promptPosition - 1], '--strict-mcp-config');
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

test('the subject sandbox cannot read the suite answer key or reach GitHub', async () => {
  const root = tempRoot();
  const { wiring, subjectRequests, statuses } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  await runToCompletion(wiring, statuses);
  const sandbox = subjectRequests[0]?.settingsSandbox;
  for (const folder of ['cases', 'candidates', 'runs']) assert.ok(sandbox?.filesystem.denyRead.includes(path.join(root, 'ladder', folder)), folder);
  assert.ok(sandbox?.filesystem.denyRead.includes('~/.ssh'));
  assert.equal(sandbox?.network.allowedDomains.some((domain) => /github/i.test(domain)), false);
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

test('cancel goes through while benchmarks are off, and turning them off aborts the active run', async () => {
  const cancelRoot = tempRoot();
  let isCancelHarnessEnabled = true;
  const cancelSubject = blockingSubject();
  const cancelHarness = harness({
    root: cancelRoot, suite: manualSuite(), cases: [manualCase('case-1')],
    overrides: { isEnabled: () => isCancelHarnessEnabled, spawnSubject: cancelSubject.spawnSubject },
  });
  assert.equal((await cancelHarness.wiring.submitAction({ suiteId: 'ladder', action: 'run' })).ok, true);
  await waitFor(() => cancelSubject.started.value, 'subject spawned', 5000);
  isCancelHarnessEnabled = false;
  assert.equal((await cancelHarness.wiring.submitAction({ suiteId: 'ladder', action: 'cancel' })).ok, true);
  await waitFor(() => cancelHarness.statuses.at(-1)?.suites[0]?.latestReport?.status === 'interrupted', 'cancelled run interrupted', 5000);

  const offRoot = tempRoot();
  let isOffHarnessEnabled = true;
  const offSubject = blockingSubject();
  const offHarness = harness({
    root: offRoot, suite: manualSuite(), cases: [manualCase('case-1')],
    overrides: { isEnabled: () => isOffHarnessEnabled, spawnSubject: offSubject.spawnSubject },
  });
  assert.equal((await offHarness.wiring.submitAction({ suiteId: 'ladder', action: 'run' })).ok, true);
  await waitFor(() => offSubject.started.value, 'subject spawned', 5000);
  isOffHarnessEnabled = false;
  await offHarness.wiring.refreshStatus();
  await waitFor(() => offHarness.statuses.at(-1)?.suites[0]?.latestReport?.status === 'interrupted', 'disabled run interrupted', 5000);
});

test('a case whose id differs from its file name refuses the run and names the file', async () => {
  const root = tempRoot();
  const { wiring } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  writeJson(path.join(root, 'ladder', 'cases', 'case-2.json'), manualCase('case-1'));
  const started = await wiring.submitAction({ suiteId: 'ladder', action: 'run' });
  assert.equal(started.ok, false);
  assert.match(String(started.error), /ladder\/cases\/case-2\.json names a different id, case-1/);
});

test('cancelling during arm setup aborts the arm command and spawns no subject', async () => {
  const root = tempRoot();
  const setupSignals: AbortSignal[] = [];
  const { wiring, subjectRequests, statuses } = harness({
    root, suite: manualSuite({ arms: [{ id: 'baseline', setup: { command: ['/bin/stage'] } }, { id: 'candidate' }] }), cases: [manualCase('case-1')],
    overrides: {
      runArmCommand: async (_command, _args, options) => {
        setupSignals.push(options.signal);
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
        return { ok: false, stdout: '', stderr: 'aborted' };
      },
    },
  });
  assert.equal((await wiring.submitAction({ suiteId: 'ladder', action: 'run' })).ok, true);
  await waitFor(() => setupSignals.length === 1, 'arm setup started', 5000);
  assert.equal((await wiring.submitAction({ suiteId: 'ladder', action: 'cancel' })).ok, true);
  await waitFor(() => statuses.at(-1)?.suites[0]?.latestReport?.status === 'interrupted', 'run interrupted', 5000);
  assert.equal(setupSignals[0].aborted, true);
  assert.equal(setupSignals.length, 1);
  assert.equal(subjectRequests.length, 0);
});

test('the startup sweep marks stale running records interrupted and deletes leftover work and worktree dirs', async () => {
  const root = tempRoot();
  const { wiring } = harness({ root, suite: manualSuite(), cases: [manualCase('case-1')] });
  const staleRunPath = path.join(root, 'ladder', 'runs', 'stale.json');
  writeJson(staleRunPath, { id: 'stale', suiteId: 'ladder', status: 'running', startedAt: 1, finishedAt: null, error: null, cells: [] });
  const leftoverWorkDir = path.join(root, 'ladder', 'work', 'old-run', 'case-1');
  const leftoverWorktree = path.join(root, 'ladder', 'worktrees', 'case-1-dead');
  fs.mkdirSync(leftoverWorkDir, { recursive: true });
  fs.mkdirSync(leftoverWorktree, { recursive: true });
  await wiring.sweepLeftovers();
  const settled = BenchmarkRun.parse(JSON.parse(fs.readFileSync(staleRunPath, 'utf8')));
  assert.equal(settled.status, 'interrupted');
  assert.equal(typeof settled.finishedAt, 'number');
  assert.equal(fs.existsSync(path.join(root, 'ladder', 'work')), false);
  assert.equal(fs.existsSync(leftoverWorktree), false);
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
