import { HOOK_TOOLS, mergeCodexPreToolUse } from '../core/hook-tools.ts';
import type { ResolvedHookTool } from '../core/hook-tools.ts';

import fs from "node:fs";
import { execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import { classifyAgentTitle, isBrailleChar } from "../core/title-classifier-core.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "codex";
const COMMAND_NAME = "codex";

const RELAY_PATH = relayPath("hook-relay");
const HOOK_TOOL_RELAY_PATH = relayPath("hook-tool-relay");

const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PermissionRequest"];

const envProfile: AgentEnvProfile = { scrub: [], set: {} };

const ACTION_REQUIRED_RE = /^\[\s*[.!]\s*\]\s*Action Required\b/;

function classifyActionRequired(title: string, cwdBasename: string): string | null {
  if (!ACTION_REQUIRED_RE.test(title)) return null;
  return title.trimEnd().endsWith(cwdBasename) ? "awaiting-input" : "unknown";
}

function classifyTitle(title: string, { cwdBasename = null }: { cwdBasename?: string | null } = {}): string {
  return classifyAgentTitle(title, { cwdBasename }, {
    isSpinnerChar: isBrailleChar,
    classifyAgainstCwdBasename: classifyActionRequired,
  });
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  quietUntilFirstPrompt: true,
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID], agentSuffix: ` - ${ID}` },
};

function mapHookToSignal(event: string): string | null {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return "ready";
    case "permissionrequest":
      return "awaiting-input";
    default:
      return null;
  }
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string): string | null {
  return String(event || "").toLowerCase() === "permissionrequest" ? "permission" : null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.session_id;
}

const TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

const PROJECT_CONFIG_CANDIDATES = Object.freeze([
  Object.freeze({ relPath: ".codex/config.toml", presenceIsHit: false }),
  Object.freeze({ relPath: ".codex/hooks.json", presenceIsHit: true }),
]);

const HOOKS_DECLARATION_RE = /^[^\S\r\n]*(?:\[{1,2}[^\S\r\n]*["']?hooks\b|hooks[.\w"'-]*[^\S\r\n]*=|extends[^\S\r\n]*=)/m;

function mayContributeHooks(configText: unknown): boolean {
  if (typeof configText !== "string") return false;
  return HOOKS_DECLARATION_RE.test(configText);
}

function buildHookArgs({
  relayPath = RELAY_PATH,
  events = HOOK_EVENTS,
  bypassHookTrust = false,
  hookTools = [],
  hookToolRelayPath = HOOK_TOOL_RELAY_PATH,
}: {
  relayPath?: string;
  events?: string[];
  bypassHookTrust?: boolean;
  hookTools?: ResolvedHookTool[];
  hookToolRelayPath?: string;
} = {}): string[] | null {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  const preToolUseGroups: string[] = [];
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    if (event === "PreToolUse") {
      preToolUseGroups.push(`{hooks=[{type='command',command='${command}'}]}`);
      continue;
    }
    args.push("-c", `hooks.${event}=[{hooks=[{type='command',command='${command}'}]}]`);
  }
  const groups = hookTools.flatMap((tool) => {
    const group = HOOK_TOOLS[tool.id].codexGroup(tool, hookToolRelayPath);
    return group ? [group] : [];
  });
  args.push(...mergeCodexPreToolUse([...preToolUseGroups, ...groups]));
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: {
    kind: "argv-config",
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    buildHookArgs,
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    mayContributeHooks,
  },
};

function resolveCommand(
  { platform, execFile = execFileSync, pathExists = fs.existsSync }: {
    platform?: NodeJS.Platform;
    execFile?: PathLookupExecFile;
    pathExists?: (candidate: string) => boolean;
  } = {},
): ResolvedCommand {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    platform: platform || process.platform,
    execFile,
    pathExists,
  });
}

function buildSpawnCommand(
  { platform, resolved, settingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

const UPDATE_CHECK_ARGS = ["-c", "check_for_update_on_startup=false"];

const SKIP_PERMISSIONS_ARGS = ["-a", "never", "-s", "workspace-write"];

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = [...UPDATE_CHECK_ARGS];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  if (dangerouslySkipPermissions) args.push(...SKIP_PERMISSIONS_ARGS);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const codex = {
  id: ID,
  label: "Codex CLI",
  usageVendor: "codex",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  buildHookArgs,
  buildHookCommand,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  classifyTitle,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  sessionIdOf,
  HOOK_EVENTS,
  RELAY_PATH,
  HOOK_TOOL_RELAY_PATH,
  TRUST_BYPASS_FLAG,
  SKIP_PERMISSIONS_ARGS,
  UPDATE_CHECK_ARGS,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: false,
    resume: true,
    statusLine: false,
    rtk: true,
    saneYolo: true,
    antiSlop: false,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export default codex;
