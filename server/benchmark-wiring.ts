import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { OVERRIDE_TOKEN_ENV } from './claude-credentials.ts';
import { pairedReport, runBenchmark } from './core/benchmark-core.ts';
import type { BenchmarkRunnerDependencies, PlannedCell } from './core/benchmark-core.ts';
import { mineCandidates } from './core/benchmark-mining-core.ts';
import { absolutePathReadRule } from './core/team-review-core.ts';
import { writeJsonAtomic } from './json-file.ts';
import type { LaneSpawn } from './lane-spawn.ts';
import type { PrGh } from './pr-gh.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES, hooksPathPinnedSpawnEnv, teamReviewAcceptEditsPermissions, teamReviewSandbox } from './team-review-wiring.ts';
import type { TeamReviewRepoCache, TeamReviewSpawn } from './team-review-wiring.ts';
import {
  BenchmarkCase, BenchmarkId, BenchmarkRun, BenchmarkStatus, BenchmarkSuite, PrCheckoutCaseInput,
} from '../shared/contracts/benchmark.ts';
import type {
  BenchmarkActionRequest, BenchmarkActionResult, BenchmarkArm, BenchmarkCase as BenchmarkCaseType, BenchmarkInFlightCell,
  BenchmarkRun as BenchmarkRunType, BenchmarkStatus as BenchmarkStatusType, BenchmarkSuite as BenchmarkSuiteType,
  BenchmarkSuiteSummary,
} from '../shared/contracts/benchmark.ts';

const BENCHMARK_LANE_ID = 'benchmark';
const SUBJECT_PROMPT_FILENAME = 'subject-prompt.md';
const SUBJECT_RESULT_FILENAME = 'subject-output.md';
const JUDGE_RESULT_FILENAME = 'judge-result.json';
const SUBJECT_BOOTSTRAP_PROMPT = `Read ${SUBJECT_PROMPT_FILENAME} in the current directory and follow it exactly.`;
const ARM_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const ARM_PREFLIGHT_TIMEOUT_MS = 3 * 60 * 1000;
const ARM_PREFLIGHT_REPLY = 'BENCHMARK-ARM-READY';
const RESULT_MAX_BYTES = 1024 * 1024;
const PERSISTED_LINE_MAX_CHARS = 400;
const REDACTED_SECRET = '[redacted]';
const SUBJECT_UNREADABLE_SUITE_FOLDERS = Object.freeze(['cases', 'candidates', 'runs']);

type ArmCommandRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

interface BenchmarkGitWorkspace {
  stageDetachedWorktree(args: { projectPath: string; worktreePath?: string; sha?: string }): Promise<{ ok: boolean; err?: string }>;
  removeWorktreeByPath(args: { projectPath: string; cwd?: string | null }): Promise<{ ok: boolean; err?: string }>;
  probeWorktreeDirty(args: { projectPath: string; cwd: string; branch: string }): Promise<{ ok: boolean; dirty: boolean; headSha: string | null; err?: string }>;
}

interface BenchmarkWiringOptions {
  benchmarksRoot: string;
  isEnabled: () => boolean;
  broadcast: (status: BenchmarkStatusType) => void;
  github: Pick<PrGh, 'listMergedPrs' | 'benchmarkReviewData' | 'compareCommits'>;
  repoCache: Pick<TeamReviewRepoCache, 'ensureRepo' | 'hydrateSince'>;
  gitWorkspace: BenchmarkGitWorkspace;
  spawnSubject: TeamReviewSpawn;
  spawnJudge: LaneSpawn;
  credentials: { resolveArmToken(cellTimeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: true; token: string } | { ok: false; reason: string }> };
  claudeCommand: () => string | null;
  runArmCommand?: ArmCommandRunner;
  sandboxRefusal?: SandboxSpawnRefusal;
  baseEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  randomSuffix?: () => string;
  log?: Pick<Console, 'warn'>;
}

interface StagedCase {
  projectPath: string | null;
  worktreePath: string | null;
  workDir: string;
  reviewedSha: string | null;
}

