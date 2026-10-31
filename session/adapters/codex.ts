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
import { codexHomes, codexSessionIdFromPath } from "../../server/usage/core/usage-scan-core.ts";
import { openContainedFile } from "../../server/contained-file.ts";
import { isRelevantRolloutLine, isTurnStartLine, turnEndedWithProposedPlan } from "../core/codex-plan-rollout-core.ts";
import { codexHookPlanFor, LEGACY_HOOK_EVENTS, parseCodexVersion } from "../core/codex-version-core.ts";
import { CODEX_HOME_PROFILE, renderCodexHookTables, renderCodexHooksBlock } from "../core/agent-home-core.ts";
import type { CodexHomeHook } from "../core/agent-home-core.ts";
import { CODEX_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { generatedAgentHomePath, holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import { readCodexHookHashes } from "../codex-hook-trust.ts";
import type { CodexAppServerCommand } from "../../server/codex-app-server-request.ts";
import { errorMessage } from "../../shared/text.ts";
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
const PLAN_PROPOSED_FIELD = "glimmervoid_plan_proposed";
const ROLLOUT_CHUNK_BYTES = 1024 * 1024;
const ROLLOUT_SCAN_LIMIT_BYTES = 64 * ROLLOUT_CHUNK_BYTES;
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

function isProposedPlanStop(event: string, payload?: HookPayload): boolean {
  return event === "stop" && payload?.[PLAN_PROPOSED_FIELD] === true;
}

async function readTurnRolloutLines(handle: fs.promises.FileHandle, fileSize: number, turnId: string): Promise<string[] | null> {
  const scanFloor = Math.max(0, fileSize - ROLLOUT_SCAN_LIMIT_BYTES);
  const relevantLines: string[] = [];
  let chunkEnd = fileSize;
  let carriedBytes = Buffer.alloc(0);
  while (chunkEnd > scanFloor) {
    const chunkStart = Math.max(scanFloor, chunkEnd - ROLLOUT_CHUNK_BYTES);
    const chunk = Buffer.alloc(chunkEnd - chunkStart);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, chunkStart);
    const window = Buffer.concat([chunk.subarray(0, bytesRead), carriedBytes]);
    const firstNewline = chunkStart === 0 ? -1 : window.indexOf(0x0a);
    carriedBytes = window.subarray(0, firstNewline + 1);
    const chunkLines = window.subarray(firstNewline + 1).toString("utf8").split("\n").filter(isRelevantRolloutLine);
    relevantLines.unshift(...chunkLines);
    if (chunkLines.some((line) => isTurnStartLine(line, turnId))) return relevantLines;
    chunkEnd = chunkStart;
  }
  if (scanFloor > 0) console.warn(`codex rollout scan stopped at ${ROLLOUT_SCAN_LIMIT_BYTES} bytes without the start of turn ${turnId}`);
  return relevantLines;
}

async function readTurnRolloutLinesFromCodexHome(transcriptPath: string, turnId: string, agentEnv: Record<string, string | undefined>): Promise<string[] | null> {
  const rolloutHomes = [...codexHomes(agentEnv, null), generatedAgentHomePath(CODEX_HOME_PROFILE, agentEnv)];
  for (const codexHome of rolloutHomes) {
    const opened = await openContainedFile(path.resolve(transcriptPath), path.join(codexHome, "sessions"));
    if (!opened.ok) continue;
    const { handle, stat } = opened.file;
    try {
      return await readTurnRolloutLines(handle, stat.size, turnId);
    } finally {
      await handle.close();
    }
  }
  return null;
}

async function enrichHookPayload(event: string, payload: HookPayload, agentEnv: Record<string, string | undefined>): Promise<HookPayload> {
  if (String(event || "").toLowerCase() !== "stop") return payload;
  const { transcript_path: transcriptPath, session_id: sessionId, turn_id: turnId } = payload;
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string" || typeof turnId !== "string") return payload;
  if (codexSessionIdFromPath(transcriptPath) !== sessionId) return payload;
  const rolloutLines = await readTurnRolloutLinesFromCodexHome(transcriptPath, turnId, agentEnv);
  if (!rolloutLines || !turnEndedWithProposedPlan(rolloutLines, turnId)) return payload;
  return { ...payload, [PLAN_PROPOSED_FIELD]: true };
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
      return isProposedPlanStop(e, payload) ? "awaiting-input" : "ready";
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
  if (isProposedPlanStop(e, payload)) return "plan";
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
  hasHomeHooks = false,
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
  hasHomeHooks?: boolean;
} = {}): string[] | null {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  const preToolUseGroups: string[] = [];
  const groupsByEvent = new Map<string, string[]>();
  const argvEvents = hasHomeHooks ? [] : events;
  const argvMatchedHooks = hasHomeHooks ? [] : matchedRelayHooks;
  const argvHookTools = hasHomeHooks ? hookTools.filter((tool) => tool.id !== "saneYolo") : hookTools;
  const relayedEvents = observeToolCalls && !argvEvents.includes("PreToolUse") ? [...argvEvents, "PreToolUse"] : argvEvents;
  const relayedMatchedHooks = observeToolCalls ? argvMatchedHooks.filter(({ event }) => event !== "PreToolUse") : argvMatchedHooks;
  for (const event of relayedEvents) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    if (event === "PreToolUse") {
      preToolUseGroups.push(`{hooks=[{type='command',command='${command}'}]}`);
      continue;
    }
    groupsByEvent.set(event, [`{hooks=[{type='command',command='${command}'}]}`]);
  }
  for (const { event, matcher, isAsync } of relayedMatchedHooks) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    const asyncField = isAsync ? ",async=true" : "";
    const group = `{matcher='${matcher}',hooks=[{type='command',command='${command}'${asyncField}}]}`;
    if (event === "PreToolUse") {
      preToolUseGroups.push(group);
      continue;
    }
    groupsByEvent.set(event, [...(groupsByEvent.get(event) ?? []), group]);
  }
  const groups = argvHookTools.flatMap((tool) => {
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
  if (bypassHookTrust && gatesMcpToolCalls) args.push(...argvHookTools.flatMap((tool) => HOOK_TOOLS[tool.id].codexTrustedArgs(tool)));
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

function codexHomeHooks(plan: CodexHookPlan = hookPlanForInstalledCodex()): CodexHomeHook[] | null {
  const hooks: CodexHomeHook[] = [];
  for (const event of plan.events) {
    const command = buildHookCommand(RELAY_PATH, event);
    if (!command) return null;
    hooks.push({ event, matcher: null, command });
  }
  for (const { event, matcher, isAsync } of plan.matchedRelayHooks) {
    const command = buildHookCommand(RELAY_PATH, event);
    if (!command) return null;
    hooks.push({ event, matcher, command, isAsync });
  }
  const saneYoloCommand = buildHookCommand(HOOK_TOOL_RELAY_PATH, "saneYolo", [CODEX_SANE_YOLO_FLAVOR]);
  if (!saneYoloCommand) return null;
  hooks.push({ event: "PreToolUse", matcher: "Bash", command: saneYoloCommand });
  return hooks;
}

const trustedHashesByHookTables = new Map<string, readonly string[]>();
let pendingTrustReading: Promise<void> | null = null;

function installedAppServerCommand(): CodexAppServerCommand {
  const command = buildSpawnCommand({ platform: process.platform, resolved: resolveCommand(), agentArgs: [] });
  return { file: command.file, argsBeforeAppServer: command.args };
}

async function readHomeHookTrust(hooks: readonly CodexHomeHook[], hookTables: string): Promise<void> {
  const reading = await Promise.resolve()
    .then(() => readCodexHookHashes(installedAppServerCommand(), hooks))
    .catch((error: unknown) => ({ failure: errorMessage(error) }));
  if ("failure" in reading) {
    console.warn(`[codex] Glimmervoid's hooks stay untrusted in the generated Codex home, so Sane YOLO is off for this launch: ${reading.failure}`);
    return;
  }
  trustedHashesByHookTables.set(hookTables, reading.hashes);
}

function readTrust(): Promise<void> {
  const hooks = codexHomeHooks();
  if (!hooks) return Promise.resolve();
  const hookTables = renderCodexHookTables(hooks);
  if (trustedHashesByHookTables.has(hookTables)) return Promise.resolve();
  pendingTrustReading ??= readHomeHookTrust(hooks, hookTables).finally(() => { pendingTrustReading = null; });
  return pendingTrustReading;
}

function prepareHome(env: Record<string, string | undefined>): { home: string; isTrusted: boolean } | { refusal: string } {
  const hooks = codexHomeHooks();
  if (!hooks) return { refusal: "the hook relay path cannot be written into a codex hooks block" };
  const trustedHashes = trustedHashesByHookTables.get(renderCodexHookTables(hooks)) ?? null;
  const realHome = realAgentHome(CODEX_HOME_PROFILE, env);
  const generatedHome = generatedAgentHomePath(CODEX_HOME_PROFILE, env);
  const prepared = holdPreparedAgentHome(CODEX_HOME_PROFILE, env, (operatorText) => renderCodexHooksBlock({ hooks, trustedHashes, operatorText, realHome, generatedHome }));
  if ("refusal" in prepared) return prepared;
  return { home: prepared.home, isTrusted: trustedHashes !== null };
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  enrichPayload: enrichHookPayload,
  injection: {
    kind: "argv-config",
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    buildHookArgs: buildInstalledHookArgs,
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    userConfigFolders,
    mayContributeHooks,
    home: {
      homeEnvName: CODEX_HOME_PROFILE.homeEnvName,
      readTrust,
      prepareHome,
      releaseHome: releaseAgentHome,
    },
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

const OPERATOR_CONFIG_FILE_NAME = "config.toml";

function operatorConfigPath(env: SpawnEnv): string | null {
  const [codexHome] = codexHomes(env, null);
  if (!codexHome) return null;
  return path.join(codexHome, OPERATOR_CONFIG_FILE_NAME);
}

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
  operatorConfigPath,
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
    planLimits: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
    toolHookContext: true,
  },
  promptContextReply: "additional-context",
} satisfies AgentAdapterShape;

export { readHostCodexVersion };
export default codex;
