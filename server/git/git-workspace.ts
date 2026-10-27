import { COHERENCE_BOOKKEEPING_PATHSPEC, COHERENCE_JOURNAL_DIRECTORY, isCoherenceJournalPath } from '../coherence/core/coherence-paths-core.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GIT_CONFIG_LISTING_ARGS, buildHardenedGitInvocation } from './core/git-invocation-core.ts';
import type { GitIsolationOptions } from './core/git-invocation-core.ts';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, execFileSync } from '../child-process-safe.ts';
import { createSerialQueue, isQueueAdmissionTimeout } from '../spawn-gate.ts';
import { matchedPrefix, sessionIdFromBranch, usablePrefixes } from '../core/branch-gc-core.ts';
import { comparableDirectoryPath, isSameDirectoryPath } from '../../shared/canonical-paths.ts';
import { sanitizeWorktreeName } from '../../shared/paths.ts';
import type { RemoteBranchTip } from '../core/branch-gc-core.ts';
import {
  GIT_FETCH_TIMEOUT_MS,
  parseLeftRightCount,
  decideBranchSyncState,
  decideResyncAction,
  buildResyncCommand,
  firstGitErrorLine,
} from '../core/branch-sync-core.ts';
import { decideIntegrationSync, classifyRefusedIntegrationSync } from '../core/integration-sync-core.ts';
import { DEFAULT_BRANCH_FALLBACKS, decideMarkerBase, defaultBranchFromRemoteHead, markerProbeCommands, originTrackingRefProbe, unlandedCommitCountArgs } from '../core/integration-branch-core.ts';
import type { MarkerProbes } from '../core/integration-branch-core.ts';
import { MERGE_DRIVER_KEY_PATTERN, driverEnumerationEnv, mergeProbeEnv, neutralGitConfigEnv } from '../core/merge-proof-core.ts';
import type { MergeProbeEnvResult, MergeTreeOutcome } from '../core/merge-proof-core.ts';
import type { CheckoutTreeState, IntegrationSyncOutcome } from '../core/integration-sync-core.ts';
import { GUARDRAILS_PLACEHOLDER_NAMES } from '../guardrails/core/guardrails-policy-core.ts';
import { normalizeSha } from '../core/update-core.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { runGit } from './git-exec.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import type { OwnedPathOwner } from '../../shared/contracts/owned-paths.ts';
import type { OwnedPathsLedgerHandle } from '../owned-paths-ledger.ts';
import type { RemovalCause, RemovalKind, RemovalRecord } from '../../shared/contracts/removal-record.ts';
import { decideRemovalKeep, isRecencyProbeNeeded, sessionIdFromOwner } from '../core/removal-guard-core.ts';
import type { RemovalOwnershipFacts } from '../core/removal-guard-core.ts';
import { appendRemovalRecord, appendRemovalRecordSync, removalsJournalPath } from '../removal-journal.ts';
import { GLIMMERVOID_WORKTREE_LOCK_REASON, isOwnWorktreeLockLine, isWorktreeHiddenFromGuardedSessions, listHomeWorktreePathsMissingLock, listOwnLockedWorktreePaths } from './core/worktree-lock-core.ts';

const fsp = fs.promises;

type GitResult = { ok: boolean; out: string; err?: string };
type IntegrationSyncResult = {
  outcome: IntegrationSyncOutcome;
  from: string | null;
  to: string | null;
  error?: string;
};
type GitExtraOptions = { timeout?: number; maxBuffer?: number; env?: Record<string, string>; replaceEnv?: Record<string, string>; disableRepoCommands?: boolean };
type GitRunner = (args: string[], cwd: string, extra?: GitExtraOptions) => Promise<string> | string;
type WorktreeBranch = { cwd: string; branch: string; locked: boolean; prunable: boolean; headSha: string | null };
type WorkspaceHandle = {
  cwd: string;
  isGit: boolean;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
  reason?: string;
  conflictPath?: string;
  error?: string;
  warning?: string | null;
};
type WorktreeArgs = {
  projectPath: string;
  admissionTimeoutMs?: number;
  workspace?: WorkspaceHandle | null;
  targetBranch?: string | null;
  integrationBranch?: string | null;
  configuredIntegrationBranch?: string | null;
  cwd?: string | null;
  branch?: string | null;
  timeoutMs?: number;
  wtDir?: string;
  shareList?: string[] | null;
  keepTrackableLinks?: boolean;
  disableRepoCommands?: boolean;
  disableHooks?: boolean;
  replaceEnv?: Record<string, string>;
  teamId?: string;
  label?: string;
  baseBranch?: string | null;
  forkFromHead?: boolean;
  worktreeBase?: string | null;
  name?: string;
  ancestorSha?: string;
  descendantSha?: string;
  sha?: string;
  tipSha?: string;
  integrationSha?: string;
  branchSha?: string;
  prefixes?: string[];
  knownProjects?: unknown;
};

type MergeOutcome = {
  merged: boolean;
  committed: boolean;
  branch: string | null;
  base?: string | null;
  reason: string | null;
  parked?: boolean;
  kept?: boolean;
  baseSha?: string | null;
  conflicts?: string[];
  restoreConflict?: boolean;
  rerereReplayed?: boolean;
  pushed?: boolean;
  warning?: string;
};
type RebaseOutcome = {
  ok: boolean;
  upToDate?: boolean;
  rebased?: boolean;
  headSha?: string | null;
  baseSha?: string | null;
  rerereReplayed?: boolean;
  reason?: string;
  conflicts?: string[];
};
type SessionWorktree = {
  cwd: string;
  branch: string;
  id: string;
  hasWork: boolean;
  integrationBranch: string | null;
};
type ListedWorktree = {
  cwd: string;
  branch: string;
  locked: boolean;
  prunable: boolean;
  dirty: boolean | null;
  tipSha: string;
  integrationBranch: string | null;
};
type WorktreeProbe = { dirty: GitResult; ahead: GitResult | null; integrationBranch: string | null };
type IntegrationTip = { branch: string; sha: string | null };
type BaseClassification = { state: string; upstream: string };
type BaseSyncResult = BaseClassification & { fetched: boolean | null; error?: string };
type MergeTreeProbe = GitResult & { outcome: MergeTreeOutcome };
type MergeFastForwardOutcome = 'invalid-target-sha' | 'merged' | 'head-mismatch' | 'head-unreadable' | 'merge-failed' | 'queue-admission-timed-out';
type MergeFastForwardResult = GitResult & {
  sampledHead: string | null;
  outcome: MergeFastForwardOutcome;
};
type QueuedGitResult = GitResult & { admissionRefused?: boolean; removalKept?: string };
type WorktreeDirtyProbe = { ok: boolean; dirty: boolean; headSha: string | null; err?: string; admissionRefused?: boolean };
type MergeProbeEnvArgs = { projectPath: string; timeoutMs?: number };
type CheckoutDetachedArgs = { worktreePath: string; sha: string } & GitIsolationOptions;
type StageDetachedWorktreeArgs = { projectPath: string; worktreePath?: string; sha?: string; owner: OwnedPathOwner } & GitIsolationOptions;
type OwnedWorktreeArgs = WorktreeArgs & { owner: OwnedPathOwner };
type WorktreeOwnership = { owner: OwnedPathOwner; projectPath: string; branch: string | null };
type OwnedPathsRecorder = Pick<OwnedPathsLedgerHandle, 'record' | 'forget' | 'ownerOf'>;
type RemovalGuardOptions = { protectedSessionIds?: () => ReadonlySet<string>; journalPath?: string; now?: () => number };
type RemovalArgs = WorktreeArgs & { cause: RemovalCause };
type RemovalTarget = { cause: RemovalCause; kind: RemovalKind; projectPath: string; path: string | null; branch: string | null; tipSha?: string | null };
type RemovalAdmission = { admitted: true } | { admitted: false; reason: string };
type StageIsolatedCheckoutArgs = { projectPath: string; checkoutPath?: string; sha?: string; baseSha?: string };
type MergeFastForwardArgs = {
  projectPath: string;
  expectedHead?: string;
  sha?: string;
  timeoutMs?: number;
  admissionTimeoutMs?: number;
};
type ResetKeepArgs = { projectPath: string; expectedHead?: string; sha?: string; timeoutMs?: number; admissionTimeoutMs?: number };
type MergeTreeArgs = {
  projectPath: string;
  integrationSha: string;
  branchSha: string;
  probeEnv: Record<string, string>;
  timeoutMs?: number;
};

const MERGE_PROBE_TIMEOUT_MS = 30000;
const REMOTE_REF_PREFIX = 'refs/remotes/origin/';
const REMOTE_BRANCH_LISTING_MAX_BUFFER = 64 * 1024 * 1024;
const ISOLATED_CHECKOUT_HYDRATE_TIMEOUT_MS = 10 * 60 * 1000;
const ISOLATED_CHECKOUT_REVIEW_REF = 'refs/heads/review';
const ISOLATED_CHECKOUT_BASE_REF = 'refs/benchmark/base';

async function prepareHardenedGitInvocation(args: string[], baseEnv: Readonly<Record<string, string | undefined>>,
  probe: (args: string[], env: Record<string, string>) => Promise<string> | string) {
  const invocationOptions = { baseEnv, transportSourceEnv: process.env, platform: process.platform, devNullPath: os.devNull };
  const enumeration = buildHardenedGitInvocation([...GIT_CONFIG_LISTING_ARGS], invocationOptions);
  const configListing = await probe(enumeration.args, enumeration.env);
  return buildHardenedGitInvocation(args, { ...invocationOptions, configListing });
}

type HardenedGitOptions = { cwd: string; timeout?: number; maxBuffer?: number; encoding?: 'utf8'; env?: Record<string, string | undefined>; indexFile?: string };

async function prepareHardenedGitCommand(args: string[], options: HardenedGitOptions) {
  const { indexFile, ...processOptions } = options;
  const invocation = await prepareHardenedGitInvocation(args, options.env ?? process.env,
    async (probeArgs, probeEnv) => (await execFileAsync('git', probeArgs, { ...processOptions, env: probeEnv, encoding: 'utf8' })).stdout);
  if (indexFile) invocation.env.GIT_INDEX_FILE = indexFile;
  return invocation;
}

export async function runHardenedGit(args: string[], options: HardenedGitOptions & { input?: string }) {
  const { input, indexFile, ...processOptions } = options;
  const invocation = await prepareHardenedGitCommand(args, { ...processOptions, indexFile });
  return execFileAsync('git', invocation.args, { ...processOptions, input, env: invocation.env, encoding: 'utf8' });
}

function errorExitCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function okResult(out: unknown): GitResult {
  return { ok: true, out: String(out || '').trim() };
}
function errResult(err: unknown): GitResult {
  const failure = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown; killed?: unknown; signal?: unknown };
  const detail = String(failure.stderr || failure.message || '');
  const wasKilledByTimeout = failure.killed === true && Boolean(failure.signal);
  return {
    ok: false,
    out: String(failure.stdout || '').trim(),
    err: wasKilledByTimeout ? `timed out (killed): ${detail}` : detail,
  };
}

function comparableGlimmervoidHomes(glimmervoidHome: string): string[] {
  try {
    return [glimmervoidHome, fs.realpathSync(glimmervoidHome)];
  } catch {
    return [glimmervoidHome];
  }
}

async function directoryExists(candidatePath: string): Promise<boolean> {
  try {
    await fsp.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function parseWorktreeBranches(porcelain: string): WorktreeBranch[] {
  const result: WorktreeBranch[] = [];
  let current: { cwd: string; branch: string | null; locked: boolean; prunable: boolean; headSha: string | null } | null = null;
  const flush = () => {
    if (current?.branch) result.push({ cwd: current.cwd, branch: current.branch, locked: current.locked, prunable: current.prunable, headSha: current.headSha });
    current = null;
  };
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { cwd: line.slice('worktree '.length).trim(), branch: null, locked: false, prunable: false, headSha: null };
      continue;
    }
    if (line === '') { flush(); continue; }
    if (!current) continue;
    if (line.startsWith('HEAD ')) { current.headSha = line.slice('HEAD '.length).trim() || null; continue; }
    if (line.startsWith('branch ')) { current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''); continue; }
    if (line.startsWith('prunable')) { current.prunable = true; continue; }
    if (line.startsWith('locked') && !isOwnWorktreeLockLine(line)) current.locked = true;
  }
  flush();
  return result;
}

