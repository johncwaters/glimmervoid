import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "./git.ts";
import { EMPTY_FINDINGS, writeStamp } from "./stamp.ts";
import { COHERENCE_DIR } from "./workspace.ts";

const FOLLOWER_SCRIPT = fileURLToPath(import.meta.url);
const LAND_SCRIPT = path.join(path.dirname(FOLLOWER_SCRIPT), "..", "land.ts");
const PID_FILE_NAME = "coherence-journal-follower.pid";
const FOLLOW_LIMIT_MS = 30 * 60 * 1000;
const WRITER_SETTLE_MS = 2000;
const JOURNAL_COMMIT_MESSAGE = "chore(coherence): record run journal\n";
const JOURNAL_MESSAGE_FILE_NAME = "coherence-journal-message";

export function isCoherenceOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((scopePath) => isUnderCoherence(scopePath));
}

function isUnderCoherence(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === COHERENCE_DIR || normalized.startsWith(`${COHERENCE_DIR}/`);
}

export function tracksCoherence(git: Git): boolean {
  return git.run(["ls-files", "--error-unmatch", `${COHERENCE_DIR}/.gitignore`]).code === 0;
}

export function startJournalFollower(git: Git, promote: boolean): void {
  const worktree = git.run(["rev-parse", "--show-toplevel"]).stdout.trim();
  const landedHead = git.revParseHead() ?? "";
  const follower = spawn(process.execPath, [FOLLOWER_SCRIPT, worktree, landedHead, ...(promote ? ["--promote"] : [])], {
    cwd: worktree,
    detached: true,
    stdio: "ignore",
  });
  follower.unref();
}

function isWorktreeDirtyOutsideCoherence(git: Git): boolean {
  return git.statusShort().some((line) => !isUnderCoherence(line.slice(3).trim()));
}

function isCurrentFollower(pidPath: string): boolean {
  try {
    return fs.readFileSync(pidPath, "utf8").trim() === String(process.pid);
  } catch {
    return false;
  }
}

function landJournal(worktree: string, landedHead: string, promote: boolean): void {
  const git = new Git(worktree);
  if (git.revParseHead() !== landedHead || isWorktreeDirtyOutsideCoherence(git)) {
    return;
  }
  writeStamp(git, "coherence-journal", [COHERENCE_DIR], EMPTY_FINDINGS);
  const messageFile = git.gitPath(JOURNAL_MESSAGE_FILE_NAME);
  fs.writeFileSync(messageFile, JOURNAL_COMMIT_MESSAGE, "utf8");
  spawnSync(process.execPath, [LAND_SCRIPT, "--message-file", messageFile, ...(promote ? ["--promote"] : [])], {
    cwd: worktree,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function follow(worktree: string, landedHead: string, promote: boolean): void {
  const pidPath = new Git(worktree).gitPath(PID_FILE_NAME);
  fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  const runsDirectory = path.join(worktree, COHERENCE_DIR, "runs");
  fs.mkdirSync(runsDirectory, { recursive: true });
  let settleTimer: NodeJS.Timeout | undefined;
  const runsWatcher = fs.watch(runsDirectory);
  const pidWatcher = fs.watch(pidPath);
  const limitTimer = setTimeout(() => stop(), FOLLOW_LIMIT_MS);

  function stop(): void {
    clearTimeout(settleTimer);
    clearTimeout(limitTimer);
    runsWatcher.close();
    pidWatcher.close();
  }

  function landOnce(): void {
    stop();
    if (!isCurrentFollower(pidPath)) {
      return;
    }
    landJournal(worktree, landedHead, promote);
  }

  runsWatcher.on("error", stop);
  pidWatcher.on("error", stop);
  pidWatcher.on("change", () => {
    if (!isCurrentFollower(pidPath)) {
      stop();
    }
  });
  runsWatcher.on("change", () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(landOnce, WRITER_SETTLE_MS);
  });
}

if (process.argv[1] === FOLLOWER_SCRIPT) {
  const [worktree, landedHead, promoteFlag] = process.argv.slice(2);
  if (worktree && landedHead) {
    follow(worktree, landedHead, promoteFlag === "--promote");
  }
}
