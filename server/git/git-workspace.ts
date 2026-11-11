import { COHERENCE_BOOKKEEPING_PATHSPEC } from '../coherence/core/coherence-paths-core.ts';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GIT_CONFIG_LISTING_ARGS, buildHardenedGitInvocation } from './core/git-invocation-core.ts';
import type { GitIsolationOptions } from './core/git-invocation-core.ts';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync, execFileSync } from '../child-process-safe.ts';
import { createKeyedSerialQueue, isQueueAdmissionTimeout, queueAdmissionTimeoutError } from '../spawn-gate.ts';
import { sessionIdFromBranch } from '../core/branch-gc-core.ts';
import { comparableDirectoryPath, isSameDirectoryPath } from '../../shared/canonical-paths.ts';
import { sanitizeWorktreeName } from '../../shared/paths.ts';
import { DEFAULT_BRANCH_FALLBACKS, decideMarkerBase, defaultBranchFromRemoteHead, markerProbeCommands, originTrackingRefProbe, unlandedCommitCountArgs } from '../core/integration-branch-core.ts';
import type { MarkerProbes } from '../core/integration-branch-core.ts';
import { normalizeSha } from '../core/update-core.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { runGit } from './git-exec.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import type { OwnedPathEntry, OwnedPathOwner } from '../../shared/contracts/owned-paths.ts';
import type { RemovalRecord } from '../../shared/contracts/removal-record.ts';
import { expandShareList } from '../core/share-list-core.ts';
import { decideRemovalKeep, isRecencyProbeNeeded, sessionIdFromOwner } from '../core/removal-guard-core.ts';
import type { RemovalOwnershipFacts } from '../core/removal-guard-core.ts';
import { appendRemovalRecord, appendRemovalRecordSync, removalsJournalPath } from '../removal-journal.ts';
import { GLIMMERVOID_WORKTREE_LOCK_REASON, isWorktreeHiddenFromGuardedSessions, listHomeWorktreePathsMissingLock, listOwnLockedWorktreePaths } from './core/worktree-lock-core.ts';
import { UNPROBED_MARKER, directoryExists, errResult, errorExitCode, findWorktreeForBranch, hasWorkFrom, isDirtyResult, mainWorktreePath, markerFrom, markerKey, okResult, parseWorktreeBranches } from './workspace/workspace-context.ts';
import type { GitExtraOptions, GitResult, GitRunner, GitWorkspaceContext, OwnedPathsRecorder, OwnedWorktreeArgs, ProjectGitRunner, QueuedGitResult, RemovalAdmission, RemovalArgs, RemovalGuardOptions, RemovalTarget, ResetKeepArgs, ResolvedMarkerBase, RetiredShareLinks, SessionWorktree, StageDetachedWorktreeArgs, WorkspaceHandle, WorktreeArgs, WorktreeBranch, WorktreeDirtyProbe, WorktreeOwnership } from './workspace/workspace-context.ts';
import { createOriginOps } from './workspace/origin-ops.ts';
import { createRebaseOps } from './workspace/rebase-ops.ts';
import { createProbeOps } from './workspace/probe-ops.ts';
import { createIntegrationOps } from './workspace/integration-ops.ts';
import { clock } from '../../shared/clock.ts';

const fsp = fs.promises;

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

function comparableGlimmervoidHomes(glimmervoidHome: string): string[] {
  try {
    return [glimmervoidHome, fs.realpathSync(glimmervoidHome)];
  } catch {
    return [glimmervoidHome];
  }
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

async function readGitPointerFile(filePath: string): Promise<string | null> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return fs.promises.readFile(filePath, 'utf8').catch(() => null);
}

