import type { RunGitOptions } from "../../server/git/git-exec.ts";
import { withScratchIndex } from "../../server/git/scratch-index.ts";
import { errorMessage } from "../../shared/text.ts";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { DiffBase } from "../../shared/contracts/control/control-fields.ts";
import { diffHeaderPathsOf } from "../../shared/git-text.ts";
import { openContainedFile } from "../../server/contained-file.ts";
import { decideDiffSelfHeal } from "../core/merge-gate.ts";
import type { WorkspaceMember } from "../core/workspace-core.ts";
import { branchFromHeadRef, branchFromRemoteRef, isOwnRemoteCopy, prefixRenameAndCopyHeaders } from "./worktree-lifecycle-context.ts";
import type { ChangeScope, WorktreeLifecycleContext } from "./worktree-lifecycle-context.ts";

const DIFF_TIMEOUT_MS = 15000;
const CHECK_ATTR_BATCH_SIZE = 200;
const MISSING_BLOB_ID = /^0+$/;
const NUL = String.fromCharCode(0);
const DIFF_FILE_CAP_BYTES = 1024 * 1024;
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock", "go.sum",
  "mix.lock", "pubspec.lock", "Podfile.lock", "Package.resolved", "flake.lock", "packages.lock.json", "gradle.lockfile",
]);

interface WorktreeChanges {
  patch: string;
  contentHashByPath: Record<string, string | null>;
  generatedPaths: string[];
}

interface SessionChanges extends WorktreeChanges {
  hasCommits: boolean;
  bases: z.infer<typeof DiffBase>[];
}

interface MemberChanges extends WorktreeChanges {
  name: string;
  hasCommits: boolean;
  baseRef: string | null;
  baseSha: string;
}

function isGeneratedPath(changedPath: string, generatedAttribute: string): boolean {
  if (generatedAttribute === "set" || generatedAttribute === "true") return true;
  if (generatedAttribute === "unset" || generatedAttribute === "false") return false;
  return LOCKFILE_NAMES.has(path.posix.basename(changedPath));
}

interface DiffFileRoot {
  root: string;
  pathPrefix: string;
}

interface DiffFileRequest {
  path: string;
  oldBlobId: string | null;
  newBlobId: string;
}

type DiffFileContents =
  | { ok: true; oldContents: string | null; newContents: string | null }
  | { ok: false; error: string };

const STALE_DIFF_FILE_ERROR = "This file changed after Changes read it; the next diff refresh shows the new version";

function textOrNull(contents: string): string | null {
  return contents.includes(NUL) ? null : contents;
}

interface PatchFileSection {
  path: string;
  oldBlobId: string | null;
  blobId: string | null | undefined;
}

