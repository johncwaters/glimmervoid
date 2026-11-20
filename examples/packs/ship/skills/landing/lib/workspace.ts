import fs from "node:fs";
import path from "node:path";
import type { AddedLine, Git } from "./git.ts";

export const MAINLINE_CANDIDATES = ["main", "master"] as const;

export type MainlineFreshness =
  | { checked: true; mainline: string; behind: number }
  | { checked: false; mainline: string; reason: string };

const MAINLINE_FETCH_TIMEOUT_MS = 5_000;

const DENYLIST_DIR_PREFIXES = ["node_modules/", "dist/", "__pycache__/"] as const;

export type Scope = { changed: Set<string>; untracked: string[] };

export function isDenylisted(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const prefix of DENYLIST_DIR_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return true;
    }
  }
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.startsWith(".env") || basename.endsWith(".log");
}

export function localPathPrefixes(homeDirectory: string, usernames: string[]): string[] {
  const prefixes = [
    homeDirectory.replace(/\/+$/, ""),
    ...usernames.flatMap((username) => [`/home/${username}`, `/Users/${username}`]),
  ];
  return [...new Set(prefixes.filter((prefix) => prefix !== ""))];
}

export function localPathMatches(addedLines: AddedLine[], localPrefixes: string[]): string[] {
  if (localPrefixes.length === 0) {
    return [];
  }
  const escapedPrefixes = localPrefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const localPathPattern = new RegExp(`(?:${escapedPrefixes.join("|")})(?![\\w-])(?!\\.[\\w-])`);
  return addedLines
    .filter((addedLine) => localPathPattern.test(addedLine.text))
    .map((addedLine) => `${addedLine.filePath}:${addedLine.lineNumber}`);
}

const SECRET_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-proj-[A-Za-z0-9_-]{40,}/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { name: "PostHog personal key", pattern: /\bphx_[A-Za-z0-9]{30,}/ },
  { name: "private key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
];

export function secretMatches(addedLines: AddedLine[]): string[] {
  return addedLines.flatMap((addedLine) => {
    const shape = SECRET_SHAPES.find(({ pattern }) => pattern.test(addedLine.text));
    return shape ? [`${addedLine.filePath}:${addedLine.lineNumber} (${shape.name})`] : [];
  });
}

export const COHERENCE_DIR = ".coherence";

function isNewFileStatus(statusCode: string): boolean {
  return statusCode === "??" || statusCode.includes("A");
}

export function withNewJournalFiles(git: Git, paths: string[]): string[] {
  if (paths.length === 0) {
    return paths;
  }
  const newJournalFiles = git
    .statusShort([COHERENCE_DIR])
    .filter((line) => isNewFileStatus(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter((filePath) => filePath.endsWith(".jsonl") && !paths.includes(filePath));
  return [...paths, ...newJournalFiles];
}

export function computeScope(git: Git, paths: string[]): Scope {
  const changed = new Set([
    ...git.diffNameOnly({ cached: false, paths }),
    ...git.diffNameOnly({ cached: true, paths }),
  ]);
  const untracked: string[] = [];
  for (const line of git.statusShort(paths)) {
    if (!line.startsWith("??")) {
      continue;
    }
    const filePath = line.slice(3).trim();
    if (isDenylisted(filePath)) {
      continue;
    }
    untracked.push(filePath);
  }
  return { changed, untracked };
}

function originHeadBranch(git: Git): string | null {
  const originHead = git.symbolicRef("refs/remotes/origin/HEAD");
  const prefix = "refs/remotes/origin/";
  if (!originHead?.startsWith(prefix)) {
    return null;
  }
  if (!git.verifyRef(originHead)) {
    return null;
  }
  return originHead.slice(prefix.length);
}

export function resolveMainline(git: Git, configuredMainline: unknown = "auto"): string | null {
  if (typeof configuredMainline === "string" && configuredMainline !== "auto") {
    if (
      git.verifyRef(`refs/heads/${configuredMainline}`) ||
      git.verifyRef(`refs/remotes/origin/${configuredMainline}`)
    ) {
      return configuredMainline;
    }
    return null;
  }

  const remoteDefault = originHeadBranch(git);
  if (remoteDefault !== null) {
    return remoteDefault;
  }
  for (const name of MAINLINE_CANDIDATES) {
    if (git.verifyRef(`refs/heads/${name}`) || git.verifyRef(`refs/remotes/origin/${name}`)) {
      return name;
    }
  }
  return null;
}

export function originHoldsOnlyBranch(git: Git, branch: string): boolean {
  if (!git.listRemotes().includes("origin")) {
    return true;
  }
  const originBranches = git.remoteBranchNames("origin");
  return originBranches !== null && originBranches.every((originBranch) => originBranch === branch);
}

export function foundingMainlineName(git: Git, configuredMainline: unknown = "auto"): string | null {
  const currentBranchRef = `refs/heads/${git.currentBranch()}`;
  const listing = git.run(["for-each-ref", "--format=%(refname)", "refs/heads"]);
  const hasOtherBranches = listing.stdout.split("\n").some((refName) => refName !== "" && refName !== currentBranchRef);
  if (listing.code !== 0 || hasOtherBranches) {
    return null;
  }
  if (typeof configuredMainline === "string" && configuredMainline !== "auto") {
    return configuredMainline;
  }
  return git.run(["config", "init.defaultBranch"]).stdout.trim() || "main";
}

export function checkMainlineFreshness(
  git: Git,
  mainline: string,
  timeoutMs = MAINLINE_FETCH_TIMEOUT_MS,
): MainlineFreshness {
  if (!git.listRemotes().includes("origin")) {
    return { checked: false, mainline, reason: "origin remote is not configured" };
  }
  if (git.fetchRemoteBranch("origin", mainline, { timeoutMs, noPrompt: true }).code !== 0) {
    return { checked: false, mainline, reason: `could not fetch origin/${mainline}` };
  }
  const remoteMainlineRef = `refs/remotes/origin/${mainline}`;
  const mergeBase = git.mergeBase("HEAD", remoteMainlineRef);
  if (mergeBase === null) {
    return {
      checked: false,
      mainline,
      reason: `could not find a merge base with origin/${mainline}`,
    };
  }
  return {
    checked: true,
    mainline,
    behind: git.revList(`${mergeBase}..${remoteMainlineRef}`).length,
  };
}

export function findWorktreeForBranch(porcelainText: string, branch: string): string | null {
  const target = `refs/heads/${branch}`;
  let worktreePath: string | null = null;
  let worktreeBranch: string | null = null;
  for (const line of [...porcelainText.split("\n"), ""]) {
    if (line.trim() === "") {
      if (worktreePath && worktreeBranch === target) {
        return worktreePath;
      }
      worktreePath = null;
      worktreeBranch = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ")) {
      worktreeBranch = line.slice("branch ".length);
    }
  }
  return null;
}
