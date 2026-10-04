import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MyPrKeepMergeableRequest, MyPrsState, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrsState as MyPrsStateType, MyPrsStatus as MyPrsStatusType } from '../shared/contracts/my-prs.ts';
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
import { emptyGhConfigDir, keepMergeableSandbox, keepMergeableSpawnEnv, makeTeamReviewWorkDir, sweepLeftoverCheckouts } from './team-review-wiring.ts';
import type { TeamReviewGitWorkspace, TeamReviewRepoCache, TeamReviewSpawn } from './team-review-wiring.ts';
import type { TeamReviewReapOptions } from './team-review-reaper.ts';
import { CommitSha } from '../shared/contracts/team-review.ts';

type MyPrsPoller = ReturnType<typeof createMyPrsPoller>;
type MyPrsPollerDependencies = Parameters<typeof createMyPrsPoller>[0];
type MyPrMergeOutcome = Omit<MyPrMergeResult, 'key'>;

const MERGE_ERROR_MAX_CHARACTERS = 300;
const TRUSTED_GIT_TIMEOUT_MS = 10 * 60 * 1000;
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const KEEP_MERGEABLE_HANDOFF_REF_PREFIX = 'refs/glimmervoid-keep-mergeable/';

export function createMyPrsStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded: MyPrsStateType = { keepMergeableKeys: [], keepMergeableAttemptKeys: [] };
  const store = createJsonStateStore<MyPrsStateType>({
    name: 'my-prs state', filePath: statePath,
    parse: (raw) => {
      const parsed = MyPrsState.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    adopt: (state) => { loaded = state ?? { keepMergeableKeys: [], keepMergeableAttemptKeys: [] }; },
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

type KeepMergeableGitRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;
type KeepMergeableSessionOutcome = 'finished' | 'timed-out' | 'stopped' | 'failed';

async function runTrustedGit(args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: TRUSTED_GIT_TIMEOUT_MS, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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

export function createMyPrMergeabilityFix({
  spawnSession, repoCache, workRoot, glimmervoidHome = glimmervoidHomeDir(), makeWorkDir = makeTeamReviewWorkDir, runGit = runTrustedGit, log = console,
  timeoutSeconds = core.MY_PRS_FIX_TIMEOUT_SECONDS, setTimeoutFn, clearTimeoutFn,
}: {
  spawnSession: TeamReviewSpawn;
  repoCache: Pick<TeamReviewRepoCache, 'ensureRepo' | 'fetchPr' | 'hydrateRange'>;
  workRoot: string;
  glimmervoidHome?: string;
  makeWorkDir?: typeof makeTeamReviewWorkDir;
  runGit?: KeepMergeableGitRunner;
  log?: Pick<Console, 'log' | 'warn'>;
  timeoutSeconds?: number;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}) {
  const warn = (pr: MyPr, message: string) => log.warn(`[${core.MY_PRS_LANE_ID}] keep mergeable for ${pr.key}: ${firstLine(message)}`);

  async function stageCheckout(pr: MyPr, workDir: string, signal: AbortSignal): Promise<{ projectPath: string; baseSha: string } | { error: string }> {
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

  async function changedPaths(projectPath: string, fromSha: string, toSha: string, diffFilterArgs: string[] = []): Promise<string[] | null> {
    const changed = await runGit(['diff', '--name-only', '-z', '--no-renames', ...diffFilterArgs, fromSha, toSha], projectPath);
    return changed.ok ? nulSeparatedPaths(changed.out) : null;
  }

  async function handOff(pr: MyPr, staged: { projectPath: string; baseSha: string }, checkoutPath: string, handoffRef: string, signal: AbortSignal, onPushStarted: () => void): Promise<void> {
    const pushUrl = core.keepMergeablePushUrl(pr.repo);
    if (!pushUrl) return warn(pr, `not pushed: ${pr.repo} is not a GitHub repository name`);
    const fetched = await runGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', checkoutPath, `+HEAD:${handoffRef}`], staged.projectPath, signal);
    if (signal.aborted) return;
    if (!fetched.ok) return warn(pr, `not pushed: could not read the session commit ${fetched.err}`);
    const result = await runGit(['rev-parse', '--verify', `${handoffRef}^{commit}`], staged.projectPath);
    const resultSha = CommitSha.safeParse(result.out);
    if (!result.ok || !resultSha.success) return warn(pr, `not pushed: could not read the session commit ${result.err}`);
    const onTopOfHead = await runGit(['merge-base', '--is-ancestor', pr.headRefOid, resultSha.data], staged.projectPath);
    const changedFromHead = await changedPaths(staged.projectPath, pr.headRefOid, resultSha.data);
    const addedFromHead = await changedPaths(staged.projectPath, pr.headRefOid, resultSha.data, ['--diff-filter=A']);
    const changedFromBase = await changedPaths(staged.projectPath, staged.baseSha, resultSha.data);
    if (!changedFromHead || !addedFromHead || !changedFromBase) return warn(pr, 'not pushed: could not list the changed files');
    const decision = core.keepMergeableHandoff({ headSha: pr.headRefOid, resultSha: resultSha.data, isResultOnTopOfHead: onTopOfHead.ok, changedFromHead, addedFromHead, changedFromBase });
    if (!decision.push) return warn(pr, `not pushed: ${decision.reason}`);
    if (signal.aborted) return;
    const branch = core.keepMergeableBranchName(pr);
    onPushStarted();
    const pushed = await runGit(['push', '--no-verify', '--quiet', pushUrl, `${resultSha.data}:refs/heads/${branch}`], staged.projectPath, signal);
    if (signal.aborted) return;
    if (!pushed.ok) return warn(pr, `pushing review branch ${branch} failed: ${pushed.err}`);
    log.log(`[${core.MY_PRS_LANE_ID}] keep mergeable pushed review branch ${branch} for ${pr.key} at ${resultSha.data}`);
  }

  function runSession(pr: MyPr, workDir: string, cachedClone: string, signal: AbortSignal, onPending: (pending: Promise<unknown>) => void): Promise<KeepMergeableSessionOutcome> {
    return raceWithAbort<KeepMergeableSessionOutcome>({
      timeoutMs: timeoutSeconds * 1000, setTimeoutFn, clearTimeoutFn, onPending,
      onTimeout: () => 'timed-out',
      onEmpty: () => 'failed',
      start: (deadlineSignal) => {
        const sessionSignal = AbortSignal.any([deadlineSignal, signal]);
        return spawnSession({
          id: `${core.MY_PRS_LANE_ID}:${randomUUID()}`, name: `Keep mergeable ${pr.key}`, cwd: workDir,
          spawnEnv: keepMergeableSpawnEnv(workDir),
          extraClaudeArgs: core.keepMergeableClaudeArgs(),
          settingsPermissions: core.keepMergeablePermissions(),
          settingsSandbox: keepMergeableSandbox(workDir, { glimmervoidHome, cachedClone }),
          signal: sessionSignal, initialPrompt: core.MY_PRS_FIX_BOOTSTRAP_PROMPT,
        }).then((): KeepMergeableSessionOutcome => (sessionSignal.aborted ? 'stopped' : 'finished'));
      },
    });
  }

  return async (pr: MyPr, signal: AbortSignal, onPushStarted: () => void = () => {}): Promise<void> => {
    if (signal.aborted) return;
    const workDir = await makeWorkDir(workRoot, pr.key);
    const handoffRef = `${KEEP_MERGEABLE_HANDOFF_REF_PREFIX}${pr.number}-${randomUUID()}`;
    let projectPath: string | null = null;
    let pendingSession: Promise<unknown> | null = null;
    try {
      if (signal.aborted) return;
      const staged = await stageCheckout(pr, workDir.dir, signal);
      if (signal.aborted) return;
      if ('error' in staged) return warn(pr, `not started: ${staged.error}`);
      projectPath = staged.projectPath;
      if (signal.aborted) return;
      await fs.writeFile(path.join(workDir.dir, core.MY_PRS_FIX_PROMPT_FILENAME), core.keepMergeablePrompt(pr), 'utf8');
      await fs.mkdir(emptyGhConfigDir(workDir.dir), { recursive: true });
      const outcome = await runSession(pr, workDir.dir, staged.projectPath, signal, (pending) => { pendingSession = pending; });
      await drainPending(pendingSession);
      if (outcome === 'timed-out') return warn(pr, `not pushed: the session ran past its ${timeoutSeconds}s deadline`);
      if (outcome !== 'finished' || signal.aborted) return;
      await handOff(pr, staged, path.join(workDir.dir, core.MY_PRS_FIX_CHECKOUT_DIRNAME), handoffRef, signal, onPushStarted);
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
  const gate = () => core.myPrsShouldStart(settings());
  const emptyStatus = () => {
    const verdict = gate();
    return core.myPrsStatus({ ts: Date.now(), configured: verdict.start, reason: verdict.reason ?? null });
  };
  const runner = createLaneRunner<MyPrsPoller>({
    tag: core.MY_PRS_LANE_ID,
    gate,
    cfgKey: () => JSON.stringify({ enabled: settings().enabled, org: settings().org, autoRebaseMyPrs: settings().autoRebaseMyPrs }),
    emptyStatus,
    broadcast: (status) => {
      const parsed = MyPrsStatus.safeParse(status);
      if (parsed.success) broadcast(parsed.data);
    },
    createPoller: ({ onTickComplete }) => createPoller({
      org: settings().org, shouldAutoRebase: settings().autoRebaseMyPrs, github, log, onTickComplete, clock, firstTickDelayMs: bootStaggerDelay,
      readState: stateIo.readState, writeState: stateIo.writeState, fixMergeability, beforeStart: sweepLeftovers,
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

  const mergesInFlight = new Set<string>();
  async function mergePr(request: MyPrMergeRequest): Promise<MyPrMergeOutcome> {
    const key = prKey(request.repo, request.number);
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'My pull requests is not running' };
    if (mergesInFlight.has(key)) return { ok: false, error: 'A merge for this pull request is already running' };
    const tracked = getStatus().prs.find((pr) => pr.key === key);
    const refusal = myPrMergeRefusal(tracked, request.headRefOid);
    if (refusal || !tracked) return { ok: false, error: refusal ?? 'That pull request is not one of your tracked pull requests' };
    mergesInFlight.add(key);
    try {
      const merged = await github.mergePr({ repo: tracked.repo, number: tracked.number, headSha: tracked.headRefOid, method: tracked.mergeMethod });
      if (!merged.ok) {
        log.warn(`[${core.MY_PRS_LANE_ID}] merge of ${key} failed: ${firstErrorLine(merged.err)}`);
        return { ok: false, error: firstErrorLine(merged.err) };
      }
      poller.tick().catch((error: unknown) => log.warn(`[${core.MY_PRS_LANE_ID}] refresh after merging ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
      return { ok: true, kind: merged.kind };
    } finally {
      mergesInFlight.delete(key);
    }
  }
  return { startPoller: runner.startPoller, stopPoller: runner.stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged, getStatus, mergePr, refresh, setKeepMergeable };
}

export type { MyPrMergeOutcome };