function mainWorktreePath(porcelain: string): string | null {
  const firstEntry = porcelain.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  if (!firstEntry) return null;
  return firstEntry.slice('worktree '.length).trim() || null;
}

function sessionWorktreeLocation(projectPath: string, teamId: string | undefined, worktreeBase: string | null | undefined): { parent: string; prefix: string } {
  if (worktreeBase) return { parent: worktreeBase, prefix: `${sanitizeWorktreeName(path.basename(projectPath)) || 'repo'}-` };
  return { parent: os.tmpdir(), prefix: `glimmervoid-wt-${sanitizeWorktreeName(teamId)}-` };
}

async function foreignSessionWorktreeReason(worktreePath: string, porcelain: string, location: { parent: string; prefix: string }): Promise<string | null> {
  const mainWorktree = mainWorktreePath(porcelain);
  if (mainWorktree !== null && await comparableDirectoryPath(worktreePath) === await comparableDirectoryPath(mainWorktree)) {
    return `refusing to discard ${worktreePath}: it is the main checkout`;
  }
  const isUnderWorktreeParent = await comparableDirectoryPath(path.dirname(worktreePath)) === await comparableDirectoryPath(location.parent);
  if (isUnderWorktreeParent && path.basename(worktreePath).startsWith(location.prefix)) return null;
  return `refusing to discard ${worktreePath}: glimmervoid did not create this worktree under ${path.join(location.parent, location.prefix)}*`;
}

function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  const hit = parseWorktreeBranches(porcelain).find((w) => w.branch === branch);
  return hit ? hit.cwd : null;
}

const UNTRACKED_STATUS_PREFIX = '?? ';
const WORKTREE_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'];
const WORK_PRESENCE_STATUS_ARGS = [...WORKTREE_STATUS_ARGS, ...COHERENCE_BOOKKEEPING_PATHSPEC];

const isDirtyResult = (dirty: GitResult) => dirty.ok && dirty.out !== '';
function hasWorkFrom(dirty: GitResult, ahead: GitResult | null): boolean {
  if (!dirty.ok) return true;
  if (isDirtyResult(dirty)) return true;
  if (!ahead || !ahead.ok) return true;
  return !!(ahead.out && ahead.out !== '0');
}

const markerFrom = (result: GitResult) => (result.ok && result.out ? result.out : null);
const markerKey = (branch: string) => `branch.${branch}.glimmervoid-integration`;

const UNPROBED_MARKER: MarkerProbes = { detectedDefaultBranch: null, resolvedMarkerRef: null, isMarkerRefResolvable: null, isMarkerAbsorbedByDefault: null };

type ResolvedMarkerBase = { base: string | null; measureRef: string | null };

