import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { requestCodexAppServer } from "../server/codex-app-server-request.ts";
import type { CodexAppServerCommand } from "../server/codex-app-server-request.ts";
import { canonicalizePath } from "../shared/canonical-paths.ts";
import { AGENT_HOME_CONFIG_NAME, renderCodexHookTables, tomlBasicString } from "./core/agent-home-core.ts";
import type { CodexHomeHook, ProjectHookTrust } from "./core/agent-home-core.ts";

const HOOK_LIST_TIMEOUT_MS = 15_000;
const CODEX_USER_HOOKS_FILE_NAME = "hooks.json";

interface UserHookTrust {
  relativeKey: string;
  currentHash: string;
}

const listedHookSchema = z.object({
  eventName: z.string(),
  matcher: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  sourcePath: z.string(),
  currentHash: z.string(),
  key: z.string().optional(),
  source: z.string().optional(),
});
const hooksListSchema = z.object({ data: z.array(z.object({ hooks: z.array(listedHookSchema) })) });

type ListedHook = z.infer<typeof listedHookSchema>;

function lowerCamelEventName(event: string): string {
  return `${event.charAt(0).toLowerCase()}${event.slice(1)}`;
}

function isListingOf(hook: CodexHomeHook, listed: ListedHook): boolean {
  return listed.eventName === lowerCamelEventName(hook.event) && (listed.matcher ?? null) === hook.matcher && listed.command === hook.command;
}

function matchTrustedHashes(hooks: readonly CodexHomeHook[], listedHooks: readonly ListedHook[]): string[] | null {
  const unclaimed = [...listedHooks];
  const hashes: string[] = [];
  for (const hook of hooks) {
    const listedIndex = unclaimed.findIndex((listed) => isListingOf(hook, listed));
    const listed = unclaimed[listedIndex];
    if (!listed) return null;
    unclaimed.splice(listedIndex, 1);
    hashes.push(listed.currentHash);
  }
  return hashes;
}

function projectHookTrustOf(listedHooks: readonly ListedHook[]): ProjectHookTrust[] {
  return listedHooks.flatMap((listed) => listed.source === "project" && listed.key !== undefined ? [{ key: listed.key, currentHash: listed.currentHash }] : []);
}

function userHookTrustOf(listedHooks: readonly ListedHook[], probeHome: string, probeHooksJsonPath: string): UserHookTrust[] {
  const probePrefix = `${probeHome}${path.sep}`;
  return listedHooks.flatMap((listed) => {
    if (listed.source !== "user" || listed.sourcePath !== probeHooksJsonPath || listed.key === undefined) return [];
    if (!listed.key.startsWith(probePrefix)) return [];
    return [{ relativeKey: listed.key.slice(probePrefix.length), currentHash: listed.currentHash }];
  });
}

function trustedFolderSpellings(sessionFolder: string): string[] {
  return [...new Set([sessionFolder, canonicalizePath(sessionFolder)])];
}

function sessionFolderTrustTables(sessionFolder: string): string {
  return trustedFolderSpellings(sessionFolder)
    .map((folder) => `\n[projects.${tomlBasicString(folder)}]\ntrust_level = "trusted"\n`)
    .join("");
}

async function copyRealHooksJson(realHooksJsonPath: string | null, probeHooksJsonPath: string): Promise<boolean> {
  if (realHooksJsonPath === null) return false;
  try {
    await fs.copyFile(realHooksJsonPath, probeHooksJsonPath);
    return true;
  } catch {
    return false;
  }
}

async function readCodexHookHashes(
  command: CodexAppServerCommand,
  hooks: readonly CodexHomeHook[],
  sessionFolder: string,
  env: NodeJS.ProcessEnv = process.env,
  realHooksJsonPath: string | null = null,
): Promise<{ hashes: string[]; projectHookTrust: ProjectHookTrust[]; userHookTrust: UserHookTrust[] } | { failure: string }> {
  const probeHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmervoid-codex-hooks-")));
  const probeConfigPath = path.join(probeHome, AGENT_HOME_CONFIG_NAME);
  const probeHooksJsonPath = path.join(probeHome, CODEX_USER_HOOKS_FILE_NAME);
  try {
    await fs.writeFile(probeConfigPath, `${renderCodexHookTables(hooks)}${sessionFolderTrustTables(sessionFolder)}`, { mode: 0o600 });
    const hasRealHooksJson = await copyRealHooksJson(realHooksJsonPath, probeHooksJsonPath);
    const response = await requestCodexAppServer(command, { ...env, CODEX_HOME: probeHome }, { method: "hooks/list", params: { cwds: [probeHome, ...trustedFolderSpellings(sessionFolder)] }, timeoutMs: HOOK_LIST_TIMEOUT_MS });
    if (response === null) return { failure: "codex app-server did not answer hooks/list" };
    const listing = hooksListSchema.safeParse(response.result);
    if (!listing.success) return { failure: "codex app-server answered hooks/list in a shape Glimmervoid does not read" };
    const listedHooks = listing.data.data.flatMap((entry) => entry.hooks);
    const hashes = matchTrustedHashes(hooks, listedHooks.filter((listed) => listed.sourcePath === probeConfigPath));
    if (hashes === null) return { failure: "codex app-server did not list every Glimmervoid hook" };
    const userHookTrust = hasRealHooksJson ? userHookTrustOf(listedHooks, probeHome, probeHooksJsonPath) : [];
    return { hashes, projectHookTrust: projectHookTrustOf(listedHooks), userHookTrust };
  } finally {
    await fs.rm(probeHome, { recursive: true, force: true });
  }
}

export { readCodexHookHashes };
export type { UserHookTrust };
