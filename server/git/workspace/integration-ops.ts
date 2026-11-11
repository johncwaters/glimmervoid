import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstGitErrorLine } from '../../core/branch-sync-core.ts';
import { decideIntegrationSync, classifyRefusedIntegrationSync } from '../../core/integration-sync-core.ts';
import { MERGE_DRIVER_KEY_PATTERN, driverEnumerationEnv, mergeProbeEnv, neutralGitConfigEnv } from '../../core/merge-proof-core.ts';
import type { MergeProbeEnvResult } from '../../core/merge-proof-core.ts';
import type { BaseAncestry, CheckoutTreeState } from '../../core/integration-sync-core.ts';
import { normalizeSha } from '../../core/update-core.ts';
import { isMissingFileError } from '../../../shared/text.ts';
import { ISOLATED_CHECKOUT_BASE_REF, ISOLATED_CHECKOUT_HYDRATE_TIMEOUT_MS, ISOLATED_CHECKOUT_REVIEW_REF, MERGE_PROBE_TIMEOUT_MS, WORKTREE_STATUS_ARGS, errResult, errorExitCode, findWorktreeForBranch, okResult } from './workspace-context.ts';
import type { CheckoutDetachedArgs, GitResult, GitWorkspaceContext, IntegrationSyncResult, MergeFastForwardArgs, MergeFastForwardResult, MergeProbeEnvArgs, MergeTreeArgs, MergeTreeProbe, QueuedGitResult, ResetKeepArgs, StageIsolatedCheckoutArgs, WorktreeArgs } from './workspace-context.ts';
import type { OriginOps } from './origin-ops.ts';
import type { RebaseOps } from './rebase-ops.ts';
import { clock } from '../../../shared/clock.ts';

const fsp = fs.promises;
const INTEGRATION_SYNC_FETCH_BUDGET_MS = 15_000;
const GIT_LS_REMOTE_TIMEOUT_MS = 15_000;
const MIN_INTEGRATION_SYNC_STEP_MS = 1_000;
const LS_REMOTE_NO_MATCHING_REF_EXIT_CODE = 2;