function createGitWorkspace(opts: {
  git?: GitRunner;
  mkdtemp?: (prefix: string) => string;
  rerere?: boolean;
  log?: Pick<Console, 'warn'>;
  isolation?: GitIsolationOptions;
  glimmervoidHome?: string;
  ownedPaths?: OwnedPathsRecorder;
  removalGuard?: RemovalGuardOptions;
} = {}) {

  const rawGit: GitRunner = opts.git || (async (args, cwd, extra) => {
    const result = await runGit(args, {
      cwd, timeoutMs: extra?.timeout || 20000, trim: false,
      ...(extra?.maxBuffer ? { maxBuffer: extra.maxBuffer } : {}),
      ...(extra?.replaceEnv ? { replaceEnv: extra.replaceEnv } : {}),
      ...(extra?.env ? { env: extra.env } : {}),
    });
    if (!result.ok) throw result.error;
    return result.out;
  });
  const isolationContext = new AsyncLocalStorage<GitIsolationOptions>();
  const git: GitRunner = async (args, cwd, extra) => {
    const isolation = isolationContext.getStore() ?? opts.isolation;
    if (!(extra?.disableRepoCommands ?? isolation?.disableRepoCommands)) return rawGit(args, cwd, extra);
    const invocation = await prepareHardenedGitInvocation(args, extra?.replaceEnv ?? isolation?.replaceEnv ?? process.env,
      (probeArgs, probeEnv) => rawGit(probeArgs, cwd, { ...extra, replaceEnv: probeEnv }));
    return rawGit(invocation.args, cwd, { ...extra, replaceEnv: { ...invocation.env, ...extra?.env } });
  };
  const mkdtemp = opts.mkdtemp || ((prefix: string) => fs.mkdtempSync(prefix));
  const log = opts.log || console;

  const rerereEnabled = opts.rerere !== false;
  const glimmervoidHome = opts.glimmervoidHome ?? glimmervoidHomeDir();
  const glimmervoidHomes = comparableGlimmervoidHomes(glimmervoidHome);
  const removalGuard = resolveRemovalGuard(opts.removalGuard, glimmervoidHome);

  const engineQueue = createSerialQueue();
  const isolatedCall = <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>, args: TArgs) => (): Promise<TResult> =>
    isolationContext.run({ ...opts.isolation, ...isolationContext.getStore(), ...args }, () => body(args));
  const serialized = <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>) => (args: TArgs): Promise<TResult> => engineQueue.run(isolatedCall(body, args));
  const admitted = <TArgs extends { admissionTimeoutMs?: number }, TResult>(
    body: (args: TArgs) => Promise<TResult>,
    refuse: (args: TArgs) => TResult,
  ) => async (args: TArgs): Promise<TResult> => {
    const admission = args.admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs: args.admissionTimeoutMs };
    try {
      return await engineQueue.run(isolatedCall(body, args), admission);
    } catch (error) {
      if (!isQueueAdmissionTimeout(error)) throw error;
      return refuse(args);
    }
  };

  async function run(args: string[], cwd: string, extra?: GitExtraOptions): Promise<GitResult> {
    try { return okResult(await git(args, cwd, extra)); }
    catch (err) { return errResult(err); }
  }

  type ProjectGitRunner = (args: string[]) => Promise<GitResult>;
  const runInProject = (projectPath: string): ProjectGitRunner => (args) => run(args, projectPath);

  async function addWorktreeEntry(runGitInProject: ProjectGitRunner, worktreePath: string, addArgs: string[], ownership: WorktreeOwnership): Promise<GitResult> {
    const added = await runGitInProject(['worktree', 'add', ...addArgs]);
    if (!added.ok) return added;
    await opts.ownedPaths?.record({ path: worktreePath, kind: 'git-worktree', ...ownership });
    if (!isWorktreeHiddenFromGuardedSessions(worktreePath, glimmervoidHomes)) return added;
    await lockWorktreeEntry(runGitInProject, worktreePath);
    return added;
  }

  async function lockWorktreeEntry(runGitInProject: ProjectGitRunner, worktreePath: string): Promise<void> {
    const locked = await runGitInProject(['worktree', 'lock', '--reason', GLIMMERVOID_WORKTREE_LOCK_REASON, worktreePath]);
    if (!locked.ok) log.warn(`[git-workspace] could not lock ${worktreePath}, so a guarded session's git worktree prune can drop it: ${locked.err}`);
  }

  async function lockReusedHomeWorktrees(runGitInProject: ProjectGitRunner, porcelain: string): Promise<void> {
    for (const unlockedPath of listHomeWorktreePathsMissingLock(porcelain, glimmervoidHomes)) {
      if (!(await directoryExists(unlockedPath))) continue;
      await lockWorktreeEntry(runGitInProject, unlockedPath);
    }
  }

  async function removeWorktreeEntry(runGitInProject: ProjectGitRunner, worktreePath: string, removeFlags: string[]): Promise<GitResult> {
    if (isWorktreeHiddenFromGuardedSessions(worktreePath, glimmervoidHomes)) await runGitInProject(['worktree', 'unlock', worktreePath]);
    const removed = await runGitInProject(['worktree', 'remove', ...removeFlags, worktreePath]);
    await forgetRemovedPath(worktreePath);
    return removed;
  }

  async function forgetRemovedPath(ownedPath: string): Promise<void> {
    if (await directoryExists(ownedPath)) return;
    await opts.ownedPaths?.forget(ownedPath);
  }

  async function admitRemoval(target: RemovalTarget): Promise<RemovalAdmission> {
    const ledgerOwner = target.path === null ? null : await opts.ownedPaths?.ownerOf(target.path) ?? null;
    const facts = removalOwnershipFacts(target, ledgerOwner, removalGuard.protectedSessionIds());
    const lastTouchedMs = isRecencyProbeNeeded(facts) ? await probeLastTouchedMs(target) : null;
    const verdict = decideRemovalKeep({ ...facts, lastTouchedMs, nowMs: removalGuard.now() });
    if (verdict.keep) {
      log.warn(`[removals] kept ${describeRemovalTarget(target)} from a ${target.cause} removal because of ${verdict.reason}`);
      return { admitted: false, reason: verdict.reason };
    }
    const record = buildRemovalRecord(target, facts, verdict.checksPassed, removalGuard.now());
    if (!(await appendRemovalRecord(removalGuard.journalPath, record, log))) return { admitted: false, reason: 'removal-record-unwritten' };
    return { admitted: true };
  }

  async function probeLastTouchedMs({ projectPath, path: targetPath, branch, tipSha }: RemovalTarget): Promise<number | null> {
    const touchedTimesMs: number[] = [];
    const targetStat = targetPath === null ? 'missing' : await statUnlessMissing(targetPath);
    if (targetStat === null) return null;
    if (targetPath !== null && targetStat !== 'missing') {
      touchedTimesMs.push(targetStat.mtimeMs);
      const adminDir = await run(['rev-parse', '--absolute-git-dir'], targetPath);
      const adminStat = adminDir.ok ? await fsp.stat(adminDir.out).catch(() => null) : null;
      if (adminStat === null) return null;
      touchedTimesMs.push(adminStat.mtimeMs);
    }
    const commitRef = tipSha ?? (branch ? `refs/heads/${branch}` : null);
    if (commitRef !== null) {
      const commitTime = await run(['log', '-1', '--format=%ct', commitRef], projectPath);
      const commitTimeMs = commitTime.ok ? parseCommitTimeMs(commitTime.out) : null;
      if (commitTimeMs === null) return null;
      touchedTimesMs.push(commitTimeMs);
    }
    if (touchedTimesMs.length === 0) return null;
    return Math.max(...touchedTimesMs);
  }

  async function recordOwnedFolder({ folderPath, owner }: { folderPath: string; owner: OwnedPathOwner }): Promise<void> {
    await opts.ownedPaths?.record({ path: folderPath, owner, kind: 'folder', projectPath: null, branch: null });
  }

  async function pruneWorktreeEntries(runGitInProject: ProjectGitRunner): Promise<GitResult> {
    const listed = await runGitInProject(['worktree', 'list', '--porcelain']);
    for (const lockedPath of listed.ok ? listOwnLockedWorktreePaths(listed.out, glimmervoidHomes) : []) {
      if (await directoryExists(lockedPath) || !await directoryExists(glimmervoidHome)) continue;
      await runGitInProject(['worktree', 'unlock', lockedPath]);
    }
    return runGitInProject(['worktree', 'prune']);
  }
  async function detectDefaultBranch({ projectPath }: { projectPath: string }): Promise<string | null> {
    const remoteHead = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], projectPath);
    const fromRemoteHead = remoteHead.ok ? defaultBranchFromRemoteHead(remoteHead.out) : null;
    if (fromRemoteHead) return fromRemoteHead;
    for (const branch of DEFAULT_BRANCH_FALLBACKS) {
      const localBranch = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath);
      if (localBranch.ok) return branch;
    }
    return null;
  }

  async function probeMarkerAgainstDefault(projectPath: string, marker: string): Promise<MarkerProbes> {
    const detectedDefaultBranch = await detectDefaultBranch({ projectPath });
    const plan = markerProbeCommands({ marker, detectedDefaultBranch });
    if (!plan) return { ...UNPROBED_MARKER, detectedDefaultBranch };
    for (const candidate of plan.markerRefCandidates) {
      const markerRef = await run(candidate.argv, projectPath);
      if (!markerRef.ok) continue;
      const absorbed = await run(plan.absorbedByDefault(candidate.ref), projectPath);
      return { detectedDefaultBranch, resolvedMarkerRef: candidate.ref, isMarkerRefResolvable: true, isMarkerAbsorbedByDefault: absorbed.ok };
    }
    return { ...UNPROBED_MARKER, detectedDefaultBranch, isMarkerRefResolvable: false };
  }

  async function migrateMarkerBase(projectPath: string, branch: string, fallbackBase: string | null | undefined, configuredIntegrationBranch: string | null | undefined): Promise<ResolvedMarkerBase> {
    const marker = markerFrom(await run(['config', '--get', markerKey(branch)], projectPath));
    const probes = marker && !configuredIntegrationBranch
      ? await probeMarkerAgainstDefault(projectPath, marker)
      : UNPROBED_MARKER;
    const decision = decideMarkerBase({ marker, fallbackBase, configuredIntegrationBranch, ...probes });
    if (!decision.migrateTo) return { base: decision.base, measureRef: decision.measureRef };
    const written = await run(['config', markerKey(branch), decision.migrateTo], projectPath);
    if (!written.ok) return { base: marker, measureRef: null };
    return { base: decision.base, measureRef: null };
  }

  async function classifyBaseAgainstOrigin(projectPath: string, branch: string): Promise<BaseClassification> {
    const upstream = `origin/${branch}`;
    const remoteBranch = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], projectPath);
    if (!remoteBranch.ok) return { state: 'no-upstream', upstream };
    const counts = parseLeftRightCount((await run([
      'rev-list', '--left-right', '--count', `${upstream}...${branch}`,
    ], projectPath)).out);
    return {
      state: decideBranchSyncState({ hasUpstream: true, ahead: counts?.ahead, behind: counts?.behind }),
      upstream,
    };
  }

  async function hasOriginRemote(projectPath: string): Promise<boolean> {
    return (await run(['remote', 'get-url', 'origin'], projectPath)).ok;
  }

  async function originUrl({ projectPath }: { projectPath: string }): Promise<string | null> {
    const remote = await run(['remote', 'get-url', 'origin'], projectPath);
    return remote.ok && remote.out ? remote.out : null;
  }

  async function fastForwardBaseFromOrigin(projectPath: string, branch: string, upstream: string): Promise<boolean> {
    const checkedOut = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const decision = decideResyncAction('behind', checkedOut === branch);
    const command = buildResyncCommand(decision, { upstream, branch, remote: 'origin' });
    if (!command) return false;
    return (await run(command.args, projectPath, { timeout: command.timeoutMs })).ok;
  }

  async function synchronizeBaseWithOrigin(
    projectPath: string,
    branch: string,
    fetched: GitResult | null = null,
  ): Promise<BaseSyncResult> {
    if (!(await hasOriginRemote(projectPath))) return { state: 'no-upstream', upstream: `origin/${branch}`, fetched: null };
    const fetchResult = fetched || await fetchOriginBody({ projectPath, branch });
    if (!fetchResult.ok) {
      const fullError = fetchResult.err || fetchResult.out;
      log.warn(`[git-workspace] fetch origin/${branch} failed: ${fullError}`);
      return {
        state: 'unknown', upstream: `origin/${branch}`, fetched: false, error: firstGitErrorLine(fullError),
      };
    }
    const classified = await classifyBaseAgainstOrigin(projectPath, branch);
    if (classified.state === 'no-upstream') return { ...classified, fetched: null };
    if (classified.state !== 'behind') return { ...classified, fetched: true };
    const fastForwarded = await fastForwardBaseFromOrigin(projectPath, branch, classified.upstream);
    if (!fastForwarded) return { ...classified, fetched: true, error: 'fast-forward failed' };
    return { ...classified, state: 'in-sync', fetched: true };
  }

  async function pushBaseToOrigin(projectPath: string, branch: string): Promise<boolean> {
    if (!(await hasOriginRemote(projectPath))) return false;
    const classified = await classifyBaseAgainstOrigin(projectPath, branch);
    const decision = decideResyncAction(classified.state, false);
    const command = buildResyncCommand(decision, {
      upstream: classified.upstream, branch, remote: 'origin',
    });
    if (!command) return false;
    return (await run(command.args, projectPath, {
      timeout: command.timeoutMs,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })).ok;
  }

  function mergeSyncWarning(baseSync: BaseSyncResult, branch: string): string | null {
    if (baseSync.fetched === false) return `could not fetch origin/${branch}; merged with local base: ${baseSync.error}`;
    if (baseSync.error) return `could not fast-forward ${branch} from origin/${branch}; merged with local base`;
    return null;
  }

  function includeWarning(mergeResult: MergeOutcome, warning: string | null): MergeOutcome {
    if (!warning) return mergeResult;
    return { ...mergeResult, warning };
  }

  async function ensureLocalBranch(projectPath: string, baseBranch: string): Promise<string | null> {
    const seedCandidates = [
      `refs/remotes/origin/${baseBranch}`,
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'HEAD',
    ];
    for (const candidate of seedCandidates) {
      const verify = await run(['rev-parse', '--verify', '--quiet', candidate], projectPath);
      if (!verify.ok) continue;
      const created = await run(['branch', '--', baseBranch, candidate], projectPath);
      if (!created.ok) return null;
      return verify.out;
    }
    return null;
  }

  async function createBody({
    projectPath,
    owner,
    teamId,
    label,
    baseBranch = null,
    configuredIntegrationBranch = null,
    forkFromHead = false,
    worktreeBase,
    shareList,
  }: OwnedWorktreeArgs): Promise<WorkspaceHandle> {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return { cwd: projectPath, isGit: false };
    const head = await run(['rev-parse', 'HEAD'], projectPath);
    if (!head.ok) return { cwd: projectPath, isGit: false };

    if (rerereEnabled) {
      const configured = await run(['config', '--get', 'rerere.enabled'], projectPath);
      if (!configured.ok || configured.out === '') await run(['config', 'rerere.enabled', 'true'], projectPath);
    }
    const branch = `glimmervoid/${sanitizeWorktreeName(teamId)}/${sanitizeWorktreeName(label)}`;
    await pruneWorktreeEntries(runInProject(projectPath));
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (listed.ok) {
      const conflictPath = findWorktreeForBranch(listed.out, branch);
      if (conflictPath) {
        return {
          cwd: projectPath,
          isGit: false,
          reason: 'branch-in-use',
          conflictPath,
          branch,
          base: (await migrateMarkerBase(projectPath, branch, baseBranch, configuredIntegrationBranch)).base,
        };
      }
    }
    const currentBranch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out || 'HEAD';
    let base: string | null = currentBranch;
    if (!forkFromHead) base = baseBranch || await detectDefaultBranch({ projectPath });
    if (!base) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    const ref = forkFromHead
      ? head
      : await run(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], projectPath);
    const baseSha = ref.ok ? ref.out : await ensureLocalBranch(projectPath, base);
    if (!baseSha) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    await deleteStaleSessionBranch(projectPath, branch);

    if (worktreeBase) {
      try { fs.mkdirSync(worktreeBase, { recursive: true }); } catch {}
    }
    const location = sessionWorktreeLocation(projectPath, teamId, worktreeBase);
    const wtDir = mkdtemp(path.join(location.parent, location.prefix));
    const add = await addWorktreeEntry(runInProject(projectPath), wtDir, ['-b', branch, wtDir, baseSha], { owner, projectPath, branch });
    if (!add.ok) {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
      return { cwd: projectPath, isGit: false, error: add.err };
    }

    await run(['config', markerKey(branch), base], projectPath);

    await populateShare({ projectPath, wtDir, shareList });
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  async function populateShare({ projectPath, wtDir, shareList, keepTrackableLinks = false }: WorktreeArgs): Promise<void> {
    if (!wtDir || !shareList || !shareList.length) return;
    const ignored: string[] = [];
    for (const rel of shareList) {
      if (rel && !String(rel).includes('..') && (await run(['check-ignore', '-q', '--', rel], projectPath)).ok) {
        ignored.push(rel);
      }
    }
    if (!ignored.length) return;
    try { await populateWorktree(projectPath, wtDir, ignored); } catch {}
    if (keepTrackableLinks) return;
    await refuseTrackableLinks(wtDir, ignored);
  }

  async function ensureWorkspaceMemberBody({ projectPath, owner, wtDir, branch, shareList }: OwnedWorktreeArgs): Promise<WorkspaceHandle> {
    if (!wtDir || !branch) return { cwd: projectPath, isGit: false, reason: 'missing-workspace-member' };
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return { cwd: projectPath, isGit: false, reason: 'not-git' };
    await pruneWorktreeEntries(runInProject(projectPath));
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return { cwd: projectPath, isGit: false, error: listed.err };
    const conflictPath = findWorktreeForBranch(listed.out, branch);
    if (conflictPath && !isSameDirectoryPath(conflictPath, wtDir)) {
      return { cwd: projectPath, isGit: false, reason: 'branch-in-use', conflictPath, branch };
    }
    const base = await detectDefaultBranch({ projectPath });
    if (conflictPath) {
      await populateShare({ projectPath, wtDir, shareList });
      return { cwd: wtDir, isGit: true, branch, base };
    }
    const existingBranch = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath);
    if (existingBranch.ok) {
      const attached = await addWorktreeEntry(runInProject(projectPath), wtDir, [wtDir, branch], { owner, projectPath, branch });
      if (!attached.ok) return { cwd: projectPath, isGit: false, reason: 'worktree-add-failed', error: attached.err };
      await populateShare({ projectPath, wtDir, shareList });
      return { cwd: wtDir, isGit: true, branch, base };
    }
    if (!base) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    const synced = await syncIntegrationBranchBody({ projectPath, branch: base });
    if (synced.outcome === 'fetch-failed' || synced.outcome === 'update-failed') {
      return { cwd: projectPath, isGit: false, reason: 'base-sync-failed', error: synced.error };
    }
    const baseRef = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], projectPath);
    const baseSha = baseRef.ok ? baseRef.out : await ensureLocalBranch(projectPath, base);
    if (!baseSha) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
    const added = await addWorktreeEntry(runInProject(projectPath), wtDir, ['-b', branch, wtDir, baseSha], { owner, projectPath, branch });
    if (!added.ok) return { cwd: projectPath, isGit: false, reason: 'worktree-add-failed', error: added.err };
    await populateShare({ projectPath, wtDir, shareList });
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  async function refuseTrackableLinks(wtDir: string, entries: string[]): Promise<void> {
    for (const rel of entries) {
      if ((await run(['check-ignore', '-q', '--', rel], wtDir)).ok) continue;
      const target = path.join(wtDir, rel);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat || !stat.isSymbolicLink()) continue;
      console.warn(`[git-workspace] not sharing ${rel}: git does not ignore it as a link, so a commit in the worktree would carry it (use a slash-free .gitignore entry)`);
      try { await fsp.rm(target, { force: true }); } catch {}
    }
  }

  async function deleteStaleSessionBranch(projectPath: string, branch: string): Promise<void> {
    if (!(await readLocalBranchSha(projectPath, branch)).out) return;
    const admission = await admitRemoval({ cause: 'session-create', kind: 'local-branch', projectPath, path: null, branch });
    if (!admission.admitted) return;
    await run(['branch', '-D', branch], projectPath);
  }

  async function tearDownWorktree(projectPath: string, wt: string, branch: string | null | undefined): Promise<void> {
    const admission = await admitRemoval({ cause: 'merge', kind: 'worktree', projectPath, path: wt, branch: branch ?? null });
    if (!admission.admitted) return;
    removeWorktreeLinks(wt);
    await removeWorktreeEntry(runInProject(projectPath), wt, ['--force']);
    await pruneWorktreeEntries(runInProject(projectPath));
    if (branch) await run(['branch', '-D', branch], projectPath);
  }

  async function fastForwardTarget(projectPath: string, sourceRef: string, target: string, targetIsHead: boolean): Promise<{ ok: boolean; err: string }> {
    if (!targetIsHead) {
      const fetched = await run(['fetch', '.', `${sourceRef}:refs/heads/${target}`], projectPath);
      return { ok: fetched.ok, err: fetched.ok ? '' : (fetched.err ?? '') };
    }

    const merged = await run(['merge', '--ff-only', String(sourceRef).replace(/^refs\/heads\//, '')], projectPath);
    return { ok: merged.ok, err: merged.ok ? '' : (merged.err ?? '') };
  }

  async function unmergedPaths(wt: string): Promise<string[]> {
    return (await run(['diff', '--name-only', '--diff-filter=U'], wt)).out
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async function abortRebaseWithConflicts(wt: string): Promise<string[]> {
    const conflicts = await unmergedPaths(wt);
    await run(['rebase', '--abort'], wt);
    return conflicts;
  }

  async function rebaseStopped(wt: string): Promise<boolean> {
    return (await run(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], wt)).ok;
  }

  const withAutoUpdate = (args: string[]) => (rerereEnabled ? ['-c', 'rerere.autoUpdate=true', ...args] : args);

  async function advanceRebaseStep(wt: string): Promise<{ done: boolean; conflicted?: boolean }> {
    const staged = await run(['diff', '--cached', '--quiet'], wt);
    const step = staged.ok ? '--skip' : '--continue';
    const r = await run(withAutoUpdate(['rebase', step]), wt, { env: { GIT_EDITOR: 'true' } });
    if (r.ok) return { done: true };
    return { done: false, conflicted: (await unmergedPaths(wt)).length > 0 };
  }

  async function findStashEntryByTag(wt: string, tag: string): Promise<{ selector: string; sha: string } | null> {
    const listing = await run(['stash', 'list', '--format=%gd %H %gs'], wt);
    const entry = listing.out.split(/\r?\n/).find((line) => line.endsWith(`: ${tag}`));
    if (!entry) return null;
    const [selector = '', sha = ''] = entry.split(' ');
    return { selector, sha };
  }

  async function saveUncommittedWork(wt: string): Promise<{ tag: string; sha: string } | null> {
    const tag = `glimmervoid-merge-${crypto.randomUUID()}`;
    if (!(await run(['stash', 'push', '--include-untracked', '-m', tag], wt)).ok) return null;
    const entry = await findStashEntryByTag(wt, tag);
    return entry ? { tag, sha: entry.sha } : null;
  }

  async function restoreSavedWork(wt: string, savedWork: { tag: string; sha: string } | null): Promise<boolean> {
    if (!savedWork) return true;
    if (!(await run(['stash', 'apply', savedWork.sha], wt)).ok) return false;
    const entry = await findStashEntryByTag(wt, savedWork.tag);
    if (entry?.sha === savedWork.sha) await run(['stash', 'drop', entry.selector], wt);
    return true;
  }

  const RERERE_STEP_CAP = 50;
  async function replayRecordedResolutions(wt: string): Promise<{ ok: boolean; steps: number }> {
    let steps = 0;
    for (; steps < RERERE_STEP_CAP; steps += 1) {
      if ((await unmergedPaths(wt)).length) return { ok: false, steps };
      const staged = await run(['add', '-u'], wt);
      if (!staged.ok) return { ok: false, steps };
      const advanced = await advanceRebaseStep(wt);
      if (advanced.done) return { ok: true, steps: steps + 1 };
      if (!advanced.conflicted) return { ok: false, steps };
    }
    return { ok: false, steps };
  }

  async function rebaseFfBranch({ projectPath, wt, branch, target }: {
    projectPath: string;
    wt: string;
    branch: string;
    target: string;
  }): Promise<{
    committed: boolean;
    merged: boolean;
    reason: string | null;
    parked?: boolean;
    conflicts?: string[];
    restoreConflict?: boolean;
    rerereReplayed?: boolean;
  }> {

    const ahead = await run(['rev-list', '--count', `${target}..${branch}`], projectPath);
    if (!ahead.ok || ahead.out === '' || ahead.out === '0') {
      return { committed: false, merged: false, reason: 'nothing-to-commit' };
    }

    const dirty = (await run(['--no-optional-locks', 'status', '--porcelain'], wt)).out !== '';
    const savedWork = dirty ? await saveUncommittedWork(wt) : null;

    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {
      const replay = rerereEnabled && (await rebaseStopped(wt))
        ? await replayRecordedResolutions(wt)
        : { ok: false };
      if (!replay.ok) {
        const conflicts = await abortRebaseWithConflicts(wt);
        await restoreSavedWork(wt, savedWork);
        return { committed: true, merged: false, reason: 'rebase-conflict', parked: true, conflicts };
      }
      rerereReplayed = true;
    }

    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const merged = await fastForwardTarget(projectPath, `refs/heads/${branch}`, target, head === target);
    if (!merged.ok) {
      await restoreSavedWork(wt, savedWork);
      return { committed: true, merged: false, reason: 'not-fast-forward', parked: true, rerereReplayed };
    }

    const restoreConflict = !(await restoreSavedWork(wt, savedWork));
    return { committed: true, merged: true, reason: null, restoreConflict, rerereReplayed };
  }

  async function resolveMergeBack({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<{
    wt?: string;
    branch?: string;
    target?: string;
    error?: MergeOutcome;
  }> {
    if (!workspace || !workspace.isGit) return { error: { merged: false, committed: false, branch: null, reason: 'not-git' } };
    const branch = workspace.branch;
    if (!branch) return { error: { merged: false, committed: false, branch: null, reason: 'no-branch' } };
    const target = workspace.base || targetBranch;
    if (!target || target === 'HEAD') return { error: { merged: false, committed: false, branch, reason: 'no-target', parked: true } };
    if (!(await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).ok) {
      return { error: { merged: false, committed: false, branch, base: target, reason: 'no-target-branch', parked: true } };
    }
    return { wt: workspace.cwd, branch, target };
  }

  async function isLeftoverGuardrailsPlaceholder(worktreePath: string, statusEntry: string): Promise<boolean> {
    if (!statusEntry.startsWith(UNTRACKED_STATUS_PREFIX)) return false;
    const entryName = statusEntry.slice(UNTRACKED_STATUS_PREFIX.length);
    if (!GUARDRAILS_PLACEHOLDER_NAMES.includes(entryName)) return false;
    const entryStats = await fs.promises.lstat(path.join(worktreePath, entryName)).catch(() => null);
    return entryStats?.isFile() === true && entryStats.size === 0;
  }

  async function readUncommittedWork(worktreePath: string, statusPathspec: string[] = []): Promise<{ ok: boolean; hasWork: boolean }> {
    const status = await run([...WORKTREE_STATUS_ARGS, ...statusPathspec], worktreePath);
    const statusEntries = status.out.split('\n').filter((statusEntry) => statusEntry !== '');
    const placeholderFlags = await Promise.all(statusEntries.map((statusEntry) => isLeftoverGuardrailsPlaceholder(worktreePath, statusEntry)));
    return { ok: status.ok, hasWork: placeholderFlags.includes(false) };
  }

  async function isRegularCoherenceJournal(worktreePath: string, journalPath: string): Promise<boolean> {
    const pathSegments = journalPath.split('/');
    if (!isCoherenceJournalPath(journalPath)) return false;
    let checkedPath = worktreePath;
    for (const [index, segment] of pathSegments.entries()) {
      if (!segment || segment === '.' || segment === '..') return false;
      checkedPath = path.join(checkedPath, segment);
      const entryStats = await fsp.lstat(checkedPath).catch(() => null);
      if (!entryStats) return false;
      if (index === pathSegments.length - 1) return entryStats.isFile();
      if (!entryStats.isDirectory()) return false;
    }
    return false;
  }

  async function recordCoherenceJournals(worktreePath: string): Promise<boolean> {
    const modifiedFiles = await run(['ls-files', '--modified', '--others', '--exclude-standard', '-z', '--', COHERENCE_JOURNAL_DIRECTORY], worktreePath);
    if (!modifiedFiles.ok) return false;
    const stagedFiles = await run(['diff', '--cached', '--name-only', '--no-renames', '-z', '--', COHERENCE_JOURNAL_DIRECTORY], worktreePath);
    if (!stagedFiles.ok) return false;
    const journalPaths = [...new Set([...modifiedFiles.out.split('\0'), ...stagedFiles.out.split('\0')].filter(Boolean))];
    if (journalPaths.length === 0) return true;
    for (const journalPath of journalPaths) {
      if (!await isRegularCoherenceJournal(worktreePath, journalPath)) return false;
    }
    const literalJournalPaths = journalPaths.map((journalPath) => `:(literal)${journalPath}`);
    const staged = await runUntrusted(['add', '--', ...literalJournalPaths], worktreePath, { disableHooks: true });
    if (!staged.ok) return false;
    const committed = await runUntrusted(['commit', '-m', 'chore: record Coherence journal', '--only', '--', ...literalJournalPaths], worktreePath, { disableHooks: true });
    return committed.ok;
  }

  async function mergeBackBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    const uncommitted = await readUncommittedWork(wt, COHERENCE_BOOKKEEPING_PATHSPEC);
    if (!uncommitted.ok || uncommitted.hasWork || !await recordCoherenceJournals(wt)) {
      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'uncommitted-changes', parked: true }, warning);
    }

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      await tearDownWorktree(projectPath, wt, branch);
      return includeWarning({ merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' }, warning);
    }
    if (!r.merged) {

      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }
    await tearDownWorktree(projectPath, wt, branch);
    const pushed = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true,
      committed: true,
      branch: null,
      base: target,
      reason: null,
      pushed,
      rerereReplayed: r.rerereReplayed === true,
    }, warning);
  }

  async function mergeKeepBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<MergeOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt = '', branch = '', target = '' } = g;

    const baseSync = await synchronizeBaseWithOrigin(projectPath, target);
    if (baseSync.state === 'diverged') {
      return { merged: false, committed: false, branch, base: target, reason: 'base-diverged', parked: true };
    }
    const warning = mergeSyncWarning(baseSync, target);

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
    if (!r.committed) {

      return includeWarning({ merged: false, committed: false, branch, base: target, reason: 'nothing-to-commit', kept: true }, warning);
    }
    if (!r.merged) {
      return includeWarning({ merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] }, warning);
    }

    const baseSha = (await run(['rev-parse', target], projectPath)).out || workspace?.baseSha || null;
    const pushed = await pushBaseToOrigin(projectPath, target);
    return includeWarning({
      merged: true, committed: true, branch, base: target, baseSha, kept: true, reason: null,
      pushed, restoreConflict: r.restoreConflict || false, rerereReplayed: r.rerereReplayed === true,
    }, warning);
  }

  async function rebaseOnlyBody({ projectPath, workspace, targetBranch }: WorktreeArgs): Promise<RebaseOutcome> {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return { ok: false, reason: g.error.reason ?? undefined };
    const { wt = '', target = '' } = g;

    const uncommitted = await readUncommittedWork(wt);
    if (!uncommitted.ok) return { ok: false, reason: 'unreadable' };
    if (uncommitted.hasWork) return { ok: false, reason: 'dirty' };

    const behind = await run(['rev-list', '--count', `HEAD..${target}`], wt);
    if (!behind.ok) return { ok: false, reason: 'unreadable' };
    if (behind.out === '' || behind.out === '0') return { ok: true, upToDate: true };

    let rerereReplayed = false;
    if (!(await run(withAutoUpdate(['rebase', target]), wt)).ok) {

      if (!(await rebaseStopped(wt))) return { ok: false, reason: 'rebase-failed' };
      const replay = rerereEnabled ? await replayRecordedResolutions(wt) : { ok: false };
      if (!replay.ok) return { ok: false, reason: 'rebase-conflict', conflicts: await abortRebaseWithConflicts(wt) };
      rerereReplayed = true;
    }
    return {
      ok: true,
      rebased: true,
      headSha: (await run(['rev-parse', 'HEAD'], wt)).out || null,
      baseSha: (await run(['rev-parse', target], wt)).out || null,
      rerereReplayed,
    };
  }

  async function discardBody({ projectPath, workspace, cause }: RemovalArgs): Promise<void> {
    if (!workspace || !workspace.isGit) return;
    const admission = await admitRemoval({ cause, kind: 'worktree', projectPath, path: workspace.cwd || null, branch: workspace.branch || null });
    if (!admission.admitted) return;
    if (workspace.cwd) {
      removeWorktreeLinks(workspace.cwd);
      await removeWorktreeEntry(runInProject(projectPath), workspace.cwd, ['--force']);
    }
    if (workspace.branch) await run(['branch', '-D', workspace.branch], projectPath);
    await pruneWorktreeEntries(runInProject(projectPath));
  }

  async function probeWorktreeWork({ projectPath, cwd, branch, measuredTip = branch, integrationBranch, configuredIntegrationBranch }: {
    projectPath: string;
    cwd: string;
    branch: string;
    measuredTip?: string;
    integrationBranch?: string | null;
    configuredIntegrationBranch?: string | null;
  }): Promise<WorktreeProbe> {
    const { base: resolvedIntegrationBranch, measureRef } = await migrateMarkerBase(projectPath, branch, integrationBranch, configuredIntegrationBranch);
    const dirty = await run(WORK_PRESENCE_STATUS_ARGS, cwd);
    const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
      ? await run(unlandedCommitCountArgs({
        tip: measuredTip,
        measuredBase: measureRef || resolvedIntegrationBranch,
        originBaseRef: markerFrom(await run(originTrackingRefProbe(resolvedIntegrationBranch), projectPath)),
      }), projectPath)
      : null;
    return { dirty, ahead, integrationBranch: resolvedIntegrationBranch ?? null };
  }

  async function describeWorkspaceMemberWorkBody({ projectPath, cwd, branch }: { projectPath: string; cwd: string; branch: string }): Promise<string | null> {
    const memberHead = await run(['rev-parse', '--verify', 'HEAD'], cwd);
    if (!memberHead.ok || !memberHead.out) return 'its checked-out commit could not be read';
    const integrationBranch = await detectDefaultBranch({ projectPath });
    const { dirty, ahead, integrationBranch: comparedBranch } = await probeWorktreeWork({ projectPath, cwd, branch, measuredTip: memberHead.out, integrationBranch });
    if (!dirty.ok) return 'its git status could not be read';
    if (isDirtyResult(dirty)) return 'uncommitted changes';
    if (!ahead?.ok) return 'its commits could not be compared with the base branch';
    if (!ahead.out || ahead.out === '0') return null;
    return `${ahead.out} ${ahead.out === '1' ? 'commit' : 'commits'} not on ${comparedBranch}`;
  }

  async function hasUnmergedWorkBody({ projectPath, workspace, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<boolean> {
    if (!workspace || !workspace.isGit || !workspace.cwd || !workspace.branch) return true;
    const { dirty, ahead } = await probeWorktreeWork({
      projectPath, cwd: workspace.cwd, branch: workspace.branch,
      integrationBranch: integrationBranch || workspace.base,
      configuredIntegrationBranch,
    });
    if (!dirty.ok) return true;
    if (isDirtyResult(dirty)) return true;
    if (!ahead || !ahead.ok) return true;
    return hasWorkFrom(dirty, ahead);
  }

  async function scanProbedWorktrees<Described>({ projectPath, integrationBranch, configuredIntegrationBranch, beforeDescribe, describe }: {
    projectPath: string;
    integrationBranch?: string | null;
    configuredIntegrationBranch?: string | null;
    beforeDescribe?: (porcelain: string) => Promise<void>;
    describe: (entry: WorktreeBranch, probe: () => Promise<WorktreeProbe>, mainWorktree: string | null) => Promise<Described | null>;
  }): Promise<Described[]> {
    const described: Described[] = [];
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return described;
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return described;
    if (beforeDescribe) await beforeDescribe(listed.out);
    const mainWorktree = mainWorktreePath(listed.out);
    for (const entry of parseWorktreeBranches(listed.out)) {
      const probe = () => probeWorktreeWork({ projectPath, cwd: entry.cwd, branch: entry.branch, integrationBranch, configuredIntegrationBranch });
      const record = await describe(entry, probe, mainWorktree);
      if (record !== null) described.push(record);
    }
    return described;
  }

  async function listWorktreesBody({ projectPath, prefixes = [], integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<ListedWorktree[]> {
    return scanProbedWorktrees<ListedWorktree>({
      projectPath, integrationBranch, configuredIntegrationBranch,
      beforeDescribe: (porcelain) => lockReusedHomeWorktrees(runInProject(projectPath), porcelain),
      describe: async ({ cwd, branch, locked, prunable, headSha }, probe, mainWorktree) => {
        const canonicalCwd = await comparableDirectoryPath(cwd);
        if (mainWorktree !== null && canonicalCwd === await comparableDirectoryPath(mainWorktree)) return null;
        if (matchedPrefix(branch, prefixes) === null) return null;
        if (!headSha) return null;
        if (prunable || !(await directoryExists(cwd))) {
          return { cwd: canonicalCwd, branch, locked, prunable: true, dirty: null, tipSha: headSha, integrationBranch: null };
        }
        const probed = await probe();
        return {
          cwd: canonicalCwd, branch, locked, prunable: false,
          dirty: probed.dirty.ok ? isDirtyResult(probed.dirty) : null,
          tipSha: headSha,
          integrationBranch: probed.integrationBranch,
        };
      },
    });
  }

  async function listSessionWorktreesBody({ projectPath, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): Promise<SessionWorktree[]> {
    return scanProbedWorktrees<SessionWorktree>({
      projectPath, integrationBranch, configuredIntegrationBranch,
      describe: async ({ cwd, branch }, probe) => {
        const id = sessionIdFromBranch(branch);
        if (id === null) return null;
        const probed = await probe();
        return {
          cwd, branch, id,
          hasWork: hasWorkFrom(probed.dirty, probed.ahead),
          integrationBranch: probed.integrationBranch,
        };
      },
    });
  }

  async function probeWorktreeDirtyBody({ cwd }: WorktreeArgs): Promise<WorktreeDirtyProbe> {
    if (!cwd) return { ok: false, dirty: true, headSha: null, err: 'a worktree status probe needs a path' };
    const status = await run(WORK_PRESENCE_STATUS_ARGS, cwd);
    if (!status.ok) return { ok: false, dirty: true, headSha: null, err: status.err };
    const head = await run(['rev-parse', 'HEAD'], cwd);
    if (!head.ok || !head.out) return { ok: false, dirty: true, headSha: null, err: head.err || 'a worktree head probe returned no sha' };
    return { ok: true, dirty: status.out !== '', headSha: head.out };
  }

  function runUntrusted(args: string[], cwd: string, { disableHooks, disableRepoCommands, replaceEnv }: GitIsolationOptions): Promise<GitResult> {
    const hooklessArgs = disableHooks ? ['-c', `core.hooksPath=${os.devNull}`, ...args] : args;
    return run(hooklessArgs, cwd, { replaceEnv, disableRepoCommands });
  }

  async function removeWorktreeByPathBody({ projectPath, cwd, branch, cause, disableHooks, replaceEnv }: RemovalArgs): Promise<QueuedGitResult> {
    const admission = await admitRemoval({ cause, kind: cwd ? 'worktree' : 'local-branch', projectPath, path: cwd || null, branch: branch || null });
    if (!admission.admitted) return keptRemovalResult(admission.reason);
    const isolation = { disableHooks, replaceEnv };
    let failure: GitResult | null = null;
    if (cwd) {
      removeWorktreeLinks(cwd);
      const removed = await removeWorktreeEntry((args) => runUntrusted(args, projectPath, isolation), cwd, ['--force']);
      if (!removed.ok) failure = removed;
    }
    if (branch) {
      const deleted = await runUntrusted(['branch', '-D', branch], projectPath, isolation);
      if (!deleted.ok && failure === null) failure = deleted;
    }
    await pruneWorktreeEntries((args) => runUntrusted(args, projectPath, isolation));
    return failure ?? okResult('');
  }

  async function readLocalBranchSha(projectPath: string, branch: string): Promise<GitResult> {
    try {
      return okResult(await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath));
    } catch (err) {
      if (errorExitCode(err) === 1) return okResult('');
      return errResult(err);
    }
  }

  async function discardSessionBranchBody({ projectPath, teamId = '', label = '', worktreeBase, disableHooks, replaceEnv }: WorktreeArgs): Promise<GitResult> {
    const branch = `glimmervoid/${sanitizeWorktreeName(teamId)}/${sanitizeWorktreeName(label)}`;
    const existingBranch = await readLocalBranchSha(projectPath, branch);
    if (!existingBranch.ok) return existingBranch;
    if (existingBranch.out === '') return okResult('');
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return listed;
    const worktreePath = findWorktreeForBranch(listed.out, branch);
    if (worktreePath === null) return removeWorktreeByPathBody({ projectPath, branch, cause: 'session', disableHooks, replaceEnv });
    const refusal = await foreignSessionWorktreeReason(worktreePath, listed.out, sessionWorktreeLocation(projectPath, teamId, worktreeBase));
    if (refusal !== null) return { ok: false, out: '', err: refusal };
    return removeWorktreeByPathBody({ projectPath, cwd: worktreePath, branch, cause: 'session', disableHooks, replaceEnv });
  }

  async function pruneWorktreesBody({ projectPath, disableHooks, replaceEnv }: WorktreeArgs): Promise<GitResult> {
    return pruneWorktreeEntries((args) => runUntrusted(args, projectPath, { disableHooks, replaceEnv }));
  }

  async function removeSharedLinks(wtDir: string, shareList: string[] | null | undefined): Promise<void> {
    for (const rel of shareList ?? []) {
      if (!rel || String(rel).includes('..')) continue;
      const linkPath = path.join(wtDir, rel);
      const stat = await fsp.lstat(linkPath).catch(() => null);
      if (!stat || !stat.isSymbolicLink()) continue;
      if (!(await run(['check-ignore', '-q', '--', rel], wtDir)).ok) continue;
      await fsp.rm(linkPath, { recursive: false, force: true }).catch(() => fsp.rmdir(linkPath)).catch(() => {});
    }
  }

  async function removeWorkspaceMemberBody({ projectPath, cwd, branch, shareList, cause, discardWork = false }: RemovalArgs & { discardWork?: boolean }): Promise<QueuedGitResult> {
    if (!cwd) return { ok: false, out: '', err: 'a workspace member removal needs a path' };
    const admission = await admitRemoval({ cause, kind: 'worktree', projectPath, path: cwd, branch: branch || null });
    if (!admission.admitted) return keptRemovalResult(admission.reason);
    await removeSharedLinks(cwd, shareList);
    const removed = await removeWorktreeEntry(runInProject(projectPath), cwd, discardWork ? ['--force', '--force'] : []);
    if (discardWork && await directoryExists(cwd)) await fsp.rm(cwd, { recursive: true, force: true });
    await pruneWorktreeEntries(runInProject(projectPath));
    await forgetRemovedPath(cwd);
    if (discardWork && !(await directoryExists(cwd))) return { ok: true, out: removed.out };
    return removed;
  }

  async function listWorktreeBranches({ projectPath }: WorktreeArgs): Promise<WorktreeBranch[]> {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return [];
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return [];
    return parseWorktreeBranches(listed.out);
  }

  async function fetchOriginBody({ projectPath, branch = null, timeoutMs = GIT_FETCH_TIMEOUT_MS }: WorktreeArgs): Promise<GitResult> {
    const fetchOptions: GitExtraOptions = {
      timeout: timeoutMs,
      env: { GIT_TERMINAL_PROMPT: '0' },
    };
    if (branch) {
      return run([
        'fetch', '--quiet', '--prune', 'origin', 'refs/heads/*:refs/remotes/origin/*',
      ], projectPath, fetchOptions);
    }
    return run(['fetch', '--prune', 'origin'], projectPath, fetchOptions);
  }

  async function seedBranchFromOriginBody({ projectPath, name }: WorktreeArgs): Promise<GitResult> {
    const branchName = name ?? '';
    const isBranchName = await run(['check-ref-format', '--branch', branchName], projectPath);
    if (!isBranchName.ok || branchName.startsWith('-')) return { ok: false, out: '', err: `not a branch name: ${branchName}` };
    const remoteRef = `refs/remotes/origin/${branchName}`;
    const fetched = await run(
      ['fetch', '--quiet', 'origin', `+refs/heads/${branchName}:${remoteRef}`],
      projectPath,
      { timeout: GIT_FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } },
    );
    if (!fetched.ok) return fetched;
    const originTip = await run(['rev-parse', '--verify', '--quiet', remoteRef], projectPath);
    if (!originTip.ok) return originTip;
    const localRef = `refs/heads/${branchName}`;
    const existing = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    if (existing.ok) return fastForwardSeededBranch(projectPath, branchName, existing.out, originTip.out);
    const created = await run(['branch', '--', branchName, remoteRef], projectPath);
    if (!created.ok) return created;
    return run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
  }

  async function fastForwardSeededBranch(projectPath: string, branchName: string, localSha: string, originSha: string): Promise<GitResult> {
    if (localSha === originSha) return okResult(localSha);
    const mismatch = `local branch ${branchName} is at ${localSha} but origin has ${originSha}`;
    const ancestry = await isAncestor({ projectPath, ancestorSha: localSha, descendantSha: originSha });
    if (!ancestry.ok) return { ok: false, out: '', err: `could not compare ${mismatch}` };
    if (!ancestry.isAncestor) return { ok: false, out: '', err: `${mismatch}, and the local branch has commits that are not on origin` };
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return listed;
    const isCheckedOut = parseWorktreeBranches(listed.out).some((entry) => entry.branch === branchName);
    if (isCheckedOut) return { ok: false, out: '', err: `${mismatch}, and it is checked out in a worktree` };
    const updated = await run(['update-ref', `refs/heads/${branchName}`, originSha, localSha], projectPath);
    if (!updated.ok) return updated;
    return okResult(originSha);
  }

  async function stageDetachedWorktreeBody({ projectPath, worktreePath, sha, owner, disableHooks, replaceEnv }: StageDetachedWorktreeArgs): Promise<GitResult> {
    if (!worktreePath) return { ok: false, out: '', err: 'a detached worktree needs a path' };
    if (normalizeSha(sha) !== sha) return { ok: false, out: '', err: 'a detached worktree sha must be 40 lowercase hexadecimal characters' };
    return addWorktreeEntry((args) => runUntrusted(args, projectPath, { disableHooks, replaceEnv }), worktreePath, ['--detach', worktreePath, sha], { owner, projectPath, branch: null });
  }

  async function checkoutDetachedBody({ worktreePath, sha, ...isolation }: CheckoutDetachedArgs): Promise<GitResult> {
    if (!worktreePath) return { ok: false, out: '', err: 'a detached worktree needs a path' };
    if (normalizeSha(sha) !== sha) return { ok: false, out: '', err: 'a detached worktree sha must be 40 lowercase hexadecimal characters' };
    return runUntrusted(['checkout', '--quiet', '--detach', sha], worktreePath, isolation);
  }

  function isolatedCheckoutRefusal({ checkoutPath, sha, baseSha }: StageIsolatedCheckoutArgs): GitResult | null {
    if (!checkoutPath) return { ok: false, out: '', err: 'an isolated checkout needs a path' };
    if (normalizeSha(sha) !== sha || normalizeSha(baseSha) !== baseSha) {
      return { ok: false, out: '', err: 'an isolated checkout sha and base sha must be 40 lowercase hexadecimal characters' };
    }
    return null;
  }

  async function hydrateCheckoutTree(projectPath: string, sha: string): Promise<GitResult> {
    const emptyTree = await run(['hash-object', '-t', 'tree', os.devNull], projectPath);
    if (!emptyTree.ok) return emptyTree;
    return run(['diff', '--shortstat', emptyTree.out, sha], projectPath, {
      timeout: ISOLATED_CHECKOUT_HYDRATE_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  }

  async function stageIsolatedCheckoutBody({ projectPath, checkoutPath = '', sha = '', baseSha = '' }: StageIsolatedCheckoutArgs): Promise<GitResult> {
    const commonDir = await run(['rev-parse', '--git-common-dir'], projectPath);
    if (!commonDir.ok || !commonDir.out) return { ok: false, out: '', err: commonDir.err || 'the source repository has no git dir' };
    const sourceObjectsDir = path.join(path.resolve(projectPath, commonDir.out), 'objects');
    await fsp.mkdir(path.dirname(checkoutPath), { recursive: true });
    await fsp.mkdir(checkoutPath);
    const initialized = await run(['init', '--quiet', '--template='], checkoutPath);
    if (!initialized.ok) return initialized;
    const alternatesPath = path.join(checkoutPath, '.git', 'objects', 'info', 'alternates');
    await fsp.mkdir(path.dirname(alternatesPath), { recursive: true });
    await fsp.writeFile(alternatesPath, `${sourceObjectsDir}\n`, 'utf8');
    for (const [ref, refSha] of [[ISOLATED_CHECKOUT_REVIEW_REF, sha], [ISOLATED_CHECKOUT_BASE_REF, baseSha]]) {
      const updated = await run(['update-ref', ref, refSha], checkoutPath);
      if (!updated.ok) return updated;
    }
    const checkedOut = await run(['checkout', '--quiet', '--detach', ISOLATED_CHECKOUT_REVIEW_REF], checkoutPath);
    if (!checkedOut.ok) return checkedOut;
    const status = await run(WORKTREE_STATUS_ARGS, checkoutPath);
    if (!status.ok) return status;
    if (status.out !== '') return { ok: false, out: '', err: 'the isolated checkout reports changes right after checkout' };
    return okResult('');
  }

  const stageIsolatedCheckoutQueued = serialized(stageIsolatedCheckoutBody);

  async function stageIsolatedCheckout(args: StageIsolatedCheckoutArgs): Promise<GitResult> {
    const refusal = isolatedCheckoutRefusal(args);
    if (refusal) return refusal;
    const hydrated = await hydrateCheckoutTree(args.projectPath, args.sha ?? '');
    if (!hydrated.ok) return { ok: false, out: '', err: hydrated.err || 'the reviewed tree could not be fetched' };
    return stageIsolatedCheckoutQueued(args).catch(errResult);
  }

  async function mergeFastForwardToBody({ projectPath, expectedHead, sha, timeoutMs }: MergeFastForwardArgs): Promise<MergeFastForwardResult> {
    if (normalizeSha(sha) !== sha) {
      return {
        ok: false,
        out: '',
        err: 'a fast-forward merge needs a 40 lowercase hexadecimal target sha',
        sampledHead: null,
        outcome: 'invalid-target-sha',
      };
    }
    const commandOptions = timeoutMs ? { timeout: timeoutMs } : undefined;
    const head = await run(['rev-parse', 'HEAD'], projectPath, commandOptions);
    if (!head.ok || !head.out) {
      return { ...head, ok: false, sampledHead: null, outcome: 'head-unreadable' };
    }
    if (head.out !== expectedHead) {
      return {
        ok: false,
        out: '',
        err: `HEAD changed from ${expectedHead ?? 'unknown'} to ${head.out}`,
        sampledHead: head.out,
        outcome: 'head-mismatch',
      };
    }
    const merged = await run(['merge', '--ff-only', sha], projectPath, commandOptions);
    return {
      ...merged,
      sampledHead: head.out,
      outcome: merged.ok ? 'merged' : 'merge-failed',
    };
  }

  const mergeFastForwardTo = admitted(mergeFastForwardToBody, (args: MergeFastForwardArgs): MergeFastForwardResult => ({
    ok: false,
    out: '',
    err: `the git queue did not admit the merge within ${args.admissionTimeoutMs}ms`,
    sampledHead: null,
    outcome: 'queue-admission-timed-out',
  }));

  async function resetKeepToBody({ projectPath, expectedHead, sha, timeoutMs }: ResetKeepArgs): Promise<QueuedGitResult> {
    if (normalizeSha(sha) !== sha) return { ok: false, out: '', err: 'a keep reset needs a 40 lowercase hexadecimal target sha' };
    const commandOptions = timeoutMs ? { timeout: timeoutMs } : undefined;
    const head = await run(['rev-parse', 'HEAD'], projectPath, commandOptions);
    if (!head.ok || !head.out) return { ...head, ok: false };
    if (head.out !== expectedHead) {
      return { ok: false, out: '', err: `HEAD changed from ${expectedHead ?? 'unknown'} to ${head.out}` };
    }
    return run(['reset', '--keep', sha], projectPath, commandOptions);
  }

  async function classifyRefusedSync({ projectPath, branch, localRef, localSha, remoteSha, err }: {
    projectPath: string;
    branch: string;
    localRef: string;
    localSha: string | null;
    remoteSha: string | null;
    err: string;
  }): Promise<IntegrationSyncResult> {
    const current = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    const currentSha = current.ok && current.out ? current.out : localSha;
    let ancestry: boolean | null = null;
    if (currentSha && remoteSha && currentSha !== remoteSha) {
      const probe = await isAncestor({ projectPath, ancestorSha: currentSha, descendantSha: remoteSha });
      ancestry = probe.ok ? probe.isAncestor : null;
    }
    const checkout = await readRefusedCheckoutTree(projectPath, branch);
    const { outcome } = classifyRefusedIntegrationSync({ currentSha, remoteSha, isAncestor: ancestry, checkoutTree: checkout.state });
    if (outcome !== 'update-failed') return { outcome, from: currentSha, to: remoteSha };
    return { outcome, from: currentSha, to: remoteSha, error: firstGitErrorLine(err || checkout.error) };
  }

  async function readRefusedCheckoutTree(projectPath: string, branch: string): Promise<{ state: CheckoutTreeState | null; error: string }> {
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return { state: 'unknown', error: listed.err ?? '' };
    const checkoutPath = findWorktreeForBranch(listed.out, branch);
    if (!checkoutPath) return { state: null, error: '' };
    return readCheckoutTree(checkoutPath);
  }

  async function readCheckoutTree(worktreePath: string): Promise<{ state: CheckoutTreeState; error: string }> {
    const status = await run(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], worktreePath);
    if (!status.ok) return { state: 'unknown', error: status.err ?? '' };
    return { state: status.out === '' ? 'clean' : 'dirty', error: '' };
  }

  async function findLocalFilesAddedUpstream({ checkoutPath, localSha, remoteSha }: {
    checkoutPath: string;
    localSha: string;
    remoteSha: string;
  }): Promise<{ ok: true; collidingPaths: string[] } | { ok: false; err: string }> {
    const added = await run(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', localSha, remoteSha], checkoutPath);
    if (!added.ok) return { ok: false, err: added.err ?? '' };
    const addedPaths = added.out.split('\0').filter(Boolean);
    const collidingPaths: string[] = [];
    for (const addedPath of addedPaths) {
      const existsLocally = await fsp.lstat(path.join(checkoutPath, addedPath)).then(() => true, (error: unknown) => !isMissingFileError(error, { includeNotDir: false }));
      if (existsLocally) collidingPaths.push(addedPath);
    }
    return { ok: true, collidingPaths };
  }

  async function fastForwardCheckout({ checkoutPath, branch, localSha, remoteSha }: {
    checkoutPath: string;
    branch: string;
    localSha: string;
    remoteSha: string;
  }): Promise<IntegrationSyncResult> {
    const refused = (error: string): IntegrationSyncResult => ({ outcome: 'update-failed', from: localSha, to: remoteSha, error });
    const headBranch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkoutPath);
    if (!headBranch.ok || headBranch.out !== branch) {
      return refused(`${checkoutPath} no longer has ${branch} checked out`);
    }
    const collisions = await findLocalFilesAddedUpstream({ checkoutPath, localSha, remoteSha });
    if (!collisions.ok) return refused(firstGitErrorLine(collisions.err));
    if (collisions.collidingPaths.length > 0) {
      return refused(`fast-forward would overwrite local file ${collisions.collidingPaths.join(', ')}`);
    }
    const merged = await run(['merge', '--ff-only', remoteSha], checkoutPath);
    if (merged.ok) return { outcome: 'updated', from: localSha, to: remoteSha };
    return refused(firstGitErrorLine(merged.err ?? ''));
  }

  async function syncIntegrationBranchBody({ projectPath, branch }: WorktreeArgs): Promise<IntegrationSyncResult> {
    if (!(await hasOriginRemote(projectPath))) return { outcome: 'no-remote', from: null, to: null };
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;

    const fetched = await run(
      ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      projectPath,
      { timeout: GIT_FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } },
    );
    if (!fetched.ok) return { outcome: 'fetch-failed', from: null, to: null };

    const local = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    const remote = await run(['rev-parse', '--verify', '--quiet', remoteRef], projectPath);
    const localSha = local.ok ? local.out : null;
    const remoteSha = remote.ok ? remote.out : null;
    let ancestryVerdict: boolean | null = null;
    let syncError = '';
    let checkedOut = false;
    let checkoutPath: string | null = null;
    let checkoutTree: CheckoutTreeState = 'unknown';
    if (localSha && remoteSha && localSha !== remoteSha) {
      const ancestry = await isAncestor({ projectPath, ancestorSha: localSha, descendantSha: remoteSha });
      ancestryVerdict = ancestry.ok ? ancestry.isAncestor : null;
      if (!ancestry.ok) syncError = ancestry.err ?? '';
      if (ancestryVerdict === true) {
        const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
        if (!listed.ok) syncError = listed.err ?? '';
        checkoutPath = listed.ok ? findWorktreeForBranch(listed.out, branch ?? '') : null;
        checkedOut = !listed.ok || Boolean(checkoutPath);
        if (checkoutPath) {
          const tree = await readCheckoutTree(checkoutPath);
          checkoutTree = tree.state;
          syncError = tree.error;
        }
      }
    }

    const decision = decideIntegrationSync({ localSha, remoteSha, isAncestor: ancestryVerdict, checkedOut, checkoutTree });
    if (decision.outcome === 'update-failed') {
      return { outcome: decision.outcome, from: localSha, to: remoteSha, error: firstGitErrorLine(syncError) };
    }
    if (decision.action === 'update-checkout' && checkoutPath && localSha && remoteSha) {
      return fastForwardCheckout({ checkoutPath, branch: branch ?? '', localSha, remoteSha });
    }
    if (decision.action !== 'update') return { outcome: decision.outcome, from: localSha, to: remoteSha };
    const updated = await fastForwardTarget(projectPath, remoteRef, branch ?? '', false);
    if (updated.ok) return { outcome: 'updated', from: localSha, to: remoteSha };
    return classifyRefusedSync({ projectPath, branch: branch ?? '', localRef, localSha, remoteSha, err: updated.err });
  }

  async function listRemoteBranches({ projectPath, prefixes }: WorktreeArgs & { prefixes: string[] }): Promise<GitResult | { ok: true; branches: RemoteBranchTip[] }> {
    if (usablePrefixes(prefixes).length === 0) return { ok: true, branches: [] };
    const listed = await run([
      'for-each-ref',
      REMOTE_REF_PREFIX,
      '--format=%(refname) %(objectname) %(committerdate:unix) %(symref)',
    ], projectPath, { maxBuffer: REMOTE_BRANCH_LISTING_MAX_BUFFER });
    if (!listed.ok) return listed;
    const branches: RemoteBranchTip[] = [];
    for (const line of listed.out.split(/\r?\n/)) {
      if (!line) continue;
      const [refName, tipSha, commitTimeSeconds, symbolicTarget] = line.trim().split(/\s+/);
      if (symbolicTarget) continue;
      if (!refName.startsWith(REMOTE_REF_PREFIX)) continue;
      const name = refName.slice(REMOTE_REF_PREFIX.length);
      if (matchedPrefix(name, prefixes) === null) continue;
      branches.push({
        name,
        tipSha,
        tipCommitTimeMs: Number.parseInt(commitTimeSeconds, 10) * 1000,
      });
    }
    return { ok: true, branches };
  }

  async function listIntegrationTips({ projectPath, integrationBranch }: WorktreeArgs): Promise<GitResult | { ok: true; integrationTips: IntegrationTip[] }> {
    const detectedBranch = integrationBranch || await detectDefaultBranch({ projectPath });
    const branchNames = [...new Set([detectedBranch, 'main', 'master'].filter((name): name is string => Boolean(name)))];
    const refNames = branchNames.flatMap((branchName) => [
      `refs/remotes/origin/${branchName}`,
      `refs/heads/${branchName}`,
    ]);
    const listed = await run([
      'for-each-ref',
      ...refNames,
      '--format=%(refname) %(objectname)',
    ], projectPath);
    if (!listed.ok) return listed;
    const shaByRef = new Map<string, string>();
    for (const line of listed.out.split(/\r?\n/)) {
      if (!line) continue;
      const [refName, sha] = line.trim().split(/\s+/);
      if (refNames.includes(refName)) shaByRef.set(refName, sha);
    }
    const integrationTips: IntegrationTip[] = [];
    for (const branch of branchNames) {
      const sha = shaByRef.get(`refs/remotes/origin/${branch}`) || shaByRef.get(`refs/heads/${branch}`);
      integrationTips.push({ branch, sha: sha || null });
    }
    return { ok: true, integrationTips };
  }

  async function isAncestor({ projectPath, ancestorSha, descendantSha }: WorktreeArgs): Promise<(GitResult | { ok: true }) & { isAncestor: boolean }> {
    try {
      await git(['merge-base', '--is-ancestor', ancestorSha ?? '', descendantSha ?? ''], projectPath);
      return { ok: true, isAncestor: true };
    } catch (err) {
      if (errorExitCode(err) === 1) return { ok: true, isAncestor: false };
      return { ...errResult(err), isAncestor: false };
    }
  }

  async function readGitConfigValues(args: string[], projectPath: string, timeoutMs: number, replaceEnv?: Record<string, string>): Promise<GitResult> {
    try {
      return okResult(await git(['config', ...args], projectPath, { timeout: timeoutMs, ...(replaceEnv ? { replaceEnv } : {}) }));
    } catch (err) {
      if (errorExitCode(err) === 1) return okResult('');
      return errResult(err);
    }
  }

  async function resolveMergeProbeEnv({ projectPath, timeoutMs = MERGE_PROBE_TIMEOUT_MS }: MergeProbeEnvArgs): Promise<MergeProbeEnvResult> {
    const safeDirectories = await readGitConfigValues(['--get-all', 'safe.directory'], projectPath, timeoutMs);
    if (!safeDirectories.ok) return { ok: false, err: safeDirectories.err || 'reading safe.directory failed' };
    const neutralEnv = neutralGitConfigEnv(process.env, os.devNull);
    const safeDirectoryOutput = safeDirectories.out;
    const configuredKeys = await readGitConfigValues(
      ['--name-only', '--get-regexp', MERGE_DRIVER_KEY_PATTERN],
      projectPath,
      timeoutMs,
      driverEnumerationEnv({ neutralEnv, safeDirectoryOutput }),
    );
    if (!configuredKeys.ok) return { ok: false, err: configuredKeys.err || 'enumerating merge drivers failed' };
    return { ok: true, probeEnv: mergeProbeEnv({ neutralEnv, safeDirectoryOutput, configuredKeysOutput: configuredKeys.out }) };
  }

  async function writeMergedTree({ projectPath, integrationSha, branchSha, probeEnv, timeoutMs = MERGE_PROBE_TIMEOUT_MS }: MergeTreeArgs): Promise<MergeTreeProbe> {
    try {
      const out = await git(
        ['merge-tree', '--write-tree', '--allow-unrelated-histories', integrationSha, branchSha],
        projectPath,
        { timeout: timeoutMs, replaceEnv: probeEnv },
      );
      return { ...okResult(out), outcome: 'tree' };
    } catch (err) {
      if (errorExitCode(err) === 1) return { ...errResult(err), outcome: 'conflicts' };
      return { ...errResult(err), outcome: 'failed' };
    }
  }

  async function treeOid({ projectPath, sha, timeoutMs = MERGE_PROBE_TIMEOUT_MS }: WorktreeArgs): Promise<GitResult> {
    return run(['rev-parse', `${sha ?? ''}^{tree}`], projectPath, { timeout: timeoutMs });
  }

  async function deleteRemoteBranchBody({ projectPath, name, tipSha, cause }: RemovalArgs): Promise<QueuedGitResult> {
    const admission = await admitRemoval({ cause, kind: 'remote-branch', projectPath, path: null, branch: name ?? null, tipSha: tipSha ?? null });
    if (!admission.admitted) return keptRemovalResult(admission.reason);
    const branchRef = `refs/heads/${name ?? ''}`;
    return run(['push', '--no-verify', 'origin', `--force-with-lease=${branchRef}:${tipSha ?? ''}`, `:${branchRef}`], projectPath);
  }

  return {
    withGitIsolation: <T>(isolation: GitIsolationOptions, operation: () => T): T => isolationContext.run(isolation, operation),
    create: serialized(createBody),
    ensureWorkspaceMember: serialized(ensureWorkspaceMemberBody),
    removeWorkspaceMember: serialized(removeWorkspaceMemberBody),
    discard: serialized(discardBody),
    mergeBack: serialized(mergeBackBody),
    mergeKeep: serialized(mergeKeepBody),
    rebaseOnly: serialized(rebaseOnlyBody),
    populate: serialized(populateShare),
    originUrl: serialized(originUrl),
    removeWorktreeByPath: admitted(removeWorktreeByPathBody, (args: RemovalArgs): QueuedGitResult => ({
      ok: false,
      out: '',
      err: `the git queue did not admit the worktree removal within ${args.admissionTimeoutMs}ms`,
      admissionRefused: true,
    })),
    probeWorktreeDirty: admitted(probeWorktreeDirtyBody, (args: WorktreeArgs): WorktreeDirtyProbe => ({
      ok: false,
      dirty: true,
      headSha: null,
      err: `the git queue did not admit the worktree status probe within ${args.admissionTimeoutMs}ms`,
      admissionRefused: true,
    })),
    fetchOrigin: serialized(fetchOriginBody),
    seedBranchFromOrigin: serialized(seedBranchFromOriginBody),
    pruneWorktrees: serialized(pruneWorktreesBody),
    discardSessionBranch: serialized(discardSessionBranchBody),
    stageDetachedWorktree: serialized(stageDetachedWorktreeBody),
    forgetRemovedPath,
    recordOwnedFolder,
    describeWorkspaceMemberWork: serialized(describeWorkspaceMemberWorkBody),
    checkoutDetached: serialized(checkoutDetachedBody),
    stageIsolatedCheckout,
    mergeFastForwardTo,
    resetKeepTo: admitted(resetKeepToBody, (args: ResetKeepArgs): QueuedGitResult => ({
      ok: false,
      out: '',
      err: `the git queue did not admit the head reset within ${args.admissionTimeoutMs}ms`,
      admissionRefused: true,
    })),
    syncIntegrationBranch: serialized(syncIntegrationBranchBody),
    deleteRemoteBranch: serialized(deleteRemoteBranchBody),
    listWorktrees: serialized(listWorktreesBody),
    listSessionWorktrees: serialized(listSessionWorktreesBody),
    hasUnmergedWork: serialized(hasUnmergedWorkBody),
    listWorktreeBranches, detectDefaultBranch,
    listRemoteBranches, listIntegrationTips, isAncestor, resolveMergeProbeEnv, writeMergedTree, treeOid,
  };
}

function createGitWorkspaceSync(opts: { git?: (args: string[], cwd: string) => string; glimmervoidHome?: string; ownedPaths?: OwnedPathsRecorder; removalGuard?: RemovalGuardOptions; log?: Pick<Console, 'warn'> } = {}) {
  const glimmervoidHome = opts.glimmervoidHome ?? glimmervoidHomeDir();
  const glimmervoidHomes = comparableGlimmervoidHomes(glimmervoidHome);
  const removalGuard = resolveRemovalGuard(opts.removalGuard, glimmervoidHome);
  const log = opts.log || console;
  const git = opts.git || ((args: string[], cwd: string) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  function run(args: string[], cwd: string): GitResult {
    try { return okResult(git(args, cwd)); }
    catch (err) { return errResult(err); }
  }
  function detectDefaultBranch(projectPath: string): string | null {
    const remoteHead = run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], projectPath);
    const fromRemoteHead = remoteHead.ok ? defaultBranchFromRemoteHead(remoteHead.out) : null;
    if (fromRemoteHead) return fromRemoteHead;
    for (const branch of DEFAULT_BRANCH_FALLBACKS) {
      if (run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath).ok) return branch;
    }
    return null;
  }

  function probeMarkerAgainstDefault(projectPath: string, marker: string): MarkerProbes {
    const detectedDefaultBranch = detectDefaultBranch(projectPath);
    const plan = markerProbeCommands({ marker, detectedDefaultBranch });
    if (!plan) return { ...UNPROBED_MARKER, detectedDefaultBranch };
    for (const candidate of plan.markerRefCandidates) {
      if (!run(candidate.argv, projectPath).ok) continue;
      const absorbed = run(plan.absorbedByDefault(candidate.ref), projectPath);
      return { detectedDefaultBranch, resolvedMarkerRef: candidate.ref, isMarkerRefResolvable: true, isMarkerAbsorbedByDefault: absorbed.ok };
    }
    return { ...UNPROBED_MARKER, detectedDefaultBranch, isMarkerRefResolvable: false };
  }

  function migrateMarkerBase(projectPath: string, branch: string, fallbackBase: string | null | undefined, configuredIntegrationBranch: string | null | undefined): ResolvedMarkerBase {
    const marker = markerFrom(run(['config', '--get', markerKey(branch)], projectPath));
    const probes = marker && !configuredIntegrationBranch
      ? probeMarkerAgainstDefault(projectPath, marker)
      : UNPROBED_MARKER;
    const decision = decideMarkerBase({ marker, fallbackBase, configuredIntegrationBranch, ...probes });
    if (!decision.migrateTo) return { base: decision.base, measureRef: decision.measureRef };
    if (!run(['config', markerKey(branch), decision.migrateTo], projectPath).ok) return { base: marker, measureRef: null };
    return { base: decision.base, measureRef: null };
  }

  function listSessionWorktrees({ projectPath, integrationBranch, configuredIntegrationBranch }: WorktreeArgs): SessionWorktree[] {
    const out: SessionWorktree[] = [];
    const inside = run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return out;
    const listed = run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return out;
    for (const { cwd: wt, branch: name } of parseWorktreeBranches(listed.out)) {
      const id = sessionIdFromBranch(name);
      if (id === null) continue;
      const { base: resolvedIntegrationBranch, measureRef } = migrateMarkerBase(projectPath, name, integrationBranch, configuredIntegrationBranch);
      const dirty = run(['--no-optional-locks', 'status', '--porcelain', ...COHERENCE_BOOKKEEPING_PATHSPEC], wt);
      const ahead = !isDirtyResult(dirty) && resolvedIntegrationBranch
        ? run(unlandedCommitCountArgs({
          tip: name,
          measuredBase: measureRef || resolvedIntegrationBranch,
          originBaseRef: markerFrom(run(originTrackingRefProbe(resolvedIntegrationBranch), projectPath)),
        }), projectPath)
        : null;
      out.push({
        cwd: wt, branch: name, id,
        hasWork: hasWorkFrom(dirty, ahead),
        integrationBranch: resolvedIntegrationBranch ?? null,
      });
    }
    return out;
  }

  function admitRemovalSync(target: RemovalTarget): RemovalAdmission {
    const facts = removalOwnershipFacts(target, null, removalGuard.protectedSessionIds());
    const lastTouchedMs = isRecencyProbeNeeded(facts) ? probeLastTouchedMsSync(target) : null;
    const verdict = decideRemovalKeep({ ...facts, lastTouchedMs, nowMs: removalGuard.now() });
    if (verdict.keep) {
      log.warn(`[removals] kept ${describeRemovalTarget(target)} from a ${target.cause} removal because of ${verdict.reason}`);
      return { admitted: false, reason: verdict.reason };
    }
    const record = buildRemovalRecord(target, facts, verdict.checksPassed, removalGuard.now());
    if (!appendRemovalRecordSync(removalGuard.journalPath, record, log)) return { admitted: false, reason: 'removal-record-unwritten' };
    return { admitted: true };
  }

  function probeLastTouchedMsSync({ projectPath, path: targetPath, branch }: RemovalTarget): number | null {
    const touchedTimesMs: number[] = [];
    const targetStat = targetPath === null ? 'missing' : statUnlessMissingSync(targetPath);
    if (targetStat === null) return null;
    if (targetPath !== null && targetStat !== 'missing') {
      touchedTimesMs.push(targetStat.mtimeMs);
      const adminDir = run(['rev-parse', '--absolute-git-dir'], targetPath);
      const adminStat = adminDir.ok ? statUnlessMissingSync(adminDir.out) : null;
      if (adminStat === null || adminStat === 'missing') return null;
      touchedTimesMs.push(adminStat.mtimeMs);
    }
    if (branch) {
      const commitTime = run(['log', '-1', '--format=%ct', `refs/heads/${branch}`], projectPath);
      const commitTimeMs = commitTime.ok ? parseCommitTimeMs(commitTime.out) : null;
      if (commitTimeMs === null) return null;
      touchedTimesMs.push(commitTimeMs);
    }
    if (touchedTimesMs.length === 0) return null;
    return Math.max(...touchedTimesMs);
  }

  function removeWorktreeByPath({ projectPath, cwd, branch, cause }: RemovalArgs): void {
    const admission = admitRemovalSync({ cause, kind: cwd ? 'worktree' : 'local-branch', projectPath, path: cwd || null, branch: branch || null });
    if (!admission.admitted) return;
    if (cwd) {
      removeWorktreeLinks(cwd);
      if (isWorktreeHiddenFromGuardedSessions(cwd, glimmervoidHomes)) run(['worktree', 'unlock', cwd], projectPath);
      run(['worktree', 'remove', '--force', cwd], projectPath);
      if (!fs.existsSync(cwd)) void opts.ownedPaths?.forget(cwd);
    }
    if (branch) run(['branch', '-D', branch], projectPath);
    pruneWorktreeEntries(projectPath);
  }

  function pruneWorktreeEntries(projectPath: string): void {
    const listed = run(['worktree', 'list', '--porcelain'], projectPath);
    for (const lockedPath of listed.ok ? listOwnLockedWorktreePaths(listed.out, glimmervoidHomes) : []) {
      if (fs.existsSync(lockedPath) || !fs.existsSync(glimmervoidHome)) continue;
      run(['worktree', 'unlock', lockedPath], projectPath);
    }
    run(['worktree', 'prune'], projectPath);
  }

  return { listSessionWorktrees, removeWorktreeByPath };
}