async function gitCommonDirectoryKey(queuedPath: string): Promise<string> {
  let directory = await comparableDirectoryPath(queuedPath);
  for (;;) {
    const dotGit = path.join(directory, '.git');
    const dotGitStat = await fs.promises.stat(dotGit).catch(() => null);
    if (dotGitStat?.isDirectory()) return comparableDirectoryPath(dotGit);
    const adminDirectory = (await readGitPointerFile(dotGit))?.match(/^gitdir: (.+)$/m)?.[1]?.trim();
    if (adminDirectory) {
      const adminPath = path.resolve(directory, adminDirectory);
      const commonDirectory = (await readGitPointerFile(path.join(adminPath, 'commondir')))?.trim();
      return comparableDirectoryPath(commonDirectory ? path.resolve(adminPath, commonDirectory) : adminPath);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return comparableDirectoryPath(queuedPath);
    directory = parent;
  }
}

function keyReadBefore(keyRead: Promise<string>, admissionTimeoutMs: number | undefined): Promise<string> {
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  const admissionExpired = admissionTimeoutMs === undefined ? [] : [new Promise<never>((_resolve, reject) => {
    admissionTimer = setTimeout(() => reject(queueAdmissionTimeoutError()), admissionTimeoutMs);
  })];
  return Promise.race([keyRead, ...admissionExpired]).finally(() => clearTimeout(admissionTimer));
}

function createGitWorkspace(opts: {
  git?: GitRunner;
  mkdtemp?: (prefix: string) => string;
  rerere?: boolean;
  log?: Pick<Console, 'warn'>;
  isolation?: GitIsolationOptions;
  glimmervoidHome?: string;
  ownedPaths?: OwnedPathsRecorder;
  removalGuard?: RemovalGuardOptions;
  provenanceNotesRef?: (projectPath: string) => Promise<string | null>;
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

  const queueByRepository = createKeyedSerialQueue();
  const isolatedCall = <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>, args: TArgs) => (): Promise<TResult> =>
    isolationContext.run({ ...opts.isolation, ...isolationContext.getStore(), ...args }, () => body(args));
  const queuedPathOf = (args: unknown): string => {
    if (typeof args === 'string') return args;
    if (typeof args !== 'object' || args === null) return '';
    const queuedPath = ['projectPath', 'cwd', 'worktreePath'].map((field) => Reflect.get(args, field)).find((value) => typeof value === 'string');
    return typeof queuedPath === 'string' ? queuedPath : '';
  };
  const repositoryKeyReadByPath = new Map<string, Promise<string>>();
  const repositoryKeyOf = (args: unknown): Promise<string> => {
    const queuedPath = queuedPathOf(args);
    if (!queuedPath) return Promise.resolve('');
    const resolvedPath = path.resolve(queuedPath);
    const pendingKeyRead = repositoryKeyReadByPath.get(resolvedPath);
    if (pendingKeyRead) return pendingKeyRead;
    const keyRead = gitCommonDirectoryKey(queuedPath).finally(() => repositoryKeyReadByPath.delete(resolvedPath));
    repositoryKeyReadByPath.set(resolvedPath, keyRead);
    return keyRead;
  };
  const runInRepositoryQueue = async <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>, args: TArgs, admission: { admissionTimeoutMs?: number } = {}): Promise<TResult> => {
    const admissionDeadlineMs = admission.admissionTimeoutMs === undefined ? undefined : clock.nowMs() + admission.admissionTimeoutMs;
    const repositoryKey = await keyReadBefore(repositoryKeyOf(args), admission.admissionTimeoutMs);
    const remainingAdmission = admissionDeadlineMs === undefined ? {} : { admissionTimeoutMs: Math.max(0, admissionDeadlineMs - clock.nowMs()) };
    return queueByRepository.run(repositoryKey, isolatedCall(body, args), remainingAdmission);
  };
  const serialized = <TArgs, TResult>(body: (args: TArgs) => Promise<TResult>) => (args: TArgs): Promise<TResult> => runInRepositoryQueue(body, args);
  const admitted = <TArgs extends { admissionTimeoutMs?: number }, TResult>(
    body: (args: TArgs) => Promise<TResult>,
    refuse: (args: TArgs) => TResult,
  ) => async (args: TArgs): Promise<TResult> => {
    const admission = args.admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs: args.admissionTimeoutMs };
    try {
      return await runInRepositoryQueue(body, args, admission);
    } catch (error) {
      if (!isQueueAdmissionTimeout(error)) throw error;
      return refuse(args);
    }
  };

  async function run(args: string[], cwd: string, extra?: GitExtraOptions): Promise<GitResult> {
    try { return okResult(await git(args, cwd, extra)); }
    catch (err) { return errResult(err); }
  }

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
    const commitRef = await resolveTouchCommitRef({ projectPath, path: targetPath, branch, tipSha });
    if (commitRef === null && branch) return null;
    if (commitRef !== null) {
      const commitTime = await run(['log', '-1', '--format=%ct', commitRef], projectPath);
      const commitTimeMs = commitTime.ok ? parseCommitTimeMs(commitTime.out) : null;
      if (commitTimeMs === null) return null;
      touchedTimesMs.push(commitTimeMs);
    }
    if (touchedTimesMs.length === 0) return null;
    return Math.max(...touchedTimesMs);
  }

  async function resolveTouchCommitRef({ projectPath, path: targetPath, branch, tipSha }: Pick<RemovalTarget, 'projectPath' | 'path' | 'branch' | 'tipSha'>): Promise<string | null> {
    if (tipSha) return tipSha;
    const branchRef = `refs/heads/${branch}`;
    if (branch && (await run(['rev-parse', '--verify', '-q', branchRef], projectPath)).ok) return branchRef;
    if (targetPath === null) return null;
    const head = await run(['rev-parse', '--verify', '-q', 'HEAD'], targetPath);
    return head.ok ? head.out : null;
  }

  async function listOwnedPaths(owner: OwnedPathOwner): Promise<OwnedPathEntry[]> {
    return (await opts.ownedPaths?.entriesOwnedBy?.(owner)) ?? [];
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
  async function createBody({
    projectPath,
    owner,
    teamId,
    label,
    baseBranch = null,
    configuredIntegrationBranch = null,
    forkFromHead = false,
    startSha = null,
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
    const branchSha = ref.ok ? ref.out : await ensureLocalBranch(projectPath, base);
    const pinnedStart = startSha ? await run(['rev-parse', '--verify', '--quiet', `${startSha}^{commit}`], projectPath) : null;
    if (pinnedStart && !pinnedStart.ok) return { cwd: projectPath, isGit: false, reason: 'no-start-commit' };
    const baseSha = pinnedStart ? pinnedStart.out : branchSha;
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
    if (!wtDir) return;
    const expandedShareList = await expandShareListIn(projectPath, shareList);
    const projectRealPath = await fs.promises.realpath(projectPath).catch(() => null);
    if (projectRealPath) removeWorktreeLinks(wtDir, { projectRealPath, shareList: expandedShareList });
    if (!expandedShareList.length) return;
    const ignored: string[] = [];
    for (const rel of expandedShareList) {
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

  function runUntrusted(args: string[], cwd: string, { disableHooks, disableRepoCommands, replaceEnv }: GitIsolationOptions): Promise<GitResult> {
    const hooklessArgs = disableHooks ? ['-c', `core.hooksPath=${os.devNull}`, ...args] : args;
    return run(hooklessArgs, cwd, { replaceEnv, disableRepoCommands });
  }

  async function removeWorktreeByPathBody({ projectPath, cwd, branch, cause, disableHooks, replaceEnv, requiresUntouchedFloor }: RemovalArgs): Promise<QueuedGitResult> {
    const admission = await admitRemoval({ cause, kind: cwd ? 'worktree' : 'local-branch', projectPath, path: cwd || null, branch: branch || null, requiresUntouchedFloor });
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
    for (const rel of await expandShareListIn(wtDir, shareList)) {
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

  async function stageDetachedWorktreeBody({ projectPath, worktreePath, sha, owner, disableHooks, replaceEnv }: StageDetachedWorktreeArgs): Promise<GitResult> {
    if (!worktreePath) return { ok: false, out: '', err: 'a detached worktree needs a path' };
    if (normalizeSha(sha) !== sha) return { ok: false, out: '', err: 'a detached worktree sha must be 40 lowercase hexadecimal characters' };
    return addWorktreeEntry((args) => runUntrusted(args, projectPath, { disableHooks, replaceEnv }), worktreePath, ['--detach', worktreePath, sha], { owner, projectPath, branch: null });
  }

  async function deleteRemoteBranchBody({ projectPath, name, tipSha, cause }: RemovalArgs): Promise<QueuedGitResult> {
    const admission = await admitRemoval({ cause, kind: 'remote-branch', projectPath, path: null, branch: name ?? null, tipSha: tipSha ?? null });
    if (!admission.admitted) return keptRemovalResult(admission.reason);
    const branchRef = `refs/heads/${name ?? ''}`;
    return run(['push', '--no-verify', 'origin', `--force-with-lease=${branchRef}:${tipSha ?? ''}`, `:${branchRef}`], projectPath);
  }

  const context: GitWorkspaceContext = {
    git, run, runInProject, runUntrusted, log, rerereEnabled, serialized, admitted,
    provenanceNotesRef: opts.provenanceNotesRef ?? (() => Promise.resolve(null)),
    worktrees: { listWorktreePorcelain: (projectPath) => run(['worktree', 'list', '--porcelain'], projectPath), lockReusedHomeWorktrees, tearDownWorktree },
  };
  const origin = createOriginOps(context);
  const rebase = createRebaseOps(context, origin);
  const probe = createProbeOps(context, origin);
  const integration = createIntegrationOps(context, origin, rebase);
  const { detectDefaultBranch, migrateMarkerBase, originUrl, ensureLocalBranch, fetchOriginBody, fetchOriginCommitBody, seedBranchFromOriginBody, isAncestor, listRemoteBranches, listIntegrationTips } = origin;
  const { mergeBackBody, mergeKeepBody, rebaseOnlyBody, resolveRebaseTarget } = rebase;
  const { describeWorkspaceMemberWorkBody, hasUnmergedWorkBody, listWorktreesBody, listSessionWorktreesBody, probeWorktreeDirtyBody } = probe;
  const { checkoutDetachedBody, stageIsolatedCheckout, mergeFastForwardTo, resetKeepToBody, syncIntegrationBranchBody, resolveMergeProbeEnv, writeMergedTree, treeOid } = integration;

  return {
    withGitIsolation: <T>(isolation: GitIsolationOptions, operation: () => T): T => isolationContext.run(isolation, operation),
    create: serialized(createBody),
    ensureWorkspaceMember: serialized(ensureWorkspaceMemberBody),
    removeWorkspaceMember: serialized(removeWorkspaceMemberBody),
    listOwnedPaths,
    discard: serialized(discardBody),
    mergeBack: serialized(mergeBackBody),
    mergeKeep: serialized(mergeKeepBody),
    rebaseOnly: serialized(rebaseOnlyBody),
    resolveRebaseTarget,
    populate: serialized(populateShare),
    originUrl: serialized(originUrl),
    pushProvenanceNotes: serialized(origin.pushProvenanceNotes),
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
    fetchOriginCommit: serialized(fetchOriginCommitBody),
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
    const commitRef = resolveTouchCommitRefSync({ projectPath, path: targetPath, branch });
    if (commitRef === null && branch) return null;
    if (commitRef !== null) {
      const commitTime = run(['log', '-1', '--format=%ct', commitRef], projectPath);
      const commitTimeMs = commitTime.ok ? parseCommitTimeMs(commitTime.out) : null;
      if (commitTimeMs === null) return null;
      touchedTimesMs.push(commitTimeMs);
    }
    if (touchedTimesMs.length === 0) return null;
    return Math.max(...touchedTimesMs);
  }

  function resolveTouchCommitRefSync({ projectPath, path: targetPath, branch }: Pick<RemovalTarget, 'projectPath' | 'path' | 'branch'>): string | null {
    const branchRef = `refs/heads/${branch}`;
    if (branch && run(['rev-parse', '--verify', '-q', branchRef], projectPath).ok) return branchRef;
    if (targetPath === null || !fs.existsSync(targetPath)) return null;
    const head = run(['rev-parse', '--verify', '-q', 'HEAD'], targetPath);
    return head.ok ? head.out : null;
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
    now: guard?.now ?? clock.nowMs,
  };
}

function removalOwnershipFacts(target: RemovalTarget, ledgerOwner: string | null, protectedSessionIds: ReadonlySet<string>): RemovalOwnershipFacts {
  return {
    cause: target.cause,
    sessionId: target.branch === null ? null : sessionIdFromBranch(target.branch),
    ledgerOwnerSessionId: sessionIdFromOwner(ledgerOwner),
    protectedSessionIds,
    requiresUntouchedFloor: target.requiresUntouchedFloor === true,
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

async function expandShareListIn(directory: string, shareList: string[] | null | undefined): Promise<string[]> {
  if (!shareList?.length) return [];
  return expandShareList(shareList, await fsp.readdir(directory).catch(() => []));
}

function isRetiredShareLink(linkPath: string, name: string, keep: RetiredShareLinks): boolean {
  if (keep.shareList.includes(name)) return false;
  try { return fs.realpathSync.native(linkPath) === path.join(keep.projectRealPath, name); } catch { return false; }
}

function removeWorktreeLinks(wtDir: string | null | undefined, keep?: RetiredShareLinks): void {
  if (!wtDir) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(wtDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const p = path.join(wtDir, e.name);
    if (keep && !isRetiredShareLink(p, e.name, keep)) continue;
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
