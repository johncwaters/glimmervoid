import fs from "node:fs";
import type { Git } from "./git.ts";
import { detachedHead, notARepo, operationInProgress, type Result } from "./outcome.ts";

const IN_PROGRESS_MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"] as const;
const REBASE_STATE_DIRECTORIES = ["rebase-merge", "rebase-apply"] as const;

// A finished rebase can leave REBASE_HEAD behind; only its state directory means one is running.
function isOperationInProgress(git: Git, marker: (typeof IN_PROGRESS_MARKERS)[number]): boolean {
  if (!git.verifyRef(marker)) {
    return false;
  }
  if (marker !== "REBASE_HEAD") {
    return true;
  }
  return REBASE_STATE_DIRECTORIES.some((directory) => fs.existsSync(git.gitPath(directory)));
}

// preflight and land share this guard so neither refuses what the other would land.
export function repositoryGuard(git: Git): Result | null {
  if (!git.isInsideWorkTree()) {
    return notARepo({});
  }
  if (git.currentBranch() === "HEAD") {
    return detachedHead({});
  }
  for (const marker of IN_PROGRESS_MARKERS) {
    if (!isOperationInProgress(git, marker)) {
      continue;
    }
    if (marker === "MERGE_HEAD") {
      return operationInProgress({ operation: marker, unmerged: git.conflictingFilesIn(git.repo) });
    }
    return operationInProgress({ operation: marker });
  }
  return null;
}
