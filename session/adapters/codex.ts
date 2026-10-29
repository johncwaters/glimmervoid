import { HOOK_TOOLS, mergeCodexPreToolUse } from '../core/hook-tools.ts';
import type { ResolvedHookTool } from '../core/hook-tools.ts';
import type { UserHook } from '../core/user-hooks-core.ts';

import fs from "node:fs";
import path from "node:path";
import { execFileAsync, execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import { classifyAgentTitle, isBrailleChar } from "../core/title-classifier-core.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { supervisionLine } from "../core/session-routes.ts";
import { codexHomes } from "../../server/usage/core/usage-scan-core.ts";
import { codexHookPlanFor, LEGACY_HOOK_EVENTS, parseCodexVersion } from "../core/codex-version-core.ts";
import type { CodexHookPlan, MatchedRelayHook } from "../core/codex-version-core.ts";
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

const HOOK_EVENTS = LEGACY_HOOK_EVENTS;

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

const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

function isRequestUserInput(event: string, payload?: HookPayload): boolean {
  return event === "pretooluse" && payload?.tool_name === REQUEST_USER_INPUT_TOOL_NAME;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
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
    case "precompact":
      return "compaction-start";
    case "postcompact":
      return "compaction-end";
    case "subagentstart":
      return "subagent-start";
    case "subagentstop":
      return "subagent-stop";
    case "pretooluse":
      return isRequestUserInput(e, payload) ? "awaiting-input" : null;
    case "posttooluse":
      return payload?.tool_name === REQUEST_USER_INPUT_TOOL_NAME ? "working" : null;
    default:
      return null;
  }
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "permissionrequest") return "permission";
  if (isRequestUserInput(e, payload)) return "elicitation";
  return null;
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

function userConfigFolders(env: Record<string, string | undefined>): string[] {
  return codexHomes(env, null);
}

const TOML_LITERAL_STRING_FORBIDDEN = /[\x00-\x08\x0a-\x1f\x27\x7f]/;

function buildHookArgs({
  relayPath = RELAY_PATH,
  events = HOOK_EVENTS,
  matchedRelayHooks = [],
  bypassHookTrust = false,
  gatesMcpToolCalls = false,
  hookTools = [],
  hookToolRelayPath = HOOK_TOOL_RELAY_PATH,
  userHooks = [],
  observeToolCalls = false,
}: {
  relayPath?: string;
  events?: string[];
  matchedRelayHooks?: readonly MatchedRelayHook[];
  bypassHookTrust?: boolean;
  gatesMcpToolCalls?: boolean;
  hookTools?: ResolvedHookTool[];
  hookToolRelayPath?: string;
  userHooks?: readonly UserHook[];
  observeToolCalls?: boolean;
} = {}): string[] | null {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  const preToolUseGroups: string[] = [];
  const groupsByEvent = new Map<string, string[]>();
  const relayedEvents = observeToolCalls && !events.includes("PreToolUse") ? [...events, "PreToolUse"] : events;
  const relayedMatchedHooks = observeToolCalls ? matchedRelayHooks.filter(({ event }) => event !== "PreToolUse") : matchedRelayHooks;
  for (const event of relayedEvents) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    if (event === "PreToolUse") {
      preToolUseGroups.push(`{hooks=[{type='command',command='${command}'}]}`);
      continue;
    }
    groupsByEvent.set(event, [`{hooks=[{type='command',command='${command}'}]}`]);
  }
  for (const { event, matcher } of relayedMatchedHooks) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    const group = `{matcher='${matcher}',hooks=[{type='command',command='${command}'}]}`;
    if (event === "PreToolUse") {
      preToolUseGroups.push(group);
      continue;
    }
    groupsByEvent.set(event, [...(groupsByEvent.get(event) ?? []), group]);
  }
  const groups = hookTools.flatMap((tool) => {
    const group = HOOK_TOOLS[tool.id].codexGroup(tool, hookToolRelayPath);
    return group ? [group] : [];
  });
  preToolUseGroups.push(...groups);
  for (const hook of userHooks) {
    if (!hook.enabled || hook.type !== 'command' || !hook.command) continue;
    if (TOML_LITERAL_STRING_FORBIDDEN.test(hook.command) || (hook.matcher !== undefined && TOML_LITERAL_STRING_FORBIDDEN.test(hook.matcher))) {
      console.warn(`[codex] hook ${hook.id} skipped: command or matcher cannot be expressed as a TOML literal string`);
      continue;
    }
    const matcherField = hook.matcher === undefined ? '' : `matcher='${hook.matcher}',`;
    const group = `{${matcherField}hooks=[{type='command',command='${hook.command}'}]}`;
    if (hook.event === 'PreToolUse') {
      preToolUseGroups.push(group);
      continue;
    }
    const eventGroups = groupsByEvent.get(hook.event) ?? [];
    eventGroups.push(group);
    groupsByEvent.set(hook.event, eventGroups);
  }
  for (const [event, eventGroups] of groupsByEvent) {
    args.push('-c', `hooks.${event}=[${eventGroups.join(',')}]`);
  }
  args.push(...mergeCodexPreToolUse(preToolUseGroups));
  if (bypassHookTrust && gatesMcpToolCalls) args.push(...hookTools.flatMap((tool) => HOOK_TOOLS[tool.id].codexTrustedArgs(tool)));
  return args;
}

