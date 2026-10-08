import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MyPrKeepMergeableRequest, MyPrMergeWhenReadyRequest, MyPrsState, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrKeepMergeableResult, MyPrMergeabilityFixResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyResult, MyPrsState as MyPrsStateType, MyPrsStatus as MyPrsStatusType } from '../shared/contracts/my-prs.ts';
import { myPrMergeRefusal } from '../shared/my-pr-merge.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import * as core from './core/my-prs-core.ts';
import { nulSeparatedPaths } from './core/git-changed-paths-core.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import { createMyPrsPoller } from './my-prs-poller.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import { prBaseRef, prKey, readTeamReviewSettings } from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';
import { createJsonStateStore } from './json-file.ts';
import { execFileAsync } from './child-process-safe.ts';
import { drainPending, firstLine, raceWithAbort } from './ephemeral-session.ts';
import type { CommandResult } from './repo-cache.ts';
import { emptyGhConfigDir, hooksPathPinnedSpawnEnv, keepMergeableSandbox, makeTeamReviewWorkDir, sweepLeftoverCheckouts } from './team-review-wiring.ts';
import type { TeamReviewGitWorkspace, TeamReviewRepoCache, TeamReviewSpawn } from './team-review-wiring.ts';
import type { TeamReviewReapOptions } from './team-review-reaper.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { CommitSha } from '../shared/contracts/team-review.ts';

type MyPrsPoller = ReturnType<typeof createMyPrsPoller>;
type MyPrsPollerDependencies = Parameters<typeof createMyPrsPoller>[0];
type MyPrMergeOutcome = Omit<MyPrMergeResult, 'key'>;

const MERGE_ERROR_MAX_CHARACTERS = 300;
const TRUSTED_GIT_TIMEOUT_MS = 10 * 60 * 1000;
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const KEEP_MERGEABLE_HANDOFF_REF_PREFIX = 'refs/glimmervoid-keep-mergeable/';
const KEEP_MERGEABLE_WORK_BRANCH_REF = `refs/heads/${core.MY_PRS_FIX_WORK_BRANCH}`;

export function createMyPrsStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded: MyPrsStateType = { keepMergeableKeys: [], keepMergeableAttemptKeys: [], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [] };
  const store = createJsonStateStore<MyPrsStateType>({
    name: 'my-prs state', filePath: statePath,
    parse: (raw) => {
      const parsed = MyPrsState.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    adopt: (state) => { loaded = state ?? { keepMergeableKeys: [], keepMergeableAttemptKeys: [], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [], keepMergeableAttempts: [] }; },
    warn: (message, fields) => log.warn(`[${core.MY_PRS_LANE_ID}] ${message} ${JSON.stringify(fields)}`),
  });
  return {
    async readState(): Promise<MyPrsStateType> {
      await store.load();
      return loaded;
    },
    async writeState(state: MyPrsStateType): Promise<void> {
      const parsed = MyPrsState.parse(state);
      await store.write(parsed, () => `${JSON.stringify(parsed, null, 2)}\n`);
      loaded = parsed;
    },
  };
}

type KeepMergeableGitRunner = (args: string[], cwd: string, signal?: AbortSignal, env?: Record<string, string>) => Promise<CommandResult>;
type KeepMergeableSessionOutcome = 'finished' | 'timed-out' | 'stopped' | 'failed';

async function runTrustedGit(args: string[], cwd: string, signal?: AbortSignal, env: Record<string, string> = {}): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: TRUSTED_GIT_TIMEOUT_MS, signal, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } });
    return { ok: true, out: stdout.trim(), err: '' };
  } catch (error) {
    return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
  }
}

async function deleteHandoffRefs(projectPath: string, runGit: KeepMergeableGitRunner, log: Pick<Console, 'warn'>): Promise<void> {
  const listed = await runGit(['for-each-ref', '--format=%(refname)', KEEP_MERGEABLE_HANDOFF_REF_PREFIX], projectPath);
  if (!listed.ok) return log.warn(`[${core.MY_PRS_LANE_ID}] could not list leftover handoff refs in ${projectPath}: ${firstLine(listed.err)}`);
  const leftoverRefs = listed.out.split('\n').map((line) => line.trim()).filter((refName) => refName.startsWith(KEEP_MERGEABLE_HANDOFF_REF_PREFIX));
  for (const refName of leftoverRefs) {
    const deleted = await runGit(['update-ref', '-d', refName], projectPath);
    if (!deleted.ok) log.warn(`[${core.MY_PRS_LANE_ID}] could not delete leftover handoff ref ${refName} in ${projectPath}: ${firstLine(deleted.err)}`);
  }
}

