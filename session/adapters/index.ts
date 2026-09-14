import claudeCode from "./claude-code.ts";
import codex from "./codex.ts";
import grok from "./grok.ts";
import { createCustomAdapter } from "./custom.ts";

import type { HookProfile } from "../../detection/hook-source.ts";
import type { TitleProfile } from "../../detection/osc-title-source.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type { PackDelivery } from "../core/pack-pointer-core.ts";
import type { CustomAgentDeclaration, HookPayload } from "../../shared/contracts/index.ts";

interface AgentCapabilities {
  hooks: boolean;
  awaitingInput: boolean;
  backgroundAgents: boolean;
  resume: boolean;
  packs: boolean;
  packNotice: boolean;
  statusLine: boolean;
  rtk: boolean;
  antiSlop: boolean;
  compactQuiet: boolean;
  skipPermissionsFlag: boolean;
  headless: boolean;
}

interface ProjectConfigCandidate {
  relPath: string;
  presenceIsHit?: boolean;
}

interface SettingsFileInjection {
  kind: "settings-file";
}

interface ArgvConfigInjection {
  kind: "argv-config";
  relayPath: string;
  events: string[];
  buildHookArgs(options?: {
    relayPath?: string;
    events?: string[];
    bypassHookTrust?: boolean;
    rtkRewrites?: boolean;
    rtkRelayPath?: string;
  }): string[] | null;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  mayContributeHooks(configText: unknown): boolean;
}

interface HomeHooksFileInjection {
  kind: "home-hooks-file";
  filePath(env?: Record<string, string | undefined>, homedir?: string): string;
  expectedContents(): string | null;
  classifyContents(contents: string): string;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  mayContributeHooks(configText: unknown): boolean;
}

type HookInjection = SettingsFileInjection | ArgvConfigInjection | HomeHooksFileInjection;

interface AgentHookProfile extends HookProfile {
  injection: HookInjection;
}

interface AgentTitleProfile extends TitleProfile {
  quietUntilFirstPrompt?: boolean;
}

interface AgentArgsOptions {
  dangerouslySkipPermissions?: boolean;
  resumeSessionId?: string | null;
  extraArgs?: string[];
  antiSlopPrompt?: boolean;
  initialPrompt?: string | null;
}

interface AgentSpawnCommandOptions {
  platform: NodeJS.Platform;
  resolved?: ResolvedCommand | null;
  settingsArgs?: string[];
  packArgs?: string[];
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
  packCarrier: string;
  packNoticeCaveat?: string;
  packNoticeHookEvent?: string;
  resolveCommand(options?: AgentCommandOptions): ResolvedCommand;
  buildSpawnCommand(options: AgentSpawnCommandOptions): { file: string; args: string[] };
  buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv;
  buildArgs(options?: AgentArgsOptions): string[];
  renderPackArgs(deliveries: readonly PackDelivery[], builtRoot: string): string[] | null;
  settingsArgs?(settingsPath: string): string[];
  sessionIdOf?(payload: HookPayload): unknown;
}

type AgentAdapterShape = AgentAdapter & Record<string, unknown>;

const DEFAULT_AGENT_ID = claudeCode.id;

const adapterEntries: [string, AgentAdapter][] = [
  [claudeCode.id, claudeCode],
  [codex.id, codex],
  [grok.id, grok],
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
  for (const customId of customAdapters.keys()) resolvedCommands.delete(customId);
  customAdapters.clear();
  customAgentFingerprints.clear();
  for (const declaration of declared) {
    customAdapters.set(declaration.id, createCustomAdapter(declaration));
    customAgentFingerprints.set(declaration.id, declarationFingerprint(declaration));
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
  commandFor,
  customAgentFingerprint,
  resetCommandCache,
  setCustomAgents,
};
export type {
  AgentAdapter,
  AgentAdapterShape,
  AgentArgsOptions,
  AgentCapabilities,
  AgentCommandOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
  ArgvConfigInjection,
  HomeHooksFileInjection,
  HookInjection,
  ProjectConfigCandidate,
  SettingsFileInjection,
};
