import path from "node:path";

import { hookLaunch } from "../../server/runtime-paths.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { realAgentHome } from "../agent-home.ts";
import type { AgentHomeProfile } from "../core/agent-home-core.ts";
import type { InstalledHooks } from "../core/user-hooks-core.ts";

const RELAY_LAUNCH = hookLaunch("hook-relay");
const HOOK_TOOL_RELAY_LAUNCH = hookLaunch("hook-tool-relay");

interface CommandHook {
  type: "command";
  command: string;
}

interface SettingsHomeHookVocabulary {
  agentId: string;
  relayedEvents: readonly string[];
  saneYoloEvent: string;
  saneYoloFlavor: string;
  homeProfile: AgentHomeProfile;
  hookEntryFor(commandHook: CommandHook): unknown;
}

interface SettingsHomeHooks {
  hooksRefusal: string;
  expectedHooks(): string | null;
  describeInstalledHooks(): InstalledHooks;
  configFilePath(env?: Record<string, string | undefined>, homedir?: string): string;
}

function configNameOf(homeProfile: AgentHomeProfile, agentId: string): string {
  if (homeProfile.config === null) throw new TypeError(`${agentId} settings hooks need a home profile with a config file`);
  return homeProfile.config.configName;
}

function settingsHomeHooks({ agentId, relayedEvents, saneYoloEvent, saneYoloFlavor, homeProfile, hookEntryFor }: SettingsHomeHookVocabulary): SettingsHomeHooks {
  const hooksRefusal = `the hook relay path cannot be written into ${agentId} hooks`;
  const configName = configNameOf(homeProfile, agentId);

  function expectedHooks(): string | null {
    const hooksByEvent: Record<string, unknown[]> = {};
    for (const event of relayedEvents) {
      const command = buildHookCommand(RELAY_LAUNCH, event);
      if (!command) return null;
      hooksByEvent[event] = [hookEntryFor({ type: "command", command })];
    }
    const saneYoloCommand = buildHookCommand(HOOK_TOOL_RELAY_LAUNCH, "saneYolo", [saneYoloFlavor]);
    if (!saneYoloCommand) return null;
    hooksByEvent[saneYoloEvent] = [hookEntryFor({ type: "command", command: saneYoloCommand })];
    return JSON.stringify(hooksByEvent);
  }

  function describeInstalledHooks(): InstalledHooks {
    if (expectedHooks() === null) return { unavailableReason: hooksRefusal, isBestEffort: false };
    return { version: null, isBestEffort: false, hooks: [...relayedEvents.map((event) => ({ event, matcher: null, route: null })), { event: saneYoloEvent, matcher: null, route: "saneYolo" }] };
  }

  function configFilePath(env: Record<string, string | undefined> = process.env, homedir?: string): string {
    return path.join(realAgentHome(homeProfile, env, homedir), configName);
  }

  return { hooksRefusal, expectedHooks, describeInstalledHooks, configFilePath };
}

export { settingsHomeHooks };