let installedHookPlan: CodexHookPlan | null = null;

function probeInstalledCodexVersion(): string | null {
  const versionCommand = buildSpawnCommand({ platform: process.platform, resolved: resolveCommand(), agentArgs: ["--version"] });
  try {
    return parseCodexVersion(execFileSync(versionCommand.file, versionCommand.args, { encoding: "utf8", timeout: 3000, windowsHide: true }));
  } catch {
    return null;
  }
}

async function readHostCodexVersion(): Promise<string | null> {
  const versionCommand = buildSpawnCommand({ platform: process.platform, resolved: resolveCommand(), agentArgs: ["--version"] });
  try {
    const { stdout } = await execFileAsync(versionCommand.file, versionCommand.args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    return parseCodexVersion(stdout);
  } catch {
    return null;
  }
}

function hookPlanForInstalledCodex(): CodexHookPlan {
  installedHookPlan ??= codexHookPlanFor(probeInstalledCodexVersion());
  return installedHookPlan;
}

function buildInstalledHookArgs(options: Parameters<typeof buildHookArgs>[0] = {}): string[] | null {
  return buildHookArgs({ ...hookPlanForInstalledCodex(), ...options });
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: {
    kind: "argv-config",
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    buildHookArgs: buildInstalledHookArgs,
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    userConfigFolders,
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
const OUTER_GUARDRAILS_ARGS = ["-s", "danger-full-access"];
const OUTER_GUARDRAILS_SKIP_PERMISSIONS_ARGS = ["-a", "never", ...OUTER_GUARDRAILS_ARGS];

function permissionArgs(dangerouslySkipPermissions: boolean, hasOuterGuardrails: boolean): string[] {
  if (hasOuterGuardrails && dangerouslySkipPermissions) return OUTER_GUARDRAILS_SKIP_PERMISSIONS_ARGS;
  if (hasOuterGuardrails) return OUTER_GUARDRAILS_ARGS;
  if (dangerouslySkipPermissions) return SKIP_PERMISSIONS_ARGS;
  return [];
}

const OPERATOR_CONFIG_FILE_NAME = "config.toml";
const DEVELOPER_INSTRUCTIONS_KEY = "developer_instructions";
const DEVELOPER_INSTRUCTIONS_DECLARATION_RE = /^[^\S\r\n]*["']?developer_instructions["']?[^\S\r\n]*=/m;

function operatorConfigPath(env: SpawnEnv): string | null {
  const [codexHome] = codexHomes(env, null);
  if (!codexHome) return null;
  return path.join(codexHome, OPERATOR_CONFIG_FILE_NAME);
}

function setsOperatorInstructions(operatorConfigText: string): boolean {
  return DEVELOPER_INSTRUCTIONS_DECLARATION_RE.test(operatorConfigText);
}

function isDeveloperInstructionsOverride(launchArgument: string): boolean {
  return launchArgument.startsWith(`${DEVELOPER_INSTRUCTIONS_KEY}=`);
}

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
  hasOuterGuardrails = false,
  hasOperatorInstructions = false,
  canRunHelpCommand = true,
  canSpawn = false,
}: AgentArgsOptions = {}): string[] {
  const args = [...UPDATE_CHECK_ARGS];
  if (canRunHelpCommand && !hasOperatorInstructions && !extraArgs.some(isDeveloperInstructionsOverride)) {
    args.push("-c", `${DEVELOPER_INSTRUCTIONS_KEY}='''${supervisionLine({ isGuarded: hasOuterGuardrails, canSpawn })}'''`);
  }
  if (resumeSessionId) args.push("resume", resumeSessionId);
  args.push(...permissionArgs(dangerouslySkipPermissions, hasOuterGuardrails));
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
  operatorConfigPath,
  setsOperatorInstructions,
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
    backgroundAgents: true,
    resume: true,
    statusLine: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export { readHostCodexVersion };
export default codex;
