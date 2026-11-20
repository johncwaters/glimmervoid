import fs from "node:fs";
import path from "node:path";
import { Git } from "./lib/git.ts";
import { repositoryGuard } from "./lib/guard.ts";
import { validateMessage } from "./lib/message.ts";
import {
  emit,
  messageInvalid,
  messageValid,
  ready,
  type Result,
} from "./lib/outcome.ts";
import { configuredMainline, isBranchAllowed } from "./lib/policy.ts";
import { readResolvedPolicy } from "./lib/visibility.ts";
import { checkMainlineFreshness, computeScope, foundingMainlineName, originHoldsOnlyBranch } from "./lib/workspace.ts";

type Arguments = { paths: string[]; messageFileToCheck: string | null; noFetch: boolean };

type ReleaseIntegrationLookup = {
  profilePath?: string;
  integration?: string;
  warning?: string;
};

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { paths: [], messageFileToCheck: null, noFetch: false };
  let collectingPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--check-message") {
      parsed.messageFileToCheck = argv[index + 1] ?? "";
      if (parsed.messageFileToCheck === "") {
        throw new Error("--check-message takes the path of a commit message file written with the Write tool");
      }
      index += 1;
      collectingPaths = false;
      continue;
    }
    if (argument === "--paths") {
      collectingPaths = true;
      continue;
    }
    if (argument === "--no-fetch") {
      parsed.noFetch = true;
      collectingPaths = false;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown flag ${argument}`);
    }
    if (!collectingPaths) {
      throw new Error(`unexpected argument ${argument}`);
    }
    parsed.paths.push(argument);
  }
  return parsed;
}

function checkMessageResult(message: string): Result {
  const errors = validateMessage(message);
  if (errors.length > 0) {
    return messageInvalid({ errors });
  }
  return messageValid({});
}

function jsonReleaseProfileIntegration(profilePath: string): ReleaseIntegrationLookup {
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    const git = profile.git as Record<string, unknown> | undefined;
    const integration = git?.integration;
    if (typeof integration !== "string") {
      return {};
    }
    return { profilePath, integration };
  } catch (error) {
    return { warning: `could not parse ${profilePath} while checking git.integration: ${String(error)}` };
  }
}

function yamlReleaseProfileIntegration(profilePath: string): ReleaseIntegrationLookup {
  const lines = fs.readFileSync(profilePath, "utf8").split(/\r?\n/);
  let gitIndent: number | null = null;
  for (const line of lines) {
    const content = line.trim();
    const indent = line.length - line.trimStart().length;
    if (gitIndent === null && content === "git:") {
      gitIndent = indent;
      continue;
    }
    if (gitIndent === null) {
      continue;
    }
    if (content !== "" && indent <= gitIndent) {
      return {};
    }
    const match = /^integration:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(content);
    const integration = match?.[1];
    if (integration === "null" || integration === "~") {
      return {};
    }
    if (integration) {
      return { profilePath, integration };
    }
  }
  return {};
}

function releaseProfileIntegration(repo: string): ReleaseIntegrationLookup {
  const jsonProfilePath = path.join(repo, ".claude", "release-profile.json");
  if (fs.existsSync(jsonProfilePath)) {
    return jsonReleaseProfileIntegration(jsonProfilePath);
  }

  const profilePath = path.join(repo, ".claude", "release-profile.yml");
  if (!fs.existsSync(profilePath)) {
    return {};
  }
  return yamlReleaseProfileIntegration(profilePath);
}

function unresolvedMainlineWarning(git: Git, branch: string, configured: unknown, noFetch: boolean): string {
  const foundingMainline = foundingMainlineName(git, configured);
  const hasOrigin = git.listRemotes().includes("origin");
  if (foundingMainline !== null && noFetch && hasOrigin) {
    return `no mainline yet; land.ts --promote from a feature branch founds ${foundingMainline} if origin holds no other branch, unchecked under --no-fetch`;
  }
  if (foundingMainline === null || !originHoldsOnlyBranch(git, branch)) {
    return "could not resolve the policy mainline; promotion will be skipped";
  }
  return `no mainline yet; land.ts --promote from a feature branch founds ${foundingMainline} at the landed commit${hasOrigin ? " and pushes it" : ""}`;
}

function preflightResult(paths: string[], noFetch: boolean): Result {
  const git = new Git(process.cwd());
  const guard = repositoryGuard(git);
  if (guard) {
    return guard;
  }

  const branch = git.currentBranch();
  const { changed, untracked } = computeScope(git, paths);
  const resolvedScopePaths = [...new Set([...changed, ...untracked])].sort();
  const wholeTree = paths.length === 0 ? { changed, untracked } : computeScope(git, []);
  const hasUncommittedWork = wholeTree.changed.size > 0 || wholeTree.untracked.length > 0;
  const { profile, policy, branchPolicy, mainline, remoteVisibility, warnings } = readResolvedPolicy(git);
  const mainlineFreshness = mainline === null || noFetch
    ? undefined
    : checkMainlineFreshness(git, mainline);
  if (mainlineFreshness?.checked && mainlineFreshness.behind > 0) {
    const shouldMergeMainline = policy?.afterCommit !== "promote" && git.hasUpstream();
    const integrationVerb = shouldMergeMainline ? "merge" : "rebase onto";
    const integrationAdvice = hasUncommittedWork
      ? `${integrationVerb} it once this work is committed; landing with --promote does that itself`
      : `${integrationVerb} origin/${mainlineFreshness.mainline} before review`;
    warnings.push(`branch is ${mainlineFreshness.behind} commits behind origin/${mainlineFreshness.mainline}; ${integrationAdvice}`);
  }
  if (policy && mainline === null) {
    warnings.push(unresolvedMainlineWarning(git, branch, configuredMainline(policy), noFetch));
  }
  const releaseIntegration = releaseProfileIntegration(process.cwd());
  if (releaseIntegration.warning) {
    warnings.push(releaseIntegration.warning);
  }
  if (
    mainline !== null &&
    releaseIntegration.integration !== undefined &&
    releaseIntegration.integration !== mainline
  ) {
    const profilePath = (releaseIntegration.profilePath ?? "").replace(`${process.cwd()}/`, "");
    warnings.push(
      `${profilePath} git.integration names ${releaseIntegration.integration}, but commit policy resolves mainline to ${mainline}`,
    );
  }

  return {
    ...ready({
      branch,
      branchAllowed: isBranchAllowed(branch, branchPolicy, mainline),
      changed: [...changed].sort(),
      untracked,
      hasUncommittedWork,
      ...(profile ? { profile } : {}),
      ...(policy ? { policy } : {}),
      ...(mainlineFreshness ? { mainlineFreshness } : {}),
      remoteVisibility,
      warnings,
    }),
    paths: resolvedScopePaths,
  };
}

const parsed = parseArguments(process.argv.slice(2));
function checkMessageFile(messageFile: string): Result {
  try {
    return checkMessageResult(fs.readFileSync(messageFile, "utf8"));
  } catch (error) {
    return messageInvalid({ errors: [`could not read --check-message file: ${(error as Error).message}`] });
  }
}

if (parsed.messageFileToCheck !== null) {
  emit(checkMessageFile(parsed.messageFileToCheck));
}
emit(preflightResult(parsed.paths, parsed.noFetch));