export async function sweepKeepMergeableLeftovers({ workRoot, repoCache, gitWorkspace, runGit = runTrustedGit, reapProcesses, log = console }: {
  workRoot: string;
  repoCache: Pick<TeamReviewRepoCache, 'listRepos'>;
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees'>;
  runGit?: KeepMergeableGitRunner;
  reapProcesses?: (options: Required<TeamReviewReapOptions>) => Promise<void>;
  log?: Pick<Console, 'warn'>;
}): Promise<void> {
  await sweepLeftoverCheckouts({ worktreeRoot: workRoot, workRoot, keepPaths: new Set(), repoCache, gitWorkspace, reapProcesses, log });
  const cachedClones = await repoCache.listRepos().catch((error: unknown) => {
    log.warn(`[${core.MY_PRS_LANE_ID}] could not list cached clones: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  for (const projectPath of cachedClones) await deleteHandoffRefs(projectPath, runGit, log);
}

type SandboxedPr = Pick<MyPr, 'key' | 'repo' | 'number' | 'baseRefName' | 'headRefOid'>;

interface SandboxedPrStagingOptions {
  spawnSession: TeamReviewSpawn;
  repoCache: Pick<TeamReviewRepoCache, 'ensureRepo' | 'fetchPr' | 'hydrateRange'>;
  glimmervoidHome?: string;
  runGit?: KeepMergeableGitRunner;
  timeoutSeconds?: () => number;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

function keepMergeableSpawnEnv(workDir: string): Record<string, string> {
  return { ...hooksPathPinnedSpawnEnv(workDir), GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: 'commit.gpgsign', GIT_CONFIG_VALUE_3: 'false' };
}

function defaultSessionTimeoutSeconds(): number {
  return core.DEFAULT_KEEP_MERGEABLE_TIMEOUT_MINUTES * 60;
}

export function createSandboxedPrStaging({
  spawnSession, repoCache, glimmervoidHome = glimmervoidHomeDir(), runGit = runTrustedGit, timeoutSeconds = defaultSessionTimeoutSeconds, setTimeoutFn, clearTimeoutFn,
}: SandboxedPrStagingOptions) {
  async function stageCheckout(pr: SandboxedPr, workDir: string, signal: AbortSignal): Promise<{ projectPath: string; baseSha: string } | { error: string }> {
    const stopped = { error: 'stopped' };
    const projectPath = await repoCache.ensureRepo(pr.repo);
    if (signal.aborted) return stopped;
    if (!projectPath) return { error: `could not clone ${pr.repo}` };
    const fetched = await repoCache.fetchPr(pr.repo, pr.number, pr.baseRefName);
    if (signal.aborted) return stopped;
    if (!fetched.ok) return { error: `could not fetch ${pr.key} ${fetched.err}` };
    if (fetched.headSha !== pr.headRefOid) return { error: `the head moved to ${fetched.headSha} from the scheduled ${pr.headRefOid}` };
    const base = await runGit(['rev-parse', '--verify', `${prBaseRef(pr.number)}^{commit}`], projectPath, signal);
    if (signal.aborted) return stopped;
    const baseSha = CommitSha.safeParse(base.out);
    if (!base.ok || !baseSha.success) return { error: `could not read the base of ${pr.key} ${base.err}` };
    const hydrated = await repoCache.hydrateRange(pr.repo, pr.number, pr.headRefOid);
    if (signal.aborted) return stopped;
    if (!hydrated.ok) return { error: `could not fetch the pull request file contents ${hydrated.err}` };
    for (const range of [[EMPTY_TREE_SHA, pr.headRefOid], [`${pr.headRefOid}...${baseSha.data}`]]) {
      const prefetched = await runGit(['diff', '--shortstat', ...range], projectPath, signal);
      if (signal.aborted) return stopped;
      if (!prefetched.ok) return { error: `could not fetch the file contents a base merge needs ${prefetched.err}` };
    }
    const checkoutPath = path.join(workDir, core.MY_PRS_FIX_CHECKOUT_DIRNAME);
    const checkoutSteps: [string[], string][] = [
      [['clone', '--quiet', '--shared', '--no-checkout', projectPath, checkoutPath], workDir],
      [['checkout', '--quiet', '-B', core.MY_PRS_FIX_WORK_BRANCH, pr.headRefOid], checkoutPath],
      [['branch', '--force', core.MY_PRS_FIX_BASE_BRANCH, baseSha.data], checkoutPath],
    ];
    for (const [args, cwd] of checkoutSteps) {
      const staged = await runGit(args, cwd, signal);
      if (signal.aborted) return stopped;
      if (!staged.ok) return { error: `could not stage the checkout ${staged.err}` };
    }
    const excludePath = path.join(checkoutPath, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.appendFile(excludePath, core.keepMergeableExcludeLines(), 'utf8');
    return { projectPath, baseSha: baseSha.data };
  }

  function runSession({ idPrefix, name, workDir, cachedClone, signal, onPending, initialPrompt }: {
    idPrefix: string; name: string; workDir: string; cachedClone: string; signal: AbortSignal; onPending: (pending: Promise<unknown>) => void; initialPrompt: string;
  }): Promise<KeepMergeableSessionOutcome> {
    return raceWithAbort<KeepMergeableSessionOutcome>({
      timeoutMs: timeoutSeconds() * 1000, setTimeoutFn, clearTimeoutFn, onPending,
      onTimeout: () => 'timed-out',
      onEmpty: () => 'failed',
      start: (deadlineSignal) => {
        const sessionSignal = AbortSignal.any([deadlineSignal, signal]);
        return spawnSession({
          id: `${idPrefix}:${randomUUID()}`, name, cwd: workDir,
          spawnEnv: keepMergeableSpawnEnv(workDir),
          extraClaudeArgs: core.keepMergeableClaudeArgs(),
          settingsPermissions: core.keepMergeablePermissions(),
          settingsSandbox: keepMergeableSandbox(workDir, { glimmervoidHome, cachedClone }),
          signal: sessionSignal, initialPrompt,
        }).then((): KeepMergeableSessionOutcome => (sessionSignal.aborted ? 'stopped' : 'finished'));
      },
    });
  }

  return { stageCheckout, runSession };
}

const UNICODE_REPLACEMENT_CHARACTER = '\uFFFD';

function isLossyUtf8Decode(decodedText: string): boolean {
  return decodedText.includes(UNICODE_REPLACEMENT_CHARACTER);
}

function utf8CommitMessage(rawCommit: string): { ok: true; text: string } | { ok: false; err: string } {
  const headerEnd = rawCommit.indexOf('\n\n');
  const header = headerEnd === -1 ? rawCommit : rawCommit.slice(0, headerEnd);
  const declaredEncoding = header.split('\n').find((headerLine) => headerLine.startsWith('encoding '))?.slice('encoding '.length).trim();
  if (declaredEncoding !== undefined && declaredEncoding.toLowerCase() !== 'utf-8') return { ok: false, err: `has a message in the ${declaredEncoding} encoding, which re-signing would corrupt` };
  const text = headerEnd === -1 ? '' : rawCommit.slice(headerEnd + 2);
  if (isLossyUtf8Decode(text)) return { ok: false, err: 'has a message that is not valid UTF-8, which re-signing would corrupt' };
  return { ok: true, text };
}

export function createMyPrMergeabilityFix({
  spawnSession, repoCache, workRoot, glimmervoidHome = glimmervoidHomeDir(), makeWorkDir = makeTeamReviewWorkDir, runGit = runTrustedGit, log = console,
  timeoutSeconds = defaultSessionTimeoutSeconds, setTimeoutFn, clearTimeoutFn, sandboxRefusal = allowSandboxedSpawn,
}: SandboxedPrStagingOptions & {
  workRoot: string;
  sandboxRefusal?: SandboxSpawnRefusal;
  makeWorkDir?: typeof makeTeamReviewWorkDir;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  const warn = (pr: MyPr, message: string) => log.warn(`[${core.MY_PRS_LANE_ID}] keep mergeable for ${pr.key}: ${firstLine(message)}`);
  const stopped: MyPrMergeabilityFixResult = { outcome: 'stopped', reason: 'The repair was stopped' };
  function reportRepairFailure(pr: MyPr, message: string, outcome: 'failed' | 'no-change' | 'timed-out' = 'failed'): MyPrMergeabilityFixResult {
    warn(pr, message);
    return { outcome, reason: firstLine(message) };
  }
  const { stageCheckout, runSession } = createSandboxedPrStaging({ spawnSession, repoCache, glimmervoidHome, runGit, timeoutSeconds, setTimeoutFn, clearTimeoutFn });

  async function changedPaths(projectPath: string, fromSha: string, toSha: string, diffFilterArgs: string[] = []): Promise<string[] | null> {
    const changed = await runGit(['diff', '--name-only', '-z', '--no-renames', ...diffFilterArgs, fromSha, toSha], projectPath);
    return changed.ok ? nulSeparatedPaths(changed.out) : null;
  }

  async function signSessionCommits(projectPath: string, { headSha, baseSha, resultSha }: { headSha: string; baseSha: string; resultSha: string }, signal: AbortSignal): Promise<{ ok: true; sha: string } | { ok: false; err: string }> {
    const signingSetting = await runGit(['config', '--bool', 'commit.gpgsign'], projectPath, signal);
    if (!signingSetting.ok || signingSetting.out !== 'true') return { ok: true, sha: resultSha };
    const listed = await runGit(['rev-list', '--reverse', '--topo-order', '--parents', resultSha, '--not', headSha, baseSha], projectPath, signal);
    if (!listed.ok) return { ok: false, err: listed.err };
    const signedShaByOriginal = new Map<string, string>();
    for (const line of listed.out.split('\n').filter(Boolean)) {
      const [originalSha = '', ...parentShas] = line.trim().split(' ');
      const tree = await runGit(['rev-parse', '--verify', `${originalSha}^{tree}`], projectPath, signal);
      const author = await runGit(['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', originalSha], projectPath, signal);
      const rawCommit = await runGit(['cat-file', 'commit', originalSha], projectPath, signal);
      if (!tree.ok || !author.ok || !rawCommit.ok) return { ok: false, err: tree.err || author.err || rawCommit.err };
      const [authorName = '', authorEmail = '', authorDate = ''] = author.out.split('\0');
      if (isLossyUtf8Decode(authorName) || isLossyUtf8Decode(authorEmail)) return { ok: false, err: `${originalSha} has an author that is not valid UTF-8, which re-signing would corrupt` };
      const message = utf8CommitMessage(rawCommit.out);
      if (!message.ok) return { ok: false, err: `${originalSha} ${message.err}` };
      const parentArgs = parentShas.flatMap((parentSha) => ['-p', signedShaByOriginal.get(parentSha) ?? parentSha]);
      const signed = await runGit(['commit-tree', tree.out, ...parentArgs, '-S', '-m', message.text], projectPath, signal, { GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: authorDate });
      const signedSha = CommitSha.safeParse(signed.out);
      if (!signed.ok || !signedSha.success) return { ok: false, err: signed.err };
      signedShaByOriginal.set(originalSha, signedSha.data);
    }
    const signedResultSha = signedShaByOriginal.get(resultSha);
    if (!signedResultSha) return { ok: false, err: `${resultSha} was not among the session commits` };
    return { ok: true, sha: signedResultSha };
  }

  async function fetchSessionCommits(staged: { projectPath: string; baseSha: string }, checkoutPath: string, headSha: string, handoffRef: string, signal: AbortSignal): Promise<CommandResult> {
    const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-keep-mergeable-'));
    try {
      const bundlePath = path.join(bundleDir, 'session.bundle');
      const bundled = await runGit(['bundle', 'create', '--quiet', bundlePath, KEEP_MERGEABLE_WORK_BRANCH_REF, `^${headSha}`, `^${staged.baseSha}`], checkoutPath, signal);
      if (!bundled.ok || signal.aborted) return bundled;
      return await runGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundlePath, `+${KEEP_MERGEABLE_WORK_BRANCH_REF}:${handoffRef}`], staged.projectPath, signal);
    } finally {
      await fs.rm(bundleDir, { recursive: true, force: true });
    }
  }

  async function handOff(pr: MyPr, staged: { projectPath: string; baseSha: string }, checkoutPath: string, handoffRef: string, signal: AbortSignal, onPushStarted: (repairSha: string) => Promise<void>, latestListedPr: () => MyPr | undefined): Promise<MyPrMergeabilityFixResult> {
    const sessionHead = await runGit(['rev-parse', '--verify', `${KEEP_MERGEABLE_WORK_BRANCH_REF}^{commit}`], checkoutPath, signal);
    if (signal.aborted) return stopped;
    if (!sessionHead.ok) return reportRepairFailure(pr, `not pushed: could not read the session commit ${sessionHead.err}`);
    if (sessionHead.out === pr.headRefOid) return reportRepairFailure(pr, 'not pushed: the session committed nothing', 'no-change');
    const fetched = await fetchSessionCommits(staged, checkoutPath, pr.headRefOid, handoffRef, signal);
    if (signal.aborted) return stopped;
    if (!fetched.ok) return reportRepairFailure(pr, `not pushed: could not read the session commit ${fetched.err}`);
    const result = await runGit(['rev-parse', '--verify', `${handoffRef}^{commit}`], staged.projectPath);
    const resultSha = CommitSha.safeParse(result.out);
    if (signal.aborted) return stopped;
    if (!result.ok || !resultSha.success) return reportRepairFailure(pr, `not pushed: could not read the session commit ${result.err}`);
    const onTopOfHead = await runGit(['merge-base', '--is-ancestor', pr.headRefOid, resultSha.data], staged.projectPath);
    const changedFromHead = await changedPaths(staged.projectPath, pr.headRefOid, resultSha.data);
    const addedFromHead = await changedPaths(staged.projectPath, pr.headRefOid, resultSha.data, ['--diff-filter=A']);
    const changedFromBase = await changedPaths(staged.projectPath, staged.baseSha, resultSha.data);
    if (signal.aborted) return stopped;
    if (!changedFromHead || !addedFromHead || !changedFromBase) return reportRepairFailure(pr, 'not pushed: could not list the changed files');
    const decision = core.keepMergeableHandoff({ headSha: pr.headRefOid, resultSha: resultSha.data, isResultOnTopOfHead: onTopOfHead.ok, changedFromHead, addedFromHead, changedFromBase });
    if (!decision.push) return reportRepairFailure(pr, `not pushed: ${decision.reason}`, resultSha.data === pr.headRefOid ? 'no-change' : 'failed');
    if (signal.aborted) return stopped;
    const target = core.keepMergeablePushTarget(pr, latestListedPr());
    if (!target.push) return reportRepairFailure(pr, `not pushed: ${target.reason}`);
    const signed = await signSessionCommits(staged.projectPath, { headSha: pr.headRefOid, baseSha: staged.baseSha, resultSha: resultSha.data }, signal);
    if (signal.aborted) return stopped;
    if (!signed.ok) return reportRepairFailure(pr, `not pushed: could not sign the session commits ${signed.err}`);
    const repairSha = signed.sha;
    const holdFailure = await onPushStarted(repairSha).then(() => null, (error: unknown) =>
      reportRepairFailure(pr, `not pushed: the hold on repair head ${repairSha} could not be saved ${error instanceof Error ? error.message : String(error)}`));
    if (signal.aborted) return stopped;
    if (holdFailure) return holdFailure;
    const pushed = await runGit(core.keepMergeablePushArgs(target.url, target.branch, pr.headRefOid, repairSha), staged.projectPath, signal);
    if (signal.aborted) return stopped;
    if (!pushed.ok && core.isMovedBranchPushRejection(pushed.err)) return reportRepairFailure(pr, `not pushed: ${target.branch} moved since the repair was staged, so the push was rejected and is not retried`);
    if (!pushed.ok) return reportRepairFailure(pr, `pushing the repair to ${target.branch} failed: ${pushed.err}`);
    log.log(`[${core.MY_PRS_LANE_ID}] keep mergeable pushed ${repairSha} to ${target.branch} for ${pr.key}`);
    return { outcome: 'pushed' };
  }

  return async (pr: MyPr, signal: AbortSignal, onPushStarted: (repairSha: string) => Promise<void> = async () => {}, latestListedPr: () => MyPr | undefined = () => pr): Promise<MyPrMergeabilityFixResult> => {
    if (signal.aborted) return stopped;
    const target = core.keepMergeablePushTarget(pr, latestListedPr());
    if (!target.push) return reportRepairFailure(pr, `not started: ${target.reason}`);
    const sandboxRefusalReason = sandboxRefusal();
    if (sandboxRefusalReason !== null) return reportRepairFailure(pr, sandboxRefusalReason);
    const workDir = await makeWorkDir(workRoot, pr.key);
    const handoffRef = `${KEEP_MERGEABLE_HANDOFF_REF_PREFIX}${pr.number}-${randomUUID()}`;
    let projectPath: string | null = null;
    let pendingSession: Promise<unknown> | null = null;
    try {
      if (signal.aborted) return stopped;
      const staged = await stageCheckout(pr, workDir.dir, signal);
      if (signal.aborted) return stopped;
      if ('error' in staged) return reportRepairFailure(pr, `not started: ${staged.error}`);
      projectPath = staged.projectPath;
      if (signal.aborted) return stopped;
      await fs.writeFile(path.join(workDir.dir, core.MY_PRS_FIX_PROMPT_FILENAME), core.keepMergeablePrompt(pr), 'utf8');
      await fs.mkdir(emptyGhConfigDir(workDir.dir), { recursive: true });
      const outcome = await runSession({
        idPrefix: core.MY_PRS_LANE_ID, name: `Keep mergeable ${pr.key}`, workDir: workDir.dir, cachedClone: staged.projectPath, signal,
        onPending: (pending) => { pendingSession = pending; }, initialPrompt: core.MY_PRS_FIX_BOOTSTRAP_PROMPT,
      });
      await drainPending(pendingSession);
      if (signal.aborted || outcome === 'stopped') return stopped;
      if (outcome === 'timed-out') return reportRepairFailure(pr, `not pushed: the session ran past its ${timeoutSeconds()}s deadline`, 'timed-out');
      if (outcome === 'failed') return reportRepairFailure(pr, 'not pushed: the repair session failed');
      return await handOff(pr, staged, path.join(workDir.dir, core.MY_PRS_FIX_CHECKOUT_DIRNAME), handoffRef, signal, onPushStarted, latestListedPr);
    } finally {
      await drainPending(pendingSession);
      if (projectPath) await runGit(['update-ref', '-d', handoffRef], projectPath);
      await workDir.cleanup();
    }
  };
}

function firstErrorLine(text: string): string {
  const line = text.split('\n').map((candidate) => candidate.trim()).find(Boolean) ?? 'GitHub refused the merge';
  return line.slice(0, MERGE_ERROR_MAX_CHARACTERS);
}

interface MyPrsWiringOptions {
  config: TeamReviewSettingsSource;
  broadcast: (status: MyPrsStatusType) => void;
  log?: Pick<Console, 'warn'>;
  github?: MyPrsPollerDependencies['github'] & Pick<PrGh, 'mergePr'>;
  createPoller?: (dependencies: MyPrsPollerDependencies) => MyPrsPoller;
  clock?: SharedClock;
  homeDir?: string;
  fixMergeability?: MyPrsPollerDependencies['fixMergeability'];
  sweepLeftovers?: MyPrsPollerDependencies['beforeStart'];
}

export function createMyPrsWiring({ config, broadcast, log = console, homeDir = glimmervoidHomeDir(), github = createPrGh(homeDir), createPoller = createMyPrsPoller, clock, fixMergeability, sweepLeftovers }: MyPrsWiringOptions) {
  const stateIo = createMyPrsStateIo(path.join(homeDir, core.MY_PRS_STATE_FILENAME), log);
  const settings = () => readTeamReviewSettings(config);
  const features = () => core.readMyPrsFeatureSettings(config);
  const gate = () => core.myPrsShouldStart(settings());
  const emptyStatus = () => {
    const verdict = gate();
    return core.myPrsStatus({ ts: Date.now(), configured: verdict.start, reason: verdict.reason ?? null });
  };
  const runner = createLaneRunner<MyPrsPoller>({
    tag: core.MY_PRS_LANE_ID,
    gate,
    cfgKey: () => JSON.stringify({
      enabled: settings().enabled, org: settings().org, autoRebaseMyPrs: settings().autoRebaseMyPrs,
      isKeepMergeableEnabled: features().isKeepMergeableEnabled, isMergeQueueEnabled: features().isMergeQueueEnabled,
    }),
    emptyStatus,
    broadcast: (status) => {
      const parsed = MyPrsStatus.safeParse(status);
      if (parsed.success) broadcast(parsed.data);
    },
    createPoller: ({ onTickComplete }) => createPoller({
      org: settings().org, shouldAutoRebase: settings().autoRebaseMyPrs,
      isKeepMergeableEnabled: features().isKeepMergeableEnabled, isMergeQueueEnabled: features().isMergeQueueEnabled, github, log, onTickComplete, clock, firstTickDelayMs: bootStaggerDelay,
      readState: stateIo.readState, writeState: stateIo.writeState, fixMergeability, beforeStart: sweepLeftovers,
      mergePr: (queuedPr) => mergeTrackedPr(queuedPr.key, queuedPr, queuedPr.headRefOid),
    }),
  });
  function getStatus(): MyPrsStatusType {
    const parsed = MyPrsStatus.safeParse(runner.getStatus());
    return parsed.success ? parsed.data : emptyStatus();
  }
  async function refresh() {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'Reviews polling is not running.' };
    return poller.refresh();
  }

  async function setKeepMergeable(request: MyPrKeepMergeableRequest): Promise<Omit<MyPrKeepMergeableResult, 'key'>> {
    const parsed = MyPrKeepMergeableRequest.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'Invalid keep mergeable request' };
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'My pull requests is not running' };
    return poller.setKeepMergeable(parsed.data);
  }

  async function setMergeWhenReady(request: MyPrMergeWhenReadyRequest): Promise<Omit<MyPrMergeWhenReadyResult, 'key'>> {
    const parsed = MyPrMergeWhenReadyRequest.safeParse(request);
    if (!parsed.success) return { ok: false, error: 'Invalid merge when ready request' };
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'My pull requests is not running' };
    return poller.setMergeWhenReady(parsed.data);
  }

  const mergesInFlight = new Set<string>();
  async function mergeTrackedPr(key: string, tracked: MyPr | undefined, seenHeadRefOid: string): Promise<MyPrMergeOutcome> {
    if (mergesInFlight.has(key)) return { ok: false, error: 'A merge for this pull request is already running' };
    const refusal = myPrMergeRefusal(tracked, seenHeadRefOid);
    if (refusal || !tracked) return { ok: false, error: refusal ?? 'That pull request is not one of your tracked pull requests' };
    mergesInFlight.add(key);
    try {
      const merged = await github.mergePr({ repo: tracked.repo, number: tracked.number, headSha: tracked.headRefOid, method: tracked.mergeMethod });
      if (!merged.ok) return { ok: false, error: firstErrorLine(merged.err) };
      return { ok: true, kind: merged.kind };
    } finally {
      mergesInFlight.delete(key);
    }
  }

  async function mergePr(request: MyPrMergeRequest): Promise<MyPrMergeOutcome> {
    const key = prKey(request.repo, request.number);
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'My pull requests is not running' };
    const merged = await mergeTrackedPr(key, getStatus().prs.find((pr) => pr.key === key), request.headRefOid);
    if (!merged.ok) {
      log.warn(`[${core.MY_PRS_LANE_ID}] merge of ${key} failed: ${merged.error}`);
      return merged;
    }
    poller.tick().catch((error: unknown) => log.warn(`[${core.MY_PRS_LANE_ID}] refresh after merging ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
    return merged;
  }
  return { startPoller: runner.startPoller, stopPoller: runner.stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged, getStatus, mergePr, refresh, setKeepMergeable, setMergeWhenReady };
}

export type { MyPrMergeOutcome };