function resolveRemovalGuard(guard: RemovalGuardOptions | undefined, glimmervoidHome: string): Required<RemovalGuardOptions> {
  return {
    protectedSessionIds: guard?.protectedSessionIds ?? (() => new Set<string>()),
    journalPath: guard?.journalPath ?? removalsJournalPath(glimmervoidHome),
    now: guard?.now ?? Date.now,
  };
}

function removalOwnershipFacts(target: RemovalTarget, ledgerOwner: string | null, protectedSessionIds: ReadonlySet<string>): RemovalOwnershipFacts {
  return {
    cause: target.cause,
    sessionId: target.branch === null ? null : sessionIdFromBranch(target.branch),
    ledgerOwnerSessionId: sessionIdFromOwner(ledgerOwner),
    protectedSessionIds,
  };
}

function buildRemovalRecord(target: RemovalTarget, facts: RemovalOwnershipFacts, checksPassed: string[], nowMs: number): RemovalRecord {
  return {
    ts: nowMs,
    cause: target.cause,
    kind: target.kind,
    path: target.path,
    branch: target.branch,
    projectPath: target.projectPath,
    sessionId: facts.sessionId ?? facts.ledgerOwnerSessionId,
    checksPassed,
    pid: process.pid,
  };
}

function describeRemovalTarget(target: RemovalTarget): string {
  return target.path ?? `${target.kind} ${target.branch ?? ''}`;
}

