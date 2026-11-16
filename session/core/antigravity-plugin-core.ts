import { buildHookCommand } from "./hook-command-core.ts";

const ANTIGRAVITY_PLUGIN_NAME = "glimmervoid";
const AGENT_STATE_HOOK_EVENT = "AgentState";
const PLAIN_HOOK_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"] as const;
const TOOL_HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;

type AntigravityPluginFileName = "plugin.json" | "hooks.json" | "mcp_config.json";

interface CommandHook {
  type: "command";
  command: string;
}

function commandHook(relayLaunch: readonly string[], event: string): CommandHook | null {
  const command = buildHookCommand(relayLaunch, event);
  return command === null ? null : { type: "command", command };
}

function jsonFileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hooksByEvent(relayLaunch: readonly string[]): Record<string, unknown[]> | null {
  const hooks: Record<string, unknown[]> = {};
  for (const event of PLAIN_HOOK_EVENTS) {
    const hook = commandHook(relayLaunch, event);
    if (hook === null) return null;
    hooks[event] = [hook];
  }
  for (const event of TOOL_HOOK_EVENTS) {
    const hook = commandHook(relayLaunch, event);
    if (hook === null) return null;
    hooks[event] = [{ matcher: "*", hooks: [hook] }];
  }
  return hooks;
}

function renderAntigravityPlugin(relayLaunch: readonly string[], bridgeLaunch: readonly string[]): Record<AntigravityPluginFileName, string> | null {
  const hooks = hooksByEvent(relayLaunch);
  const [bridgeCommand, ...bridgeArgs] = bridgeLaunch;
  if (hooks === null || bridgeCommand === undefined) return null;
  return {
    "plugin.json": jsonFileText({ name: ANTIGRAVITY_PLUGIN_NAME, version: "1.0.0", description: "Reports session status to the Glimmervoid dashboard that started this session." }),
    "hooks.json": jsonFileText({ [ANTIGRAVITY_PLUGIN_NAME]: hooks }),
    "mcp_config.json": jsonFileText({ mcpServers: { [ANTIGRAVITY_PLUGIN_NAME]: { command: bridgeCommand, args: bridgeArgs } } }),
  };
}

function antigravitySessionSettings(folderTrustRoot: string, relayLaunch: readonly string[]): string | null {
  const titleCommand = buildHookCommand(relayLaunch, AGENT_STATE_HOOK_EVENT);
  if (titleCommand === null) return null;
  return JSON.stringify({ trustedWorkspaces: [folderTrustRoot], title: { type: "command", command: titleCommand } });
}

export { ANTIGRAVITY_PLUGIN_NAME, antigravitySessionSettings, renderAntigravityPlugin };
