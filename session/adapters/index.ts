import type { ResolvedHookTool } from '../core/hook-tools.ts';
import type { UserHook } from '../core/user-hooks-core.ts';
import claudeCode from "./claude-code.ts";
import codex from "./codex.ts";
import grok from "./grok.ts";
import kimi from "./kimi.ts";
import shell from "./shell.ts";
import { createCustomAdapter } from "./custom.ts";

import type { HookProfile } from "../../detection/hook-source.ts";
import type { TitleProfile } from "../../detection/osc-title-source.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type { TaskTitleVocabulary } from "../core/task-title-core.ts";
import type { CustomAgentDeclaration, HookPayload } from "../../shared/contracts/index.ts";
import type { PromptContextReply } from "../../shared/contracts/refocus.ts";

interface AgentCapabilities {
  hooks: boolean;
  awaitingInput: boolean;
  backgroundAgents: boolean;
  resume: boolean;
  statusLine: boolean;
  saneYolo: boolean;
  compactQuiet: boolean;
  skipPermissionsFlag: boolean;
  headless: boolean;
  subagentTurnStops?: boolean;
  ptyInitialPrompt?: boolean;
  promptContextSupervision?: boolean;
  toolHookContext?: boolean;
}


interface ProjectConfigCandidate {
  relPath: string;
  presenceIsHit?: boolean;
}

interface SettingsFileInjection {
  kind: "settings-file";
}

interface HookedAgentHome {
  homeEnvName: string;
  readTrust(): Promise<void>;
  prepareHome(env: Record<string, string | undefined>): { home: string; isTrusted: boolean } | { refusal: string };
  releaseHome(home: string): void;
}

interface ArgvConfigInjection {
  kind: "argv-config";
  relayPath: string;
  events: string[];
  buildHookArgs(options?: {
    relayPath?: string;
    events?: string[];
    bypassHookTrust?: boolean;
    hookTools?: ResolvedHookTool[];
    hookToolRelayPath?: string;
    userHooks?: readonly UserHook[];
    observeToolCalls?: boolean;
    hasHomeHooks?: boolean;
  }): string[] | null;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  userConfigFolders(env: Record<string, string | undefined>): string[];
  mayContributeHooks(configText: unknown): boolean;
  home?: HookedAgentHome;
}

interface HomeHooksFileInjection {
  kind: "home-hooks-file";
  setupCommand: string;
  filePath(env?: Record<string, string | undefined>, homedir?: string): string;
  classifyContents(contents: string): string;
  isSaneYoloReady(contents: string): boolean;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  userConfigFolders(env: Record<string, string | undefined>): string[];
  mayContributeHooks(configText: unknown): boolean;
}

interface ScratchAgentHome {
  home: string;
  configSuffix: string;
  files: Readonly<Record<string, string>>;
}

interface GeneratedHomeInjection {
  kind: "generated-home";
  homeEnvName: string;
  prepareHome(env: Record<string, string | undefined>): { home: string } | { refusal: string };
  prepareScratchHome(env: Record<string, string | undefined>, scratch: ScratchAgentHome): { home: string } | { refusal: string };
  releaseHome(home: string): void;
}

type HookInjection = SettingsFileInjection | ArgvConfigInjection | HomeHooksFileInjection | GeneratedHomeInjection;

interface AgentHookProfile extends HookProfile {
  injection: HookInjection;
  enrichPayload?(event: string, payload: HookPayload, agentEnv: Record<string, string | undefined>): Promise<HookPayload>;
}

interface AgentTitleProfile extends TitleProfile {
  quietUntilFirstPrompt?: boolean;
  taskTitle: TaskTitleVocabulary;
}

interface AgentArgsOptions {
  dangerouslySkipPermissions?: boolean;
  resumeSessionId?: string | null;
  extraArgs?: string[];
  initialPrompt?: string | null;
  hasOperatorInstructions?: boolean;
  canRunHelpCommand?: boolean;
  canSpawn?: boolean;
}

interface AgentSpawnCommandOptions {
  platform: NodeJS.Platform;
  resolved?: ResolvedCommand | null;
  settingsArgs?: string[];
  agentArgs?: string[];
}

interface AgentCommandOptions {
  platform?: NodeJS.Platform;
  execFile?: PathLookupExecFile;
  pathExists?: (candidate: string) => boolean;
}

interface AgentAdapter {
  id: string;
  label: string;
  usageVendor: string;
  commandName: string;
  envProfile: AgentEnvProfile;
  titleProfile: AgentTitleProfile;
  hooks: AgentHookProfile | null;
  capabilities: AgentCapabilities;
  promptContextReply?: PromptContextReply;
  resolveCommand(options?: AgentCommandOptions): ResolvedCommand;
  buildSpawnCommand(options: AgentSpawnCommandOptions): { file: string; args: string[] };
  buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv;
  buildArgs(options?: AgentArgsOptions): string[];
  settingsArgs?(settingsPath: string): string[];
  operatorConfigPath?(env: SpawnEnv): string | null;
  setsOperatorInstructions?(operatorConfigText: string): boolean;
  isWorkspaceTrusted?(cwd: string, env: SpawnEnv): boolean;
  sessionIdOf?(payload: HookPayload): unknown;
}

