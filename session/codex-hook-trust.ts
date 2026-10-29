import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { requestCodexAppServer } from "../server/codex-app-server-request.ts";
import type { CodexAppServerCommand } from "../server/codex-app-server-request.ts";
import { AGENT_HOME_CONFIG_NAME, renderCodexHookTables } from "./core/agent-home-core.ts";
import type { CodexHomeHook } from "./core/agent-home-core.ts";

const HOOK_LIST_TIMEOUT_MS = 15_000;

const listedHookSchema = z.object({
  eventName: z.string(),
  matcher: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  sourcePath: z.string(),
  currentHash: z.string(),
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

async function readCodexHookHashes(command: CodexAppServerCommand, hooks: readonly CodexHomeHook[], env: NodeJS.ProcessEnv = process.env): Promise<{ hashes: string[] } | { failure: string }> {
  const probeHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "glimmervoid-codex-hooks-")));
  const probeConfigPath = path.join(probeHome, AGENT_HOME_CONFIG_NAME);
  try {
    await fs.writeFile(probeConfigPath, renderCodexHookTables(hooks), { mode: 0o600 });
    const response = await requestCodexAppServer(command, { ...env, CODEX_HOME: probeHome }, { method: "hooks/list", params: { cwds: [probeHome] }, timeoutMs: HOOK_LIST_TIMEOUT_MS });
    if (response === null) return { failure: "codex app-server did not answer hooks/list" };
    const listing = hooksListSchema.safeParse(response.result);
    if (!listing.success) return { failure: "codex app-server answered hooks/list in a shape Glimmervoid does not read" };
    const probeHooks = listing.data.data.flatMap((entry) => entry.hooks).filter((listed) => listed.sourcePath === probeConfigPath);
    const hashes = matchTrustedHashes(hooks, probeHooks);
    if (hashes === null) return { failure: "codex app-server did not list every Glimmervoid hook" };
    return { hashes };
  } finally {
    await fs.rm(probeHome, { recursive: true, force: true });
  }
}

export { readCodexHookHashes };