function keptRemovalResult(reason: string): QueuedGitResult {
  return { ok: false, out: '', err: `the removal guard kept it: ${reason}`, removalKept: reason };
}

function parseCommitTimeMs(commitTimeOutput: string): number | null {
  const commitSeconds = Number.parseInt(commitTimeOutput, 10);
  if (!Number.isFinite(commitSeconds)) return null;
  return commitSeconds * 1000;
}

async function statUnlessMissing(targetPath: string): Promise<fs.Stats | 'missing' | null> {
  return fsp.stat(targetPath).then((stats) => stats, (error: unknown) => (isMissingFileError(error) ? 'missing' : null));
}

function statUnlessMissingSync(targetPath: string): fs.Stats | 'missing' | null {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    return isMissingFileError(error) ? 'missing' : null;
  }
}

function removeWorktreeLinks(wtDir: string | null | undefined): void {
  if (!wtDir) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(wtDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const p = path.join(wtDir, e.name);
    try { fs.rmSync(p, { recursive: false, force: true }); }
    catch { try { fs.rmdirSync(p); } catch {} }
  }
}

async function populateWorktree(projectPath: string, wtDir: string, shareList: string[]): Promise<void> {
  for (const rel of shareList) {
    if (!rel || String(rel).includes('..')) continue;
    const src = path.join(projectPath, rel);
    const dst = path.join(wtDir, rel);
    try {
      const srcStat = await fsp.stat(src).catch(() => null);
      if (!srcStat) continue;
      const dstExists = await fsp.access(dst).then(() => true, (error: unknown) => !isMissingFileError(error, { includeNotDir: false }));
      if (dstExists) continue;
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (srcStat.isDirectory()) {
        if (process.platform === 'win32') {
          await execFileAsync('cmd', ['/c', 'mklink', '/J', dst, src]);
          continue;
        }
        await fsp.symlink(src, dst, 'dir');
        continue;
      }
      await fsp.copyFile(src, dst);
    } catch {}
  }
}

type GitWorkspaceInstance = ReturnType<typeof createGitWorkspace>;

export { createGitWorkspace, createGitWorkspaceSync };
export type { GitWorkspaceInstance, SessionWorktree, WorkspaceHandle, WorktreeArgs };
