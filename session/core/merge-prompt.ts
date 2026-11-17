import path from "node:path";
import { classifyConflicts } from "../../server/git/core/conflict-classify-core.ts";

interface MergePromptInputs {
  branch?: string;
  target?: string;
  reason?: string;
  conflicts?: string[];
  worktreeDir?: string;
}

function reasonText(reason: string | undefined, target: string): string {
  switch (reason) {
    case "rebase-conflict":
      return `your commits overlap changes already on ${target}, so rebasing onto it hit conflicts.`;
    case "not-fast-forward":
      return `${target} advanced after this work started, so a clean fast-forward is no longer possible.`;
    case "uncommitted-changes":
      return "the worktree has uncommitted changes, which must be committed or discarded before it can merge.";
    case "no-target-branch":
    case "no-target":
      return `the integration branch ${target} does not exist.`;
    default:
      return reason
        ? `the merge could not complete automatically (${reason}).`
        : "the merge could not complete automatically.";
  }
}

function buildMergePrompt(
  { branch, target, reason, conflicts = [], worktreeDir }: MergePromptInputs = {},
): string {
  const tgt = target || "the integration branch";
  const br = branch || "this session's branch";
  const files = Array.isArray(conflicts) ? conflicts.filter(Boolean) : [];

  const lines: string[] = [];
  lines.push(
    `This session's work could not be merged back into ${tgt} automatically, so it needs a manual merge. ` +
      `You are running in the git worktree for branch "${br}", which was forked from ${tgt}.`,
  );
  lines.push("");
  lines.push(`Why it parked: ${reasonText(reason, tgt)}`);
  const { lockfiles, others } = classifyConflicts(files);
  if (others.length) {
    lines.push("");
    lines.push("Conflicting files:");
    for (const conflictPath of others) lines.push(`  - ${conflictPath}`);
  }
  if (lockfiles.length) {
    lines.push("");
    lines.push(`Conflicting lockfiles; never merge one by hand. Once the rebase stops on it, take ${tgt}'s copy (during a rebase that is --ours), regenerate it, and git add it:`);
    for (const lockfile of lockfiles) {
      const folder = path.posix.dirname(lockfile.path.replaceAll("\\", "/"));
      const where = folder === "." ? "at the repository root" : `in ${folder}`;
      lines.push(`  - ${lockfile.path}: git checkout --ours -- ${lockfile.path}, then run ${lockfile.regenerateCommand} ${where}`);
    }
  }
  lines.push("");
  lines.push("Only rebase this session branch; do not force-push or rewrite any shared history.");
  lines.push("");
  lines.push(`Glimmervoid merges by rebasing "${br}" onto ${tgt} and then fast-forwarding ${tgt}. To unblock it:`);
  lines.push(`  1. From this worktree${worktreeDir ? ` (${worktreeDir})` : ""}, run: git rebase ${tgt}`);
  lines.push(
    `  2. Resolve the conflicts${files.length ? " in the files listed above" : ""}, ` +
      "then: git add the resolved files and git rebase --continue.",
  );
  lines.push(
    "  3. When the working tree is clean and rebased, run: glimmervoid push. " +
      "If it answers no, do what its reply says; " +
      "when the reply leaves nothing this session can do, say the work is ready and leave the merge to the operator.",
  );
  return lines.join("\n");
}

export { buildMergePrompt };