function patchFileSectionsOf(patch: string): PatchFileSection[] {
  const sections: PatchFileSection[] = [];
  for (const line of patch.split("\n")) {
    const headerPaths = diffHeaderPathsOf(line);
    if (headerPaths) {
      sections.push({ path: headerPaths.path, oldBlobId: null, blobId: undefined });
      continue;
    }
    const section = sections.at(-1);
    if (!section || section.blobId !== undefined) continue;
    if (line.startsWith("rename to ")) {
      section.path = line.slice("rename to ".length);
      continue;
    }
    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
    if (!index) continue;
    section.oldBlobId = MISSING_BLOB_ID.test(index[1] ?? "") ? null : index[1] ?? null;
    section.blobId = MISSING_BLOB_ID.test(index[2] ?? "") ? null : index[2] ?? null;
  }
  return sections;
}

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
    return { cwd, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 };
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
    const trackedNameStatus = await run(["diff", "-z", "--name-status", "-M", "HEAD"]);
    const untrackedPaths = (await run(["ls-files", "-z", "--others", "--exclude-standard"])).split(NUL).filter(Boolean);
    return {
      name,
      root,
      sessionPathPrefix,
      base: base || null,
      committedNameStatus: base ? await run(["diff", "-z", "--name-status", "-M", `${base}..HEAD`]) : "",
      uncommittedNameStatus: trackedNameStatus + untrackedPaths.map((untrackedPath) => `?${NUL}${untrackedPath}${NUL}`).join(""),
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

  async function readMemberChanges(member: WorkspaceMember): Promise<MemberChanges> {
    const { ref: baseRef, sha: base } = await memberMergeBase(member);
    const aheadCount = base ? (await gitOut(["rev-list", "--count", `${base}..HEAD`], diffGitOptions(member.dir))).trim() : "0";
    const changes = await readChangesWithUntracked(member.dir, base || "HEAD", member.name);
    return {
      name: member.name,
      ...changes,
      hasCommits: aheadCount !== "" && aheadCount !== "0",
      baseRef,
      baseSha: base,
    };
  }

  async function getWorkspaceDiff(members: WorkspaceMember[]): Promise<SessionChanges> {
    const memberChanges: MemberChanges[] = [];
    for (const member of members) {
      const memberDirStats = await fs.promises.stat(member.dir).catch(() => null);
      if (!memberDirStats?.isDirectory()) continue;
      memberChanges.push(await readMemberChanges(member));
    }
    return {
      patch: memberChanges.map((member) => member.patch).join(""),
      contentHashByPath: Object.assign({}, ...memberChanges.map((member) => member.contentHashByPath)),
      generatedPaths: memberChanges.flatMap((member) => member.generatedPaths),
      hasCommits: memberChanges.some((member) => member.hasCommits),
      bases: memberChanges
        .filter((member) => member.baseSha)
        .map((member) => ({ member: member.name, ref: member.baseRef, sha: member.baseSha, verified: true })),
    };
  }

  async function markUntrackedIntentToAdd(dir: string, scratchOptions: RunGitOptions): Promise<void> {
    try {
      await gitOut(["add", "-N", "--", "."], scratchOptions);
    } catch (error) {
      console.warn(`[session ${id}] intent-to-add in ${dir} failed: ${errorMessage(error)}`);
    }
  }

  async function readGeneratedPaths(changedPaths: string[], options: RunGitOptions): Promise<string[]> {
    const generatedAttributeByPath = new Map<string, string>();
    for (let start = 0; start < changedPaths.length; start += CHECK_ATTR_BATCH_SIZE) {
      const fields = (await gitOut(["check-attr", "-z", "linguist-generated", "--", ...changedPaths.slice(start, start + CHECK_ATTR_BATCH_SIZE)], options)).split(NUL);
      for (let field = 0; field + 2 < fields.length; field += 3) generatedAttributeByPath.set(fields[field] ?? "", fields[field + 2] ?? "");
    }
    return changedPaths.filter((changedPath) => isGeneratedPath(changedPath, generatedAttributeByPath.get(changedPath) ?? "unspecified"));
  }

  async function readWorktreeBlobIds(repoPaths: string[], options: RunGitOptions): Promise<string[]> {
    if (repoPaths.length === 0) return [];
    try {
      return (await gitOut(["hash-object", "--stdin-paths"], { ...options, input: `${repoPaths.join("\n")}\n` })).split("\n").filter(Boolean);
    } catch (error) {
      console.warn(`[session ${id}] hashing renamed files failed: ${errorMessage(error)}`);
      return [];
    }
  }

  async function contentHashesOf(patch: string, pathPrefix: string, options: RunGitOptions): Promise<Record<string, string | null>> {
    const sections = patchFileSectionsOf(patch);
    const unhashedPaths = sections.filter((section) => section.blobId === undefined).map((section) => section.path);
    const worktreeBlobIds = await readWorktreeBlobIds(unhashedPaths.map((unhashedPath) => unhashedPath.slice(pathPrefix.length)), options);
    const worktreeBlobIdByPath = new Map(unhashedPaths.map((unhashedPath, position) => [unhashedPath, worktreeBlobIds[position] ?? null]));
    return Object.fromEntries(sections.map((section) => [section.path, section.blobId === undefined ? worktreeBlobIdByPath.get(section.path) ?? null : section.blobId]));
  }

  async function readChanges(target: string, memberName: string | null, options: RunGitOptions): Promise<WorktreeChanges> {
    const pathPrefix = memberName ? `${memberName}/` : "";
    const prefixArgs = [`--src-prefix=a/${pathPrefix}`, `--dst-prefix=b/${pathPrefix}`];
    const rawPatch = await gitOut(["-c", "core.quotePath=false", "-c", "diff.suppressBlankEmpty=false", "diff", "--no-ext-diff", "--no-color", "--full-index", "-M", ...prefixArgs, target], options);
    const patch = memberName ? prefixRenameAndCopyHeaders(rawPatch, memberName) : rawPatch;
    const changedPaths = (await gitOut(["diff", "--name-only", "-z", "-M", target], options)).split(NUL).filter(Boolean);
    const generatedPaths = (await readGeneratedPaths(changedPaths, options)).map((generatedPath) => `${pathPrefix}${generatedPath}`);
    return { patch, contentHashByPath: await contentHashesOf(patch, pathPrefix, options), generatedPaths };
  }

  async function readChangesWithUntracked(dir: string, target: string, memberName: string | null): Promise<WorktreeChanges> {
    const options = diffGitOptions(dir);
    const scratchRun = await withScratchIndex(dir, DIFF_TIMEOUT_MS, async (scratchIndexEnv) => {
      const scratchOptions = { ...options, env: scratchIndexEnv };
      await markUntrackedIntentToAdd(dir, scratchOptions);
      return readChanges(target, memberName, scratchOptions);
    });
    if (scratchRun.ok) return scratchRun.value;
    console.warn(`[session ${id}] diff in ${dir} leaves out untracked files: ${scratchRun.reason}`);
    return readChanges(target, memberName, options);
  }

  function diffFileRoots(): DiffFileRoot[] {
    const members = lifecycleState.provisionedMembers;
    if (members) return members.map((member) => ({ root: member.dir, pathPrefix: `${member.name}/` }));
    const worktreeDir = lifecycleState.worktreeDir;
    return worktreeDir ? [{ root: worktreeDir, pathPrefix: "" }] : [];
  }

  async function readBaseBlob(fileRoot: DiffFileRoot, blobId: string | null): Promise<string | null> {
    if (blobId === null) return null;
    try {
      const sizeBytes = Number((await gitOut(["cat-file", "-s", blobId], diffGitOptions(fileRoot.root))).trim());
      if (!(sizeBytes <= DIFF_FILE_CAP_BYTES)) return null;
      return textOrNull(await gitOut(["cat-file", "blob", blobId], { ...diffGitOptions(fileRoot.root), trim: false }));
    } catch {
      return null;
    }
  }

  async function readWorktreeFile(fileRoot: DiffFileRoot, repoPath: string): Promise<string | null> {
    const opened = await openContainedFile(path.join(fileRoot.root, repoPath), fileRoot.root);
    if (!opened.ok) return null;
    try {
      if (opened.file.stat.size > DIFF_FILE_CAP_BYTES) return null;
      return textOrNull(await opened.file.handle.readFile("utf8"));
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
  }

  async function getDiffFileContents(request: DiffFileRequest): Promise<DiffFileContents> {
    const changes = await getDiff();
    const currentSection = patchFileSectionsOf(changes.patch).find((section) => section.path === request.path);
    if (!currentSection) return { ok: false, error: "This file is no longer in the session's changes" };
    if (changes.contentHashByPath[request.path] !== request.newBlobId || currentSection.oldBlobId !== request.oldBlobId) return { ok: false, error: STALE_DIFF_FILE_ERROR };
    const fileRoot = diffFileRoots().find((candidate) => request.path.startsWith(candidate.pathPrefix));
    if (!fileRoot) return { ok: false, error: "This file is no longer in the session's changes" };
    const [oldContents, newContents] = await Promise.all([
      readBaseBlob(fileRoot, request.oldBlobId),
      readWorktreeFile(fileRoot, request.path.slice(fileRoot.pathPrefix.length)),
    ]);
    return { ok: true, oldContents, newContents };
  }

  async function getDiff(): Promise<SessionChanges> {
    if (lifecycleState.provisionedMembers) return getWorkspaceDiff(lifecycleState.provisionedMembers);
    if (!lifecycleState.worktreeDir) return { patch: "", contentHashByPath: {}, generatedPaths: [], hasCommits: false, bases: [] };
    const { base, aheadCount, ref, verified } = await resolveDiffBase(diffGitOptions(lifecycleState.worktreeDir));
    const changes = await readChangesWithUntracked(lifecycleState.worktreeDir, base || "HEAD", null);
    const hasCommits = aheadCount !== "" && aheadCount !== "0";
    const healed = decideDiffSelfHeal(lifecycleState.mergeStatus, changes.patch, hasCommits);
    if (healed) setMergeStatus(healed);
    const bases = base ? [{ member: null, ref, sha: base, verified }] : [];
    return { ...changes, hasCommits, bases };
  }

  return { resolveEffectiveBase, resolveVerifiedBaseRef, diffGitOptions, getChangeScopes, getDiff, getDiffFileContents };
}

export { createWorktreeDiffScopes };