interface ActiveRun {
  suiteId: string;
  runId: string;
  controller: AbortController;
  finished: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadableSuiteSummary(suiteId: string, error: string): BenchmarkSuiteSummary {
  return { id: suiteId, title: suiteId, error, caseCount: 0, candidateCount: 0, armIds: [], baselineArm: null, latestReport: null };
}

function firstIssue(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const [issue] = error.issues;
  if (!issue) return 'unreadable';
  return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

async function runArmCommandSafely(command: string, args: string[], { cwd, env, timeoutMs, signal }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: RESULT_MAX_BYTES, signal });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = (error ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return { ok: false, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr || failure.message || '') };
  }
}

function withoutOverrideToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const armBaseEnv: NodeJS.ProcessEnv = { ...env };
  delete armBaseEnv[OVERRIDE_TOKEN_ENV];
  return armBaseEnv;
}

function redactedLine(text: string, secrets: ReadonlySet<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join(REDACTED_SECRET);
  }
  return redacted.slice(0, PERSISTED_LINE_MAX_CHARS);
}

function redactedRun(run: BenchmarkRunType, secrets: ReadonlySet<string>): BenchmarkRunType {
  const redactNullable = (text: string | null) => text === null ? null : redactedLine(text, secrets);
  return {
    ...run,
    error: redactNullable(run.error),
    cells: run.cells.map((cell) => ({ ...cell, error: redactNullable(cell.error), degradedReasons: cell.degradedReasons.map((reason) => redactedLine(reason, secrets)) })),
  };
}

function subjectUnreadableFolders(suiteDirectory: string): string[] {
  return SUBJECT_UNREADABLE_SUITE_FOLDERS.map((folder) => path.join(suiteDirectory, folder));
}

function benchmarkSubjectPermissions(suiteDirectory: string): { deny: string[]; defaultMode: string } {
  const permissions = teamReviewAcceptEditsPermissions();
  return { ...permissions, deny: [...permissions.deny, ...subjectUnreadableFolders(suiteDirectory).map(absolutePathReadRule)] };
}

function benchmarkSubjectClaudeArgs(armExtraArgs: readonly string[], checkoutPath: string | null): string[] {
  const readAllowArgs = checkoutPath === null ? [] : ['--allowedTools', absolutePathReadRule(checkoutPath)];
  return ['-p', ...armExtraArgs, '--disallowedTools', ...TEAM_REVIEW_SESSION_DENY_RULES, ...readAllowArgs, '--strict-mcp-config'];
}

function benchmarkSubjectSandbox(workDir: string, suiteDirectory: string) {
  const sandbox = teamReviewSandbox(workDir);
  return {
    ...sandbox,
    network: { ...sandbox.network, allowedDomains: sandbox.network.allowedDomains.filter((domain) => !/github/i.test(domain)) },
    filesystem: {
      ...sandbox.filesystem,
      denyRead: [...sandbox.filesystem.denyRead, ...subjectUnreadableFolders(suiteDirectory)],
    },
  };
}

