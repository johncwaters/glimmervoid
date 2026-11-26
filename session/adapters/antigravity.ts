import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MCP_URL_ENV } from "../../mcp/core/agent-config.ts";
import { hookLaunch, installedHookLaunch } from "../../server/runtime-paths.ts";
import { writeTextAtomicSync } from "../../server/json-file.ts";
import { sessionAgentHomePath } from "../agent-home.ts";
import { ANTIGRAVITY_HOME_PROFILE } from "../core/agent-home-core.ts";
import { canonicalizePath } from "../../shared/canonical-paths.ts";
import { errorMessage } from "../../shared/text.ts";
import { ANTIGRAVITY_PLUGIN_NAME, ANTIGRAVITY_QUESTION_TOOL_NAME, antigravityInstalledHooks, antigravitySessionSettings, createConversationTagger, hasRunningSubagent, hasRunningTask, packSkillWorkspacesOf, renderAntigravityPlugin } from "../core/antigravity-plugin-core.ts";
import type { InstalledHooks } from "../core/user-hooks-core.ts";
import type { AgentEnvProfile } from "../core/spawn-env.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentTitleProfile,
  GeneratedHomeLaunch,
} from "./index.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";

const ID = "antigravity";
const COMMAND_NAME = "agy";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const PLUGIN_FOLDER_MODE = 0o700;
const PLUGIN_FILE_MODE = 0o600;
const PLUGIN_REFUSAL = "the hook relay path cannot be written into an Antigravity plugin";
const SANDBOXED_HOME_MODE = 0o700;
const GIT_DOTFILE_PATTERN = /^\.git/;
const HIDDEN_GIT_DOTFILES: readonly string[] = Object.freeze([".git-credentials"]);
const ONBOARDING_FILE_SEGMENTS: readonly string[] = Object.freeze([".gemini", "antigravity-cli", "cache", "onboarding.json"]);
const ONBOARDING_DONE = Object.freeze({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true });
const CLEAN_HOME_REFUSAL = "Antigravity always reads the operator's own ~/.gemini and sign-in, so it cannot run in a clean home";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: {},
};

const SIGNAL_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  pretooluse: "working",
  posttooluse: "working",
});

const SIGNAL_BY_AGENT_STATE: Readonly<Record<string, string>> = Object.freeze({
  tool_use: "awaiting-input",
  working: "working",
  idle: "ready",
});

function normalizedEventOf(event: string): string {
  return String(event || "").toLowerCase();
}

function isPermissionState(event: string, payload?: HookPayload): boolean {
  return normalizedEventOf(event) === "agentstate" && payload?.agent_state === "tool_use";
}

const SIGNAL_BY_SUBAGENT_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "subagent-start",
  stop: "subagent-stop",
});

function isSubagentEvent(payload?: HookPayload): boolean {
  return typeof payload?.agent_id === "string";
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = normalizedEventOf(event);
  if (isSubagentEvent(payload)) return SIGNAL_BY_SUBAGENT_EVENT[normalizedEvent] ?? null;
  if (normalizedEvent === "agentstate" && payload?.agent_state === "idle" && (payload?.hasRunningSubagent === true || hasRunningSubagent(payload?.subagents) || hasRunningTask(payload?.task_count))) return "working";
  if (normalizedEvent === "agentstate" && payload?.agent_state === "idle" && payload?.isTurnOpen !== true) return null;
  if (normalizedEvent === "agentstate" && payload?.agent_state === "working" && payload?.isTurnOpen !== true && payload?.hasRunningSubagent !== true && !hasRunningSubagent(payload?.subagents)) return null;
  if (normalizedEvent === "preinvocation") return payload?.invocationNum === 0 ? "resume" : "working";
  if (normalizedEvent === "stop") return payload?.fullyIdle === true ? "ready" : null;
  if (normalizedEvent === "agentstate") return SIGNAL_BY_AGENT_STATE[String(payload?.agent_state)] ?? null;
  return SIGNAL_BY_EVENT[normalizedEvent] ?? null;
}

function createPayloadEnricher(): (event: string, payload: HookPayload) => HookPayload {
  return createConversationTagger();
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  if (!isPermissionState(event, payload)) return null;
  return payload?.pendingToolName === ANTIGRAVITY_QUESTION_TOOL_NAME ? "elicitation" : "permission";
}

function mapHookConfidence(): string | null {
  return null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return isSubagentEvent(payload) ? undefined : payload?.conversationId || undefined;
}

function classifyTitle(): string {
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: ["agy", "Antigravity"], agentSuffix: null },
};

function pluginFolderPath(home: string): string {
  return path.join(home, ".gemini", "config", "plugins", ANTIGRAVITY_PLUGIN_NAME);
}

function linkTargetsForGit(operatorHome: string): { name: string; target: string }[] {
  const dotfiles = fs.readdirSync(operatorHome).filter((name) => GIT_DOTFILE_PATTERN.test(name) && !HIDDEN_GIT_DOTFILES.includes(name));
  const xdgGitFolder = path.join(operatorHome, ".config", "git");
  const xdgLinks = fs.existsSync(xdgGitFolder) ? [{ name: path.join(".config", "git"), target: xdgGitFolder }] : [];
  return [...dotfiles.map((name) => ({ name, target: path.join(operatorHome, name) })), ...xdgLinks];
}