function createIntegrationOps(context: GitWorkspaceContext, origin: OriginOps, rebase: RebaseOps) {
  const { git, run, runUntrusted, serialized, admitted } = context;
  const { listWorktreePorcelain } = context.worktrees;
  const { hasOriginRemote, isAncestor, fetchOriginBranch, isFetchableBranchName } = origin;
  const { fastForwardTarget } = rebase;

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
    let ancestry: BaseAncestry | null = null;
    if (currentSha && remoteSha && currentSha !== remoteSha) {
      ancestry = (await probeBaseAncestry(projectPath, currentSha, remoteSha)).ancestry;
    }
    const checkout = await readRefusedCheckoutTree(projectPath, branch);
    const { outcome } = classifyRefusedIntegrationSync({ currentSha, remoteSha, ancestry, checkoutTree: checkout.state });
    if (outcome !== 'update-failed') return { outcome, from: currentSha, to: remoteSha };
    return { outcome, from: currentSha, to: remoteSha, error: firstGitErrorLine(err || checkout.error) };
  }

  async function probeBaseAncestry(projectPath: string, localSha: string, remoteSha: string): Promise<{ ancestry: BaseAncestry | null; error: string }> {
    const forward = await isAncestor({ projectPath, ancestorSha: localSha, descendantSha: remoteSha });
    if (!forward.ok) return { ancestry: null, error: forward.err ?? '' };
    if (forward.isAncestor) return { ancestry: 'behind', error: '' };
    const reverse = await isAncestor({ projectPath, ancestorSha: remoteSha, descendantSha: localSha });
    if (reverse.ok && reverse.isAncestor) return { ancestry: 'ahead', error: '' };
    return { ancestry: 'forked', error: '' };
  }

  async function readRefusedCheckoutTree(projectPath: string, branch: string): Promise<{ state: CheckoutTreeState | null; error: string }> {
    const listed = await listWorktreePorcelain(projectPath);
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

  function budgetLeftMs(deadline: number): number {
    return deadline - clock.nowMs();
  }

  async function recoverFailedIntegrationFetch(projectPath: string, branch: string, fetched: GitResult, deadline: number): Promise<GitResult> {
    if (budgetLeftMs(deadline) < MIN_INTEGRATION_SYNC_STEP_MS) return fetched;
    if (!(await isFetchableBranchName(projectPath, branch))) return fetched;
    const presence = await readOriginBranchPresence(projectPath, branch, Math.min(GIT_LS_REMOTE_TIMEOUT_MS, budgetLeftMs(deadline)));
    if (presence === 'missing') return run(['update-ref', '-d', `refs/remotes/origin/${branch}`], projectPath);
    if (presence === 'unknown' || budgetLeftMs(deadline) < MIN_INTEGRATION_SYNC_STEP_MS) return fetched;
    const pruned = await run(['-c', 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*', 'remote', 'prune', 'origin'], projectPath, { timeout: budgetLeftMs(deadline), env: { GIT_TERMINAL_PROMPT: '0' } });
    if (!pruned.ok) return pruned;
    if (budgetLeftMs(deadline) < MIN_INTEGRATION_SYNC_STEP_MS) return fetched;
    return fetchOriginBranch(projectPath, branch, budgetLeftMs(deadline));
  }

  async function readOriginBranchPresence(projectPath: string, branch: string, timeoutMs: number): Promise<'present' | 'missing' | 'unknown'> {
    try {
      await git(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], projectPath, { timeout: timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } });
      return 'present';
    } catch (err) {
      return errorExitCode(err) === LS_REMOTE_NO_MATCHING_REF_EXIT_CODE ? 'missing' : 'unknown';
    }
  }

  async function syncIntegrationBranchBody({ projectPath, branch }: WorktreeArgs): Promise<IntegrationSyncResult> {
    const fetchDeadline = clock.nowMs() + INTEGRATION_SYNC_FETCH_BUDGET_MS;
    if (!(await hasOriginRemote(projectPath))) return { outcome: 'no-remote', from: null, to: null };
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/origin/${branch}`;

    if (budgetLeftMs(fetchDeadline) < MIN_INTEGRATION_SYNC_STEP_MS) return { outcome: 'fetch-failed', from: null, to: null, error: 'integration sync fetch budget spent before the fetch' };
    const fetched = await fetchOriginBranch(projectPath, branch ?? '', budgetLeftMs(fetchDeadline));
    if (!fetched.ok) {
      const recovered = await recoverFailedIntegrationFetch(projectPath, branch ?? '', fetched, fetchDeadline);
      if (!recovered.ok) return { outcome: 'fetch-failed', from: null, to: null, error: firstGitErrorLine(recovered.err || fetched.err || '') };
    }

    const local = await run(['rev-parse', '--verify', '--quiet', localRef], projectPath);
    const remote = await run(['rev-parse', '--verify', '--quiet', remoteRef], projectPath);
    const localSha = local.ok ? local.out : null;
    const remoteSha = remote.ok ? remote.out : null;
    let ancestry: BaseAncestry | null = null;
    let syncError = '';
    let checkedOut = false;
    let checkoutPath: string | null = null;
    let checkoutTree: CheckoutTreeState = 'unknown';
    if (localSha && remoteSha && localSha !== remoteSha) {
      const probe = await probeBaseAncestry(projectPath, localSha, remoteSha);
      ancestry = probe.ancestry;
      syncError = probe.error;
      if (ancestry === 'behind') {
        const listed = await listWorktreePorcelain(projectPath);
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

    const decision = decideIntegrationSync({ localSha, remoteSha, ancestry, checkedOut, checkoutTree });
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

  return { checkoutDetachedBody, stageIsolatedCheckout, mergeFastForwardTo, resetKeepToBody, syncIntegrationBranchBody, resolveMergeProbeEnv, writeMergedTree, treeOid };
}

export { createIntegrationOps };