function worktreeOwnerRepo(gitFileText: string): string | null {
  const gitDir = /^gitdir:\s*(.+)$/m.exec(gitFileText)?.[1]?.trim();
  if (!gitDir) return null;
  const worktreesDir = path.dirname(gitDir);
  const dotGitDir = path.dirname(worktreesDir);
  if (path.basename(worktreesDir) !== 'worktrees' || path.basename(dotGitDir) !== '.git') return null;
  return path.dirname(dotGitDir);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function jsonFileNames(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
}

async function readBoundedText(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size > RESULT_MAX_BYTES) return null;
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

function createBenchmarkWiring({
  benchmarksRoot, isEnabled, broadcast, github, repoCache, gitWorkspace, spawnSubject, spawnJudge, credentials, claudeCommand,
  runArmCommand = runArmCommandSafely,
  sandboxRefusal = allowSandboxedSpawn,
  baseEnv = process.env,
  now = () => Date.now(),
  randomSuffix = () => randomBytes(4).toString('hex'),
  log = console,
}: BenchmarkWiringOptions) {
  let activeRun: ActiveRun | null = null;
  let inFlight: BenchmarkInFlightCell | null = null;
  let suites: BenchmarkSuiteSummary[] = [];
  let leftoverSweep: Promise<void> = Promise.resolve();

  const suiteDir = (suiteId: string) => path.join(benchmarksRoot, suiteId);

  function currentStatus(): BenchmarkStatusType {
    return BenchmarkStatus.parse({
      type: 'benchmark-status', ts: now(), configured: isEnabled(), reason: isEnabled() ? null : 'Benchmarks are off', suites, inFlight,
    });
  }

  async function loadSuite(suiteId: string): Promise<{ ok: true; suite: BenchmarkSuiteType } | { ok: false; reason: string }> {
    const parsed = BenchmarkSuite.safeParse(await readJsonFile(path.join(suiteDir(suiteId), 'suite.json')).catch(() => null));
    if (!parsed.success) return { ok: false, reason: `${suiteId}/suite.json is missing or invalid: ${firstIssue(parsed.error)}` };
    if (parsed.data.id !== suiteId) return { ok: false, reason: `${suiteId}/suite.json names a different id, ${parsed.data.id}` };
    return { ok: true, suite: parsed.data };
  }

  async function loadCases(suiteId: string, folder: 'cases' | 'candidates'): Promise<{ ok: true; cases: BenchmarkCaseType[] } | { ok: false; reason: string }> {
    const directory = path.join(suiteDir(suiteId), folder);
    const cases: BenchmarkCaseType[] = [];
    for (const fileName of await jsonFileNames(directory)) {
      const parsed = BenchmarkCase.safeParse(await readJsonFile(path.join(directory, fileName)).catch(() => null));
      if (!parsed.success) return { ok: false, reason: `${suiteId}/${folder}/${fileName} is invalid: ${firstIssue(parsed.error)}` };
      if (`${parsed.data.id}.json` !== fileName) return { ok: false, reason: `${suiteId}/${folder}/${fileName} names a different id, ${parsed.data.id}` };
      cases.push(parsed.data);
    }
    return { ok: true, cases };
  }

  async function latestRun(suiteId: string): Promise<BenchmarkRunType | null> {
    const directory = path.join(suiteDir(suiteId), 'runs');
    let newest: BenchmarkRunType | null = null;
    for (const fileName of await jsonFileNames(directory)) {
      const parsed = BenchmarkRun.safeParse(await readJsonFile(path.join(directory, fileName)).catch(() => null));
      if (!parsed.success) continue;
      if (newest && newest.startedAt >= parsed.data.startedAt) continue;
      newest = parsed.data;
    }
    return newest;
  }

  async function summarizeSuite(suiteId: string): Promise<BenchmarkSuiteSummary> {
    const loaded = await loadSuite(suiteId);
    if (!loaded.ok) return unreadableSuiteSummary(suiteId, loaded.reason);
    const { suite } = loaded;
    const cases = await loadCases(suiteId, 'cases');
    const candidateCount = (await jsonFileNames(path.join(suiteDir(suiteId), 'candidates'))).length;
    const summary = { ...unreadableSuiteSummary(suiteId, ''), title: suite.title, candidateCount, armIds: suite.arms.map((arm) => arm.id), baselineArm: suite.baselineArm };
    if (!cases.ok) return { ...summary, error: cases.reason };
    const run = await latestRun(suiteId);
    const referencesByCase = Object.fromEntries(cases.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase.references]));
    return { ...summary, error: null, caseCount: cases.cases.length, latestReport: run ? pairedReport({ suite, run, referencesByCase }) : null };
  }

  let pendingRefresh: Promise<unknown> = Promise.resolve();

  function refreshStatus(): Promise<BenchmarkStatusType> {
    if (!isEnabled()) activeRun?.controller.abort();
    const refreshed = pendingRefresh.then(summarizeAndBroadcast);
    pendingRefresh = refreshed.catch((error: unknown) => log.warn(`[${BENCHMARK_LANE_ID}] status refresh failed: ${errorMessage(error)}`));
    return refreshed;
  }

  async function summarizeAndBroadcast(): Promise<BenchmarkStatusType> {
    const entries = await fs.readdir(benchmarksRoot, { withFileTypes: true }).catch(() => []);
    const suiteIds = entries.filter((entry) => entry.isDirectory() && BenchmarkId.safeParse(entry.name).success).map((entry) => entry.name).sort();
    const summaries: BenchmarkSuiteSummary[] = [];
    for (const suiteId of suiteIds) summaries.push(await summarizeSuite(suiteId).catch((error: unknown) => unreadableSuiteSummary(suiteId, errorMessage(error))));
    suites = summaries;
    const status = currentStatus();
    broadcast(status);
    return status;
  }

  function reportProgress(cell: BenchmarkInFlightCell | null): void {
    inFlight = cell;
    broadcast(currentStatus());
  }

  async function mine(suiteId: string): Promise<Omit<BenchmarkActionResult, 'suiteId' | 'action'>> {
    const loaded = await loadSuite(suiteId);
    if (!loaded.ok) return { ok: false, error: loaded.reason };
    const { caseSource } = loaded.suite;
    if (caseSource.kind !== 'github-merged-prs') return { ok: false, error: 'This suite has a manual case source, so there is nothing to mine' };
    const knownCaseIds = new Set<string>();
    for (const folder of ['cases', 'candidates'] as const) {
      for (const fileName of await jsonFileNames(path.join(suiteDir(suiteId), folder))) knownCaseIds.add(fileName.replace(/\.json$/, ''));
    }
    const mined = await mineCandidates({
      repo: caseSource.repo, limit: caseSource.limit, minBodies: caseSource.minBodies, knownCaseIds, now,
      listMergedPrs: (repo, limit) => github.listMergedPrs(repo, limit),
      reviewData: (repo, numbers) => github.benchmarkReviewData(repo, numbers),
      compareCommits: (repo, base, head) => github.compareCommits(repo, base, head),
    });
    if (!mined.ok) return { ok: false, error: mined.reason };
    const candidatesDir = path.join(suiteDir(suiteId), 'candidates');
    await fs.mkdir(candidatesDir, { recursive: true });
    for (const outcome of mined.outcomes) {
      if (!outcome.candidate) {
        log.warn(`[${BENCHMARK_LANE_ID}] ${caseSource.repo}#${outcome.number} not mined: ${outcome.refusal}`);
        continue;
      }
      await writeJsonAtomic(path.join(candidatesDir, `${outcome.candidate.id}.json`), outcome.candidate);
    }
    return { ok: true };
  }

  async function prepareArms(suite: BenchmarkSuiteType, signal: AbortSignal, usedTokens: Set<string>): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cancelled = { ok: false as const, reason: 'the run was cancelled while preparing arms' };
    for (const arm of suite.arms) {
      if (signal.aborted) return cancelled;
      const armEnv = { ...withoutOverrideToken(baseEnv), ...(arm.env ?? {}) };
      if (arm.setup) {
        const [command, ...args] = arm.setup.command;
        const setup = await runArmCommand(command, args, { cwd: suiteDir(suite.id), env: armEnv, timeoutMs: ARM_SETUP_TIMEOUT_MS, signal });
        if (signal.aborted) return cancelled;
        if (!setup.ok) return { ok: false, reason: `arm ${arm.id} setup failed: ${firstLine(setup.stderr) || 'the setup command exited with an error'}` };
      }
      const token = await credentials.resolveArmToken(suite.subject.timeoutSeconds, signal);
      if (signal.aborted) return cancelled;
      if (!token.ok) return { ok: false, reason: `arm ${arm.id} has no Claude Code credential: ${token.reason}` };
      usedTokens.add(token.token);
      const claude = claudeCommand();
      if (!claude) return { ok: false, reason: 'the claude command could not be found' };
      const preflight = await runArmCommand(claude, ['-p', `Reply with only the text ${ARM_PREFLIGHT_REPLY}.`, ...(arm.extraArgs ?? [])], {
        cwd: suiteDir(suite.id), env: { ...armEnv, CLAUDE_CODE_OAUTH_TOKEN: token.token }, timeoutMs: ARM_PREFLIGHT_TIMEOUT_MS, signal,
      });
      if (signal.aborted) return cancelled;
      if (!preflight.ok || !preflight.stdout.includes(ARM_PREFLIGHT_REPLY)) {
        return { ok: false, reason: `arm ${arm.id} preflight failed: ${firstLine(preflight.stdout) || firstLine(preflight.stderr) || 'Claude Code did not answer'}` };
      }
    }
    return { ok: true };
  }

  function createRunDependencies(suite: BenchmarkSuiteType, cases: BenchmarkCaseType[], runId: string, controller: AbortController): {
    dependencies: BenchmarkRunnerDependencies;
    cleanup: () => Promise<void>;
  } {
    const runDir = path.join(suiteDir(suite.id), 'work', runId);
    const worktreesDir = path.join(suiteDir(suite.id), 'worktrees');
    const runsDir = path.join(suiteDir(suite.id), 'runs');
    const stagedCases = new Map<string, StagedCase>();
    const usedTokens = new Set<string>();

    async function removeCheckout(staged: StagedCase): Promise<void> {
      if (!staged.projectPath || !staged.worktreePath) return;
      const removal = await gitWorkspace.removeWorktreeByPath({ projectPath: staged.projectPath, cwd: staged.worktreePath })
        .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
      if (!removal.ok) log.warn(`[${BENCHMARK_LANE_ID}] could not remove ${staged.worktreePath}: ${firstLine(removal.err ?? '')}`);
      staged.worktreePath = null;
    }

    async function stageCheckout(benchmarkCase: BenchmarkCaseType, staged: StagedCase): Promise<{ ok: true } | { ok: false; reason: string }> {
      const input = PrCheckoutCaseInput.safeParse(benchmarkCase.input);
      if (!input.success) return { ok: false, reason: 'the case input is not a pull request checkout' };
      const projectPath = await repoCache.ensureRepo(input.data.repo);
      if (!projectPath) return { ok: false, reason: `could not clone ${input.data.repo}` };
      const isReviewedRangeAvailable = await repoCache.hydrateSince(input.data.repo, input.data.baseSha, input.data.reviewedSha);
      if (!isReviewedRangeAvailable) return { ok: false, reason: 'the reviewed commit could not be fetched, or the base is not its ancestor' };
      const worktreePath = path.join(worktreesDir, `${benchmarkCase.id}-${randomSuffix()}`);
      await fs.mkdir(worktreesDir, { recursive: true });
      const created = await gitWorkspace.stageDetachedWorktree({ projectPath, worktreePath, sha: input.data.reviewedSha });
      if (!created.ok) return { ok: false, reason: `could not stage a checkout: ${firstLine(created.err ?? '') || 'git worktree add failed'}` };
      staged.projectPath = projectPath;
      staged.worktreePath = worktreePath;
      staged.reviewedSha = input.data.reviewedSha;
      return { ok: true };
    }

    async function stagedCaseFor(benchmarkCase: BenchmarkCaseType): Promise<StagedCase> {
      const existing = stagedCases.get(benchmarkCase.id);
      if (existing) return existing;
      const workDir = path.join(runDir, benchmarkCase.id);
      await fs.mkdir(workDir, { recursive: true });
      const staged: StagedCase = { projectPath: null, worktreePath: null, workDir, reviewedSha: null };
      stagedCases.set(benchmarkCase.id, staged);
      return staged;
    }

    const dependencies: BenchmarkRunnerDependencies = {
      suite,
      cases,
      runId,
      now,
      signal: controller.signal,
      prepareArms: () => prepareArms(suite, controller.signal, usedTokens),
      async prepareWorkspace(benchmarkCase) {
        const staged = await stagedCaseFor(benchmarkCase);
        const resultPath = path.join(staged.workDir, SUBJECT_RESULT_FILENAME);
        const workspaceVariables: Record<string, string> = { resultPath };
        if (suite.workspace.kind === 'none') return { ok: true, variables: workspaceVariables };
        if (!staged.worktreePath) {
          const checkout = await stageCheckout(benchmarkCase, staged);
          if (!checkout.ok) return checkout;
        }
        const input = PrCheckoutCaseInput.parse(benchmarkCase.input);
        return {
          ok: true,
          variables: { resultPath, repoPath: staged.worktreePath ?? '', baseSha: input.baseSha, changedFiles: input.changedFiles.join('\n') },
        };
      },
      async verifyWorkspace(benchmarkCase) {
        const staged = stagedCases.get(benchmarkCase.id);
        if (suite.workspace.kind === 'none' || !staged?.projectPath || !staged.worktreePath) return { clean: true };
        const probe = await gitWorkspace.probeWorktreeDirty({ projectPath: staged.projectPath, cwd: staged.worktreePath, branch: '' });
        const isUntouched = probe.ok && !probe.dirty && probe.headSha === staged.reviewedSha;
        if (isUntouched) return { clean: true };
        await removeCheckout(staged);
        if (!probe.ok) return { clean: false, reason: `the checkout could not be checked: ${firstLine(probe.err ?? '')}` };
        return { clean: false, reason: probe.dirty ? 'the subject changed files in the checkout' : 'the subject moved the checkout HEAD' };
      },
      async runSubject({ cell, arm, prompt, timeoutSeconds, signal }) {
        return runSubjectSession({ cell, arm, prompt, timeoutSeconds, signal, usedTokens, suiteDirectory: suiteDir(suite.id), staged: stagedCases.get(cell.caseId) ?? null });
      },
      async runJudge({ cell, prompt, model, signal }) {
        return runJudgeSession({ cell, prompt, model, signal, runDir });
      },
      judgeSeed: (cell) => cell.index + 1,
      async persist(run) {
        await fs.mkdir(runsDir, { recursive: true });
        await writeJsonAtomic(path.join(runsDir, `${runId}.json`), redactedRun(run, usedTokens));
      },
      reportProgress,
    };

    async function cleanup(): Promise<void> {
      for (const staged of stagedCases.values()) await removeCheckout(staged);
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }

    return { dependencies, cleanup };
  }

  async function runSubjectSession({ cell, arm, prompt, timeoutSeconds, signal, usedTokens, suiteDirectory, staged }: {
    cell: PlannedCell; arm: BenchmarkArm; prompt: string; timeoutSeconds: number; signal: AbortSignal; usedTokens: Set<string>; suiteDirectory: string; staged: StagedCase | null;
  }): Promise<{ ok: true; output: string; costUsd: number | null } | { ok: false; reason: string; costUsd: number | null }> {
    if (!staged) return { ok: false, reason: 'the case workspace was never prepared', costUsd: null };
    const token = await credentials.resolveArmToken(timeoutSeconds, signal);
    if (!token.ok) return { ok: false, reason: token.reason, costUsd: null };
    usedTokens.add(token.token);
    const resultPath = path.join(staged.workDir, SUBJECT_RESULT_FILENAME);
    await fs.rm(resultPath, { force: true });
    await fs.writeFile(path.join(staged.workDir, SUBJECT_PROMPT_FILENAME), prompt, 'utf8');
    const baseSpawnEnv = hooksPathPinnedSpawnEnv(staged.workDir);
    await fs.mkdir(baseSpawnEnv.GH_CONFIG_DIR, { recursive: true });
    const subjectController = new AbortController();
    const stopSubject = () => subjectController.abort();
    let hasTimedOut = false;
    const timeoutHandle = setTimeout(() => {
      hasTimedOut = true;
      stopSubject();
    }, timeoutSeconds * 1000);
    if (signal.aborted) {
      clearTimeout(timeoutHandle);
      return { ok: false, reason: 'the run was cancelled before the subject started', costUsd: null };
    }
    signal.addEventListener('abort', stopSubject, { once: true });
    try {
      await spawnSubject({
        id: `${BENCHMARK_LANE_ID}:${cell.caseId}:${arm.id}:${cell.trial}:${randomSuffix()}`,
        name: `Benchmark ${cell.caseId} ${arm.id} trial ${cell.trial}`,
        cwd: staged.workDir,
        spawnEnv: { ...baseSpawnEnv, ...(arm.env ?? {}), [OVERRIDE_TOKEN_ENV]: '', CLAUDE_CODE_OAUTH_TOKEN: token.token },
        extraClaudeArgs: benchmarkSubjectClaudeArgs(arm.extraArgs ?? [], staged.worktreePath),
        settingsPermissions: benchmarkSubjectPermissions(suiteDirectory),
        settingsSandbox: benchmarkSubjectSandbox(staged.workDir, suiteDirectory),
        signal: subjectController.signal,
        initialPrompt: SUBJECT_BOOTSTRAP_PROMPT,
      });
    } catch (error) {
      return { ok: false, reason: `the subject session failed: ${firstLine(errorMessage(error))}`, costUsd: null };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', stopSubject);
    }
    if (hasTimedOut) return { ok: false, reason: `the subject timed out after ${timeoutSeconds}s`, costUsd: null };
    const output = await readBoundedText(resultPath);
    if (output === null) return { ok: false, reason: `the subject wrote no ${SUBJECT_RESULT_FILENAME}`, costUsd: null };
    return { ok: true, output, costUsd: null };
  }

  async function runJudgeSession({ cell, prompt, model, signal, runDir }: {
    cell: PlannedCell; prompt: string; model: string; signal: AbortSignal; runDir: string;
  }): Promise<{ ok: true; output: string; costUsd: number | null } | { ok: false; reason: string; costUsd: number | null }> {
    await fs.mkdir(runDir, { recursive: true });
    const judgeDir = await fs.mkdtemp(path.join(runDir, `judge-${cell.index}-`));
    const resultPath = path.join(judgeDir, JUDGE_RESULT_FILENAME);
    try {
      await spawnJudge({
        id: `${BENCHMARK_LANE_ID}:judge:${cell.caseId}:${cell.armId}:${cell.trial}:${randomSuffix()}`,
        name: `Benchmark judge ${cell.caseId} ${cell.armId}`,
        prompt: `${prompt}\n\nWrite exactly that JSON, and nothing else, to the file ${JUDGE_RESULT_FILENAME} in the current directory with the Write tool.`,
        cwd: judgeDir,
        model,
        signal,
      });
      const output = await readBoundedText(resultPath);
      if (output === null) return { ok: false, reason: `the judge wrote no ${JUDGE_RESULT_FILENAME}`, costUsd: null };
      return { ok: true, output, costUsd: null };
    } catch (error) {
      return { ok: false, reason: `the judge session failed: ${firstLine(errorMessage(error))}`, costUsd: null };
    } finally {
      await fs.rm(judgeDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function startRun(suiteId: string): Promise<Omit<BenchmarkActionResult, 'suiteId' | 'action'>> {
    await leftoverSweep;
    if (activeRun) return { ok: false, error: `A run of ${activeRun.suiteId} is already in flight` };
    const sandboxRefusalReason = sandboxRefusal();
    if (sandboxRefusalReason !== null) return { ok: false, error: sandboxRefusalReason };
    const loaded = await loadSuite(suiteId);
    if (!loaded.ok) return { ok: false, error: loaded.reason };
    const cases = await loadCases(suiteId, 'cases');
    if (!cases.ok) return { ok: false, error: cases.reason };
    if (cases.cases.length === 0) return { ok: false, error: 'This suite has no approved cases; move candidates into its cases folder first' };
    if (activeRun) return { ok: false, error: 'Another run started first' };
    const runId = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomSuffix()}`;
    const controller = new AbortController();
    const { dependencies, cleanup } = createRunDependencies(loaded.suite, cases.cases, runId, controller);
    const finished = runBenchmark(dependencies)
      .catch((error: unknown) => log.warn(`[${BENCHMARK_LANE_ID}] run ${runId} stopped: ${errorMessage(error)}`))
      .then(cleanup)
      .catch((error: unknown) => log.warn(`[${BENCHMARK_LANE_ID}] run ${runId} cleanup failed: ${errorMessage(error)}`))
      .finally(() => {
        activeRun = null;
        inFlight = null;
        void refreshStatus();
      });
    activeRun = { suiteId, runId, controller, finished };
    return { ok: true, runId };
  }

  function cancel(suiteId: string): Omit<BenchmarkActionResult, 'suiteId' | 'action'> {
    if (!activeRun || activeRun.suiteId !== suiteId) return { ok: false, error: 'No run of this suite is in flight' };
    activeRun.controller.abort();
    return { ok: true, runId: activeRun.runId };
  }

  async function submitAction(request: BenchmarkActionRequest): Promise<BenchmarkActionResult> {
    const respond = (outcome: Omit<BenchmarkActionResult, 'suiteId' | 'action'>): BenchmarkActionResult => ({ suiteId: request.suiteId, action: request.action, ...outcome });
    if (!isEnabled() && request.action !== 'cancel') return respond({ ok: false, error: 'Benchmarks are off' });
    const handlers = {
      mine: () => mine(request.suiteId),
      run: () => startRun(request.suiteId),
      cancel: async () => cancel(request.suiteId),
    };
    const outcome = await handlers[request.action]().catch((error: unknown) => ({ ok: false, error: errorMessage(error) }));
    await refreshStatus();
    return respond(outcome);
  }

  async function removeLeftoverWorktree(worktreePath: string): Promise<void> {
    const projectPath = worktreeOwnerRepo(await fs.readFile(path.join(worktreePath, '.git'), 'utf8').catch(() => ''));
    if (projectPath) {
      const removal = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: worktreePath }).catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
      if (!removal.ok) log.warn(`[${BENCHMARK_LANE_ID}] could not remove leftover ${worktreePath}: ${firstLine(removal.err ?? '')}`);
    }
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }

  async function settleStaleRuns(runsDir: string): Promise<void> {
    for (const fileName of await jsonFileNames(runsDir)) {
      const runPath = path.join(runsDir, fileName);
      const parsed = BenchmarkRun.safeParse(await readJsonFile(runPath).catch(() => null));
      if (!parsed.success || parsed.data.status !== 'running') continue;
      await writeJsonAtomic(runPath, { ...parsed.data, status: 'interrupted', finishedAt: now() });
    }
  }

  async function sweepSuiteLeftovers(suiteId: string): Promise<void> {
    const worktreesDir = path.join(suiteDir(suiteId), 'worktrees');
    const worktreeEntries = await fs.readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of worktreeEntries) {
      if (entry.isDirectory()) await removeLeftoverWorktree(path.join(worktreesDir, entry.name));
    }
    await fs.rm(path.join(suiteDir(suiteId), 'work'), { recursive: true, force: true }).catch(() => {});
    await settleStaleRuns(path.join(suiteDir(suiteId), 'runs'));
  }

  async function sweepAllLeftovers(): Promise<void> {
    if (activeRun) return;
    const entries = await fs.readdir(benchmarksRoot, { withFileTypes: true }).catch(() => []);
    const suiteIds = entries.filter((entry) => entry.isDirectory() && BenchmarkId.safeParse(entry.name).success).map((entry) => entry.name);
    for (const suiteId of suiteIds) {
      await sweepSuiteLeftovers(suiteId).catch((error: unknown) => log.warn(`[${BENCHMARK_LANE_ID}] could not sweep ${suiteId}: ${errorMessage(error)}`));
    }
  }

  function sweepLeftovers(): Promise<void> {
    leftoverSweep = sweepAllLeftovers();
    return leftoverSweep;
  }

  async function stop(): Promise<void> {
    const running = activeRun;
    if (!running) return;
    running.controller.abort();
    await running.finished;
  }

  return { getStatus: currentStatus, refreshStatus, submitAction, sweepLeftovers, stop };
}

type BenchmarkWiring = ReturnType<typeof createBenchmarkWiring>;

export { BENCHMARK_LANE_ID, createBenchmarkWiring };
export type { ArmCommandRunner, BenchmarkGitWorkspace, BenchmarkWiring, BenchmarkWiringOptions };