function linkGitConfig(home: string): void {
  for (const { name, target } of linkTargetsForGit(os.homedir())) {
    const linkPath = path.join(home, name);
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isSymbolicLink()) continue;
    if (existing !== undefined && fs.readlinkSync(linkPath, "utf8") === target) continue;
    if (existing !== undefined) fs.unlinkSync(linkPath);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: SANDBOXED_HOME_MODE });
    fs.symlinkSync(target, linkPath);
  }
}

function markOnboardingDone(home: string): void {
  const onboardingFile = path.join(home, ...ONBOARDING_FILE_SEGMENTS);
  if (fs.existsSync(onboardingFile)) return;
  fs.mkdirSync(path.dirname(onboardingFile), { recursive: true, mode: SANDBOXED_HOME_MODE });
  writeTextAtomicSync(onboardingFile, `${JSON.stringify(ONBOARDING_DONE, null, 2)}\n`, { mode: PLUGIN_FILE_MODE });
}

function sandboxedHomeOf(env: Record<string, string | undefined>, privateHomeKey: string | null): string | { refusal: string } {
  const home = sessionAgentHomePath(ANTIGRAVITY_HOME_PROFILE, env, { isSandboxed: true, privateKey: privateHomeKey });
  try {
    fs.mkdirSync(home, { recursive: true, mode: SANDBOXED_HOME_MODE });
    markOnboardingDone(home);
    linkGitConfig(home);
    return home;
  } catch (error) {
    return { refusal: `the sandboxed Antigravity home ${home} could not be made: ${errorMessage(error)}` };
  }
}

function writePlugin(pluginFolder: string, pluginFiles: Readonly<Record<string, string>>): string | null {
  try {
    fs.mkdirSync(pluginFolder, { recursive: true, mode: PLUGIN_FOLDER_MODE });
    for (const [fileName, fileText] of Object.entries(pluginFiles)) {
      writeTextAtomicSync(path.join(pluginFolder, fileName), fileText, { mode: PLUGIN_FILE_MODE });
    }
    return null;
  } catch (error) {
    return `${pluginFolder} could not be written: ${errorMessage(error)}`;
  }
}

function prepareHome(
  env: Record<string, string | undefined>,
  { listenerPort, sessionFolder, isCleanHome, isSandboxed = false, privateHomeKey = null, packSkillDirs = [], sharedPackServers = [], hasPackHooks = false }: GeneratedHomeLaunch,
): { home: string; homeEnvValue: string; args: string[]; env: Record<string, string> } | { refusal: string } {
  if (isCleanHome && !isSandboxed) return { refusal: CLEAN_HOME_REFUSAL };
  const sandboxedHome = isSandboxed ? sandboxedHomeOf(env, privateHomeKey) : null;
  if (typeof sandboxedHome === "object" && sandboxedHome !== null) return sandboxedHome;
  const hookToolLaunch = installedHookLaunch("hook-tool-relay");
  const pluginFiles = renderAntigravityPlugin(installedHookLaunch("hook-relay"), installedHookLaunch("mcp-bridge"), sharedPackServers, hasPackHooks ? hookToolLaunch : null, hookToolLaunch);
  const packSkillWorkspaces = packSkillWorkspacesOf(packSkillDirs);
  const sessionSettings = antigravitySessionSettings([...new Set([sessionFolder, canonicalizePath(sessionFolder)]), ...packSkillWorkspaces], RELAY_LAUNCH);
  if (pluginFiles === null || sessionSettings === null) return { refusal: PLUGIN_REFUSAL };
  const pluginFolder = pluginFolderPath(sandboxedHome ?? os.homedir());
  const writeFailure = writePlugin(pluginFolder, pluginFiles);
  if (writeFailure) return { refusal: writeFailure };
  const homeEnv: Record<string, string> = sandboxedHome === null ? {} : { HOME: sandboxedHome };
  return { home: pluginFolder, homeEnvValue: `http://127.0.0.1:${listenerPort}/mcp`, args: ["--settings", sessionSettings, ...packSkillWorkspaces.flatMap((workspace) => ["--add-dir", workspace])], env: homeEnv };
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: CLEAN_HOME_REFUSAL };
}

function releaseHome(): void {}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args: string[] = [];
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (resumeSessionId) args.push("--conversation", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt) args.push("-i", initialPrompt);
  return args;
}

function describeInstalledHooks(): InstalledHooks {
  const hookToolLaunch = installedHookLaunch("hook-tool-relay");
  const pluginFiles = renderAntigravityPlugin(installedHookLaunch("hook-relay"), installedHookLaunch("mcp-bridge"), [], null, hookToolLaunch);
  const sessionSettings = antigravitySessionSettings([], RELAY_LAUNCH);
  if (pluginFiles === null || sessionSettings === null) return { unavailableReason: PLUGIN_REFUSAL, isBestEffort: false };
  return { version: null, isBestEffort: false, hooks: antigravityInstalledHooks() };
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  createPayloadEnricher,
  describeInstalledHooks,
  injection: {
    kind: "generated-home",
    homeEnvName: MCP_URL_ENV,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayTurnHooksOff: () => false,
  },
};

const antigravity = {
  id: ID,
  inputReady: "cursor-shown",
  promptContextReply: "inject-steps",
  questionDenyReply: "decision",
  label: "Antigravity CLI",
  usageVendor: ID,
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  sessionIdOf,
  mapHookToSignal,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    announcesFinishedBackgroundWork: true,
    resume: true,
    planLimits: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: false,
    subagentTurnStops: false,
    chatApprovals: true,
  },
} satisfies AgentAdapterShape;

export default antigravity;
