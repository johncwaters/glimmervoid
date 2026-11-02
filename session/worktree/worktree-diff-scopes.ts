import type { RunGitOptions } from "../../server/git/git-exec.ts";
import { errorMessage } from "../../shared/text.ts";
import fs from "node:fs";
import path from "node:path";
import { decideDiffSelfHeal } from "../core/merge-gate.ts";
import type { WorkspaceMember } from "../core/workspace-core.ts";
import { branchFromHeadRef, branchFromRemoteRef, isOwnRemoteCopy, prefixRenameAndCopyHeaders } from "./worktree-lifecycle-context.ts";
import type { ChangeScope, DiffSection, MemberDiff, WorktreeLifecycleContext } from "./worktree-lifecycle-context.ts";

function createWorktreeDiffScopes(context: WorktreeLifecycleContext) {
  const { id, lifecycleState, currentProjectPath, gitOut, gitLookup, readUpstreamOf, effectiveIntegrationBranch, setMergeStatus } = context;

  async function resolveEffectiveBase(opts: RunGitOptions): Promise<string | null> {
    if (lifecycleState.workspace?.base) {
      lifecycleState.effectiveBase = lifecycleState.workspace.base;
      return lifecycleState.effectiveBase;
    }
    const branch = branchFromHeadRef((await gitLookup(["symbolic-ref", "--quiet", "HEAD"], opts))?.trim() ?? "");
    const upstream = branch ? await readUpstreamOf(branch, opts) : null;
    if (upstream && !isOwnRemoteCopy(upstream, branch)) {
      lifecycleState.effectiveBase = branchFromRemoteRef(upstream);
      return upstream;
    }
    lifecycleState.effectiveBase = effectiveIntegrationBranch();
    return lifecycleState.effectiveBase;
  }

  async function resolveVerifiedBaseRef(opts: RunGitOptions): Promise<{ ref: string; verified: true } | { ref: string | null; verified: false }> {
    const candidate = await resolveEffectiveBase(opts);
    if (candidate && await gitLookup(["rev-parse", "--verify", "--quiet", candidate], opts) !== null) return { ref: await freshestBaseRef(candidate, opts), verified: true };
    return { ref: lifecycleState.baseSha || null, verified: false };
  }

  async function freshestBaseRef(baseBranch: string, opts: RunGitOptions): Promise<string> {
    const localRef = `refs/heads/${baseBranch}`;
    const originRef = `refs/remotes/origin/${baseBranch}`;
    const existingRefs = (await gitOut(["for-each-ref", "--format=%(refname)", localRef, originRef], opts)).split("\n");
    if (!existingRefs.includes(localRef) || !existingRefs.includes(originRef)) return baseBranch;
    const isLocalBehindOrigin = await gitLookup(["merge-base", "--is-ancestor", localRef, originRef], opts) !== null;
    return isLocalBehindOrigin ? `origin/${baseBranch}` : baseBranch;
  }

  function diffGitOptions(cwd: string): RunGitOptions {
    return { cwd, timeoutMs: 15000, maxBuffer: 64 * 1024 * 1024 };
  }

  async function resolveDiffBase(opts: RunGitOptions): Promise<{ base: string; aheadCount: string; ref: string | null; verified: boolean }> {
    const { ref: baseRef, verified } = await resolveVerifiedBaseRef(opts);
    if (verified) {
      return {
        base: (await gitLookup(["merge-base", baseRef, "HEAD"], opts))?.trim() ?? "",
        aheadCount: (await gitOut(["rev-list", "--count", `${baseRef}..HEAD`], opts)).trim(),
        ref: baseRef,
        verified,
      };
    }
    if (!baseRef) return { base: "", aheadCount: "0", ref: null, verified };
    return { base: baseRef, aheadCount: (await gitOut(["rev-list", "--count", `${baseRef}..HEAD`], opts)).trim(), ref: null, verified };
  }

  async function readChangeScope(name: string, root: string, base: string, sessionPathPrefix: string): Promise<ChangeScope> {
    const run = (args: string[]): Promise<string> => gitOut(args, diffGitOptions(root));
    const nul = String.fromCharCode(0);
    const trackedNameStatus = await run(["diff", "-z", "--name-status", "-M", "HEAD"]);
    const untrackedPaths = (await run(["ls-files", "-z", "--others", "--exclude-standard"])).split(nul).filter(Boolean);
    return {
      name,
      root,
      sessionPathPrefix,
      base: base || null,
      committedNameStatus: base ? await run(["diff", "-z", "--name-status", "-M", `${base}..HEAD`]) : "",
      uncommittedNameStatus: trackedNameStatus + untrackedPaths.map((untrackedPath) => `?${nul}${untrackedPath}${nul}`).join(""),
    };
  }

  async function memberMergeBase(member: WorkspaceMember): Promise<{ ref: string | null; sha: string }> {
    const opts = diffGitOptions(member.dir);
    const candidates = member.base ? [await freshestBaseRef(member.base, opts), `origin/${member.base}`, "origin/HEAD"] : ["origin/HEAD"];
    for (const candidate of candidates) {
      if (await gitLookup(["rev-parse", "--verify", "--quiet", candidate], opts) === null) continue;
      return { ref: candidate, sha: (await gitLookup(["merge-base", candidate, "HEAD"], opts))?.trim() ?? "" };
    }
    return { ref: null, sha: "" };
  }

  async function getChangeScopes(): Promise<ChangeScope[]> {
    const members = lifecycleState.provisionedMembers;
    if (members) {
      const scopes: ChangeScope[] = [];
      for (const member of members) {
        const memberDirStats = await fs.promises.stat(member.dir).catch(() => null);
        if (!memberDirStats?.isDirectory()) continue;
        scopes.push(await readChangeScope(member.name, member.dir, (await memberMergeBase(member)).sha, `${member.name}/`));
      }
      return scopes;
    }
    const worktreeDir = lifecycleState.worktreeDir;
    if (!worktreeDir) return [];
    const { base } = await resolveDiffBase(diffGitOptions(worktreeDir));
    return [await readChangeScope(path.basename(currentProjectPath()), worktreeDir, base, "")];
  }

  async function readMemberDiff(member: WorkspaceMember): Promise<MemberDiff> {
    const run = (args: string[]): Promise<string> => gitOut(args, diffGitOptions(member.dir));
    const prefixArgs = [`--src-prefix=a/${member.name}/`, `--dst-prefix=b/${member.name}/`];
    await markUntrackedIntentToAdd(member.dir);
    const { ref: baseRef, sha: base } = await memberMergeBase(member);
    const aheadCount = base ? (await run(["rev-list", "--count", `${base}..HEAD`])).trim() : "0";
    const readPrefixedDiff = async (range: string): Promise<string> => prefixRenameAndCopyHeaders(await run(["diff", ...prefixArgs, range]), member.name);
    return {
      name: member.name,
      committed: base
        ? { stat: (await run(["diff", "--stat", `${base}..HEAD`])).trim(), diff: await readPrefixedDiff(`${base}..HEAD`) }
        : { stat: "", diff: "" },
      uncommitted: { stat: (await run(["diff", "--stat", "HEAD"])).trim(), diff: await readPrefixedDiff("HEAD") },
      hasCommits: aheadCount !== "" && aheadCount !== "0",
      baseRef,
      baseSha: base,
    };
  }

  async function getWorkspaceDiff(members: WorkspaceMember[]) {
    const memberDiffs: MemberDiff[] = [];
    for (const member of members) {
      const memberDirStats = await fs.promises.stat(member.dir).catch(() => null);
      if (!memberDirStats?.isDirectory()) continue;
      memberDiffs.push(await readMemberDiff(member));
    }
    const joinSection = (section: "committed" | "uncommitted"): DiffSection => ({
      stat: memberDiffs.filter((memberDiff) => memberDiff[section].stat).map((memberDiff) => `${memberDiff.name}/\n${memberDiff[section].stat}`).join("\n"),
      diff: memberDiffs.map((memberDiff) => memberDiff[section].diff).join(""),
    });
    return {
      committed: joinSection("committed"),
      uncommitted: joinSection("uncommitted"),
      hasCommits: memberDiffs.some((memberDiff) => memberDiff.hasCommits),
      bases: memberDiffs
        .filter((memberDiff) => memberDiff.baseSha)
        .map((memberDiff) => ({ member: memberDiff.name, ref: memberDiff.baseRef, sha: memberDiff.baseSha, verified: true })),
    };
  }

  async function markUntrackedIntentToAdd(dir: string): Promise<void> {
    try {
      await gitOut(["add", "-N", "--", "."], diffGitOptions(dir));
    } catch (error) {
      console.warn(`[session ${id}] intent-to-add in ${dir} failed: ${errorMessage(error)}`);
    }
  }

  async function getDiff() {
    const empty = { stat: "", diff: "" };
    if (lifecycleState.provisionedMembers) return getWorkspaceDiff(lifecycleState.provisionedMembers);
    if (!lifecycleState.worktreeDir) return { committed: empty, uncommitted: empty, hasCommits: false, bases: [] };
    const opts = diffGitOptions(lifecycleState.worktreeDir);
    const run = (args: string[]): Promise<string> => gitOut(args, opts);
    await markUntrackedIntentToAdd(lifecycleState.worktreeDir);
    const { base, aheadCount, ref, verified } = await resolveDiffBase(opts);
    const committed = base
      ? { stat: (await run(["diff", "--stat", `${base}..HEAD`])).trim(), diff: await run(["diff", `${base}..HEAD`]) }
      : empty;
    const uncommitted = { stat: (await run(["diff", "--stat", "HEAD"])).trim(), diff: await run(["diff", "HEAD"]) };
    const healed = decideDiffSelfHeal(lifecycleState.mergeStatus, committed.diff, uncommitted.diff);
    if (healed) setMergeStatus(healed);
    const bases = base ? [{ member: null, ref, sha: base, verified }] : [];
    return { committed, uncommitted, hasCommits: aheadCount !== "" && aheadCount !== "0", bases };
  }

  return { resolveEffectiveBase, resolveVerifiedBaseRef, diffGitOptions, getChangeScopes, getDiff };
}

export { createWorktreeDiffScopes };