type AgentAdapterShape = AgentAdapter & Record<string, unknown>;

const DEFAULT_AGENT_ID = claudeCode.id;

const adapterEntries: [string, AgentAdapter][] = [
  [claudeCode.id, claudeCode],
  [codex.id, codex],
  [grok.id, grok],
  [kimi.id, kimi],
  [shell.id, shell],
];
const ADAPTERS = new Map(adapterEntries);
const customAdapters = new Map<string, AgentAdapter>();
const customAgentFingerprints = new Map<string, string>();

const resolvedCommands = new Map<string, ResolvedCommand>();

function declarationFingerprint(declaration: CustomAgentDeclaration): string {
  return JSON.stringify([
    declaration.command,
    declaration.args,
    declaration.idleTitle ?? null,
    declaration.busyTitle ?? null,
  ]);
}

function customAgentFingerprint(agentId: string | null | undefined): string | null {
  if (agentId == null) return null;
  return customAgentFingerprints.get(agentId) ?? null;
}

function setCustomAgents(declared: readonly CustomAgentDeclaration[]): void {
  const nextFingerprintById = new Map<string, string>();
  for (const declaration of declared) nextFingerprintById.set(declaration.id, declarationFingerprint(declaration));
  for (const [customId, previousFingerprint] of customAgentFingerprints) {
    if (nextFingerprintById.get(customId) === previousFingerprint) continue;
    resolvedCommands.delete(customId);
  }
  customAdapters.clear();
  customAgentFingerprints.clear();
  for (const declaration of declared) {
    customAdapters.set(declaration.id, createCustomAdapter(declaration));
    customAgentFingerprints.set(declaration.id, nextFingerprintById.get(declaration.id) ?? declarationFingerprint(declaration));
  }
}

function hookProfileOf(adapter: AgentAdapter): AgentHookProfile | null {
  if (!adapter.capabilities.hooks) return null;
  return adapter.hooks;
}

function listAgentIds(): string[] {
  return [...ADAPTERS.keys(), ...customAdapters.keys()];
}

function isKnownAgentId(agentId: unknown): boolean {
  if (typeof agentId !== "string") return false;
  return ADAPTERS.has(agentId) || customAdapters.has(agentId);
}

function getAdapter(agentId: string | null | undefined): AgentAdapter | null {
  if (agentId == null) return ADAPTERS.get(DEFAULT_AGENT_ID) ?? null;
  return ADAPTERS.get(agentId) ?? customAdapters.get(agentId) ?? null;
}

function resolveAdapter(
  agentId: string | null | undefined,
  { warn = console.warn, label = "" }: { warn?: (message: string) => void; label?: string } = {},
): AgentAdapter | null {
  const adapter = getAdapter(agentId);
  if (adapter) return adapter;
  warn(`[glimmervoid]${label ? ` ${label}:` : ""} unknown agent "${agentId}", falling back to ${DEFAULT_AGENT_ID}`);
  return ADAPTERS.get(DEFAULT_AGENT_ID) ?? null;
}

function commandFor(adapterOrId: AgentAdapter | string, options?: AgentCommandOptions): ResolvedCommand {
  const adapter = typeof adapterOrId === "string" ? resolveAdapter(adapterOrId) : adapterOrId;
  if (!adapter) throw new TypeError("default agent adapter is unavailable");
  const cached = resolvedCommands.get(adapter.id);
  if (cached) return cached;
  const resolved = adapter.resolveCommand(options);
  resolvedCommands.set(adapter.id, resolved);
  return resolved;
}

function describeAgentResolvability(agentId: string): { label: string; path: string | null; resolvable: boolean } {
  const adapter = getAdapter(agentId);
  if (!adapter) return { label: agentId, path: null, resolvable: false };
  const resolvedPath = commandFor(adapter)?.path ?? null;
  return { label: adapter.label || agentId, path: resolvedPath, resolvable: !!resolvedPath };
}

function cachedAgentResolvability(agentId: string): { label: string; path: string | null; resolvable: boolean | null } {
  const adapter = getAdapter(agentId);
  if (!adapter) return { label: agentId, path: null, resolvable: false };
  const cached = resolvedCommands.get(adapter.id);
  if (!cached) return { label: adapter.label || agentId, path: null, resolvable: null };
  return { label: adapter.label || agentId, path: cached.path ?? null, resolvable: !!cached.path };
}

function resetCommandCache(): void {
  resolvedCommands.clear();
}

export {
  DEFAULT_AGENT_ID,
  listAgentIds,
  isKnownAgentId,
  getAdapter,
  hookProfileOf,
  resolveAdapter,
  cachedAgentResolvability,
  commandFor,
  customAgentFingerprint,
  describeAgentResolvability,
  resetCommandCache,
  setCustomAgents,
};
export type { AgentAdapter, AgentAdapterShape, AgentArgsOptions, AgentCapabilities, AgentCommandOptions, AgentHookProfile, AgentSpawnCommandOptions, AgentTitleProfile, ArgvConfigInjection, GeneratedHomeInjection, HomeHooksFileInjection, HookedAgentHome, ProjectConfigCandidate, ScratchAgentHome };
