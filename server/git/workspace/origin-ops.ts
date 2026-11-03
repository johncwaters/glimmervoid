import { matchedPrefix, usablePrefixes } from '../../core/branch-gc-core.ts';
import { FETCHED_NOTES_REF_PREFIX, NOTES_COMMIT_IDENTITY, NOTES_REF_PREFIX } from '../../core/commit-session-core.ts';
import type { RemoteBranchTip } from '../../core/branch-gc-core.ts';
import { GIT_FETCH_TIMEOUT_MS, parseLeftRightCount, decideBranchSyncState, decideResyncAction, buildResyncCommand, firstGitErrorLine } from '../../core/branch-sync-core.ts';
import { DEFAULT_BRANCH_FALLBACKS, decideMarkerBase, defaultBranchFromRemoteHead, markerProbeCommands } from '../../core/integration-branch-core.ts';
import type { MarkerProbes } from '../../core/integration-branch-core.ts';
import { REMOTE_BRANCH_LISTING_MAX_BUFFER, REMOTE_REF_PREFIX, UNPROBED_MARKER, errResult, errorExitCode, markerFrom, markerKey, okResult, parseWorktreeBranches } from './workspace-context.ts';
import type { BaseClassification, BaseSyncResult, GitExtraOptions, GitResult, GitWorkspaceContext, IntegrationTip, ResolvedMarkerBase, WorktreeArgs } from './workspace-context.ts';

function createOriginOps(context: GitWorkspaceContext) {
  const { git, run, log, provenanceNotesRef } = context;
  const { listWorktreePorcelain } = context.worktrees;

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

  async function classifyBaseAgainstOrigin(projectPath: string, branch: string, localRef: string = branch): Promise<BaseClassification> {
    const upstream = `origin/${branch}`;
    const remoteBranch = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], projectPath);
    if (!remoteBranch.ok) return { state: 'no-upstream', upstream };
    const counts = parseLeftRightCount((await run([
      'rev-list', '--left-right', '--count', `${upstream}...${localRef}`,
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

  async function pushBaseToOrigin(projectPath: string, branch: string): Promise<{ pushed: boolean; warning: string | null }> {
    if (!(await hasOriginRemote(projectPath))) return { pushed: false, warning: null };
    const classified = await classifyBaseAgainstOrigin(projectPath, branch);
    if (classified.state === 'diverged') {
      return { pushed: false, warning: `Merged into ${branch}, but origin/${branch} moved on, so it was not pushed. Resync ${branch} with origin/${branch} by hand.` };
    }
    const decision = decideResyncAction(classified.state, false);
    const command = buildResyncCommand(decision, {
      upstream: classified.upstream, branch, remote: 'origin',
    });
    if (!command) return { pushed: false, warning: null };
    const pushed = (await run(command.args, projectPath, {
      timeout: command.timeoutMs,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })).ok;
    if (!pushed) return { pushed, warning: `Merged into ${branch}, but origin refused the push, so origin/${branch} does not have it yet. Resync the base branch to push it.` };
    await pushProvenanceNotes(projectPath);
    return { pushed, warning: null };
  }

  async function pushProvenanceNotes(projectPath: string): Promise<void> {
    const notesRef = await provenanceNotesRef(projectPath).catch(() => null);
    if (!notesRef) return;
    const hasNotes = await run(['rev-parse', '--verify', '--quiet', notesRef], projectPath);
    if (!hasNotes.ok) return;
    const originCopyRef = `${FETCHED_NOTES_REF_PREFIX}${notesRef.slice(NOTES_REF_PREFIX.length)}`;
    const fetchedOriginCopy = await run(['fetch', '--quiet', '--no-tags', 'origin', `+${notesRef}:${originCopyRef}`], projectPath, {
      timeout: GIT_FETCH_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    if (fetchedOriginCopy.ok) await run(['notes', '--ref', notesRef, 'merge', '--quiet', '-s', 'theirs', originCopyRef], projectPath, { env: NOTES_COMMIT_IDENTITY });
    const pushedNotes = await run(['push', '--no-verify', 'origin', `${notesRef}:${notesRef}`], projectPath, {
      timeout: GIT_FETCH_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
    if (!pushedNotes.ok) log.warn(`[git-workspace] could not push the shared commit notes to origin: ${firstGitErrorLine(pushedNotes.err || pushedNotes.out)}`);
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
    const listed = await listWorktreePorcelain(projectPath);
    if (!listed.ok) return listed;
    const isCheckedOut = parseWorktreeBranches(listed.out).some((entry) => entry.branch === branchName);
    if (isCheckedOut) return { ok: false, out: '', err: `${mismatch}, and it is checked out in a worktree` };
    const updated = await run(['update-ref', `refs/heads/${branchName}`, originSha, localSha], projectPath);
    if (!updated.ok) return updated;
    return okResult(originSha);
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

  return { detectDefaultBranch, migrateMarkerBase, classifyBaseAgainstOrigin, hasOriginRemote, originUrl, synchronizeBaseWithOrigin, pushBaseToOrigin, pushProvenanceNotes, ensureLocalBranch, fetchOriginBody, seedBranchFromOriginBody, isAncestor, listRemoteBranches, listIntegrationTips };
}

type OriginOps = ReturnType<typeof createOriginOps>;

export { createOriginOps };
export type { OriginOps };
