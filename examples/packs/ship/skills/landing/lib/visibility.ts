import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Git } from "./git.ts";
import { ledgerPath } from "./ledger.ts";
import { type CommitPolicy, configuredMainline, policyValidationErrors, readCommitPolicy } from "./policy.ts";
import { resolveMainline } from "./workspace.ts";

export type RemoteVisibility =
  | { remote: string; visibility: "public" | "private" | "internal" }
  | { remote: string; visibility: "unknown"; reason: string };

type GithubRemote =
  | { remote: string; repositoryName: string; hasRemote: true }
  | { remote: string; repositoryName: null; hasRemote: boolean; isLocal: boolean; reason: string };

type ResolvedAfterCommit = "promote" | "pull-request";

type AfterCommitResolution = {
  mode: ResolvedAfterCommit | "unresolved";
  warning?: string;
  lookupFailed?: boolean;
};

const GITHUB_REMOTE_PATTERN = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const GH_TIMEOUT_MS = 10_000;
const KNOWN_VISIBILITIES = new Set(["public", "private", "internal"]);

export function githubRepositoryName(remoteUrl: string): string | null {
  return GITHUB_REMOTE_PATTERN.exec(remoteUrl.trim())?.[1] ?? null;
}

export function isLocalRemoteUrl(remoteUrl: string): boolean {
  const url = remoteUrl.trim();
  if (url.startsWith("file://")) {
    return true;
  }
  if (url.includes("://")) {
    return false;
  }
  const firstColon = url.indexOf(":");
  const firstSlash = url.indexOf("/");
  return firstColon === -1 || (firstSlash !== -1 && firstSlash < firstColon);
}

function pushesOnlyToLocalPaths(git: Git, remote: string): boolean {
  const pushUrls = git.run(["remote", "get-url", "--push", "--all", remote]);
  const urls = pushUrls.stdout.split("\n").filter((url) => url.trim() !== "");
  return pushUrls.code === 0 && urls.length > 0 && urls.every(isLocalRemoteUrl);
}

export function readGithubRemote(git: Git, remote = "origin"): GithubRemote {
  const remoteUrl = git.run(["remote", "get-url", remote]);
  if (remoteUrl.code !== 0) {
    return { remote, repositoryName: null, hasRemote: false, isLocal: false, reason: `no ${remote} remote` };
  }
  const repositoryName = githubRepositoryName(remoteUrl.stdout);
  if (repositoryName === null) {
    return { remote, repositoryName: null, hasRemote: true, isLocal: pushesOnlyToLocalPaths(git, remote), reason: `${remote} is not a GitHub remote` };
  }
  return { remote, repositoryName, hasRemote: true };
}

export function resolveAfterCommit(origin: GithubRemote): AfterCommitResolution {
  if (origin.repositoryName === null) {
    if (!origin.hasRemote || origin.isLocal) {
      return { mode: "promote" };
    }
    return leaveForPullRequest(origin.reason);
  }
  const repositoryName = origin.repositoryName;
  const lookup = spawnSync("gh", ["api", "user", "--hostname", "github.com", "--jq", ".login"], {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
  });
  const login = (lookup.stdout ?? "").trim();
  if (lookup.status !== 0 || login === "") {
    const detail = (lookup.stderr ?? "").trim() || lookup.error?.message || "no login returned";
    return fallBackToRememberedAnswer(repositoryName, `gh api user --jq .login failed: ${detail}`);
  }
  const owner = repositoryName.split("/")[0];
  if (owner.toLowerCase() !== login.toLowerCase()) {
    return rememberAnswer(repositoryName, "pull-request");
  }
  return resolveOwnedRepository(repositoryName, login);
}

function leaveForPullRequest(reason: string): AfterCommitResolution {
  return { mode: "pull-request", warning: `${reason}; leaving the branch for a pull request` };
}

function resolveOwnedRepository(repositoryName: string, login: string): AfterCommitResolution {
  const ownershipLookup = spawnSync(
    "gh",
    ["api", `repos/${repositoryName}`, "--hostname", "github.com", "--jq", "[.owner.login, .fork] | @tsv"],
    { encoding: "utf8", timeout: GH_TIMEOUT_MS },
  );
  const [resolvedOwner = "", isForkAnswer = ""] = (ownershipLookup.stdout ?? "").trim().split("\t");
  if (ownershipLookup.status !== 0 || resolvedOwner === "" || !["true", "false"].includes(isForkAnswer)) {
    const detail = (ownershipLookup.stderr ?? "").trim() || ownershipLookup.error?.message || "no owner and fork returned";
    return fallBackToRememberedAnswer(repositoryName, `gh api repos/${repositoryName} failed: ${detail}`);
  }
  const isOwnedByLogin = resolvedOwner.toLowerCase() === login.toLowerCase();
  return rememberAnswer(repositoryName, isOwnedByLogin && isForkAnswer === "false" ? "promote" : "pull-request");
}

function rememberedAnswersPath(): string {
  return path.join(path.dirname(ledgerPath()), "landing-ownership.json");
}

function readRememberedAnswers(): Record<string, ResolvedAfterCommit> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(rememberedAnswersPath(), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ResolvedAfterCommit] => entry[1] === "promote" || entry[1] === "pull-request"),
    );
  } catch {
    return {};
  }
}

function rememberAnswer(repositoryName: string, mode: ResolvedAfterCommit): AfterCommitResolution {
  const answersByRepository = readRememberedAnswers();
  const repositoryKey = repositoryName.toLowerCase();
  if (answersByRepository[repositoryKey] === mode) return { mode };
  const answersPath = rememberedAnswersPath();
  const pendingPath = `${answersPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.writeFileSync(pendingPath, `${JSON.stringify({ ...answersByRepository, [repositoryKey]: mode }, null, 2)}\n`);
    fs.renameSync(pendingPath, answersPath);
  } catch (error) {
    fs.rmSync(pendingPath, { force: true });
    return { mode, warning: `could not remember the after-commit answer for ${repositoryName}: ${(error as Error).message}` };
  }
  return { mode };
}

function fallBackToRememberedAnswer(repositoryName: string, reason: string): AfterCommitResolution {
  const rememberedMode = readRememberedAnswers()[repositoryName.toLowerCase()];
  if (rememberedMode !== undefined) {
    return {
      mode: rememberedMode,
      warning: `${reason}; reusing the last resolved after-commit answer for ${repositoryName}, ${rememberedMode}`,
      lookupFailed: true,
    };
  }
  return {
    mode: "unresolved",
    warning: `${reason}; afterCommit is unresolved, so land without --promote and ask the operator whether to promote or open a pull request`,
    lookupFailed: true,
  };
}

export type ResolvedPolicyLookup = {
  profile?: string;
  policy?: CommitPolicy & { afterCommit: AfterCommitResolution["mode"]; resolved: { mainline: string | null } };
  branchPolicy?: CommitPolicy;
  mainline: string | null;
  remoteVisibility: RemoteVisibility;
  warnings: string[];
};

export function readResolvedPolicy(git: Git): ResolvedPolicyLookup {
  const { profile, policy: configuredPolicy, policyPath, warning } = readCommitPolicy();
  const validationErrors = policyValidationErrors(configuredPolicy, policyPath);
  const policy = validationErrors.length > 0 ? undefined : configuredPolicy;
  const mainline = resolveMainline(git, configuredMainline(configuredPolicy));
  const origin = readGithubRemote(git);
  const ownershipResolution = resolveAfterCommit(origin);
  return {
    ...(profile ? { profile } : {}),
    ...(policy ? { policy: { ...policy, afterCommit: ownershipResolution.mode, resolved: { mainline } } } : {}),
    ...(configuredPolicy ? { branchPolicy: configuredPolicy } : {}),
    mainline,
    remoteVisibility: readRemoteVisibility(origin),
    warnings: [
      warning,
      ownershipResolution.warning,
      validationErrors.length > 0 ? `invalid commit policy, so promotion is skipped: ${validationErrors.join("; ")}` : undefined,
    ].filter((message): message is string => message !== undefined),
  };
}

export function readRemoteVisibility(origin: GithubRemote): RemoteVisibility {
  if (origin.repositoryName === null) {
    return { remote: origin.remote, visibility: "unknown", reason: origin.reason };
  }
  const { remote, repositoryName } = origin;
  const hostQualifiedName = `github.com/${repositoryName}`;
  const lookup = spawnSync(
    "gh",
    ["repo", "view", hostQualifiedName, "--json", "visibility", "--jq", ".visibility"],
    { encoding: "utf8", timeout: GH_TIMEOUT_MS },
  );
  const visibility = (lookup.stdout ?? "").trim().toLowerCase();
  if (lookup.status !== 0 || !KNOWN_VISIBILITIES.has(visibility)) {
    const detail = (lookup.stderr ?? "").trim() || lookup.error?.message || "no visibility returned";
    return { remote, visibility: "unknown", reason: `gh repo view ${hostQualifiedName} failed: ${detail}` };
  }
  return { remote, visibility: visibility as "public" | "private" | "internal" };
}
