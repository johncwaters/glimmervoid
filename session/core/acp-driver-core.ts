import type { ClientCapabilities, CreateElicitationRequest, InitializeRequest, InitializeResponse, McpServer, NewSessionRequest, RequestPermissionRequest, SessionModeState, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { EFFORT_OPTION_ID, OPENROUTER_KEY_NAME } from "../../shared/agent-models-core.ts";
import { isRecord } from "../../shared/coerce.ts";
import type { ModelSelection } from "../../shared/contracts/agent-models.ts";
import { AGENT_URL_ENV, GIT_CREDENTIAL_URL_ENV, SIGN_URL_ENV } from "../../shared/contracts/session.ts";
import type { DeliverOptions, DeliveryOutcome } from "./input-delivery-core.ts";
import { HOOK_TOOLS } from "./hook-tools.ts";
import type { ResolvedHookTool } from "./hook-tools.ts";
import { saneYoloEnv } from "./sane-yolo.ts";
import { withoutGlimmervoidSecrets } from "./spawn-env.ts";

type AcpPhase = "idle" | "opening" | "ready" | "closed";

interface AcpSendFacts {
  phase: AcpPhase;
  isPromptOpen: boolean;
}

type AcpSendDecision =
  | { action: "prompt"; outcome: DeliveryOutcome }
  | { action: "refuse"; outcome: DeliveryOutcome };

interface AcpPromptErrorFacts {
  isRequestError: boolean;
  isConnectionAlive: boolean;
  message: string;
}

type AcpPromptErrorDecision =
  | { action: "end-turn"; settlement: "dropped"; failureMessage: string }
  | { action: "fail-driver"; settlement: "dropped"; failureMessage: null };

const PROMPT_CONFIRMING_UPDATES: ReadonlySet<SessionUpdate["sessionUpdate"]> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "subagent_update",
]);

interface AcpAppendSystemPrompt {
  mode: "append";
  content: [{ type: "text"; text: string }];
}

type AcpSessionRequest = NewSessionRequest & { systemPrompt?: AcpAppendSystemPrompt };

type AcpSessionOpenPlan =
  | { method: "session/new"; request: AcpSessionRequest }
  | { method: "session/load"; request: AcpSessionRequest & { sessionId: string } }
  | { method: "refuse"; message: string };

type AcpConfigOptionCategory = "model" | "thought_level";

type AcpConfigOptionStep =
  | { kind: "set"; configId: string; value: string }
  | { kind: "skip"; reason: "not-requested" | "already-set" }
  | { kind: "warn"; message: string };

interface AcpSessionMetaInput {
  agentId: string;
  saneYoloTool?: ResolvedHookTool;
  saneYoloHomeDir?: string;
  isCleanHome?: boolean;
  claudePluginDirs?: readonly string[];
}

interface AcpQuestionFields {
  toolCallId: string | null;
  message: string | null;
  requestedSchema: Record<string, unknown>;
}

const ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
  subagents: {},
};

function initializeRequestFor(protocolVersion: number, clientName: string, clientVersion: string): InitializeRequest {
  return {
    protocolVersion,
    clientCapabilities: ACP_CLIENT_CAPABILITIES,
    clientInfo: { name: clientName, version: clientVersion },
  };
}

const CLAUDE_AGENT_ID = "claude-code";
const CLAUDE_ASKING_MODE_ID = "default";
const CODEX_AGENT_ID = "codex";
const CODEX_HOOKS_LIST_METHOD = "_codex/hooks/list";
const CODEX_HOOKS_TRUST_METHOD = "_codex/hooks/trust";
const CODEX_CONFIG_ENV = "CODEX_CONFIG";
const SAFETY_NET_ENV_PREFIXES: readonly string[] = ["CC_SAFETY_NET_", "SAFETY_NET_"];

type AcpOpeningModePlan =
  | { kind: "none" }
  | { kind: "already-asking" }
  | { kind: "set-mode"; modeId: string }
  | { kind: "unreachable" };

interface CodexSaneYoloEnv {
  env: Record<string, string | undefined>;
  hookCommand: string | null;
  warning?: string;
}

interface MatchedCodexSaneYoloHook {
  key: string;
  currentHash: string;
  isTrusted: boolean;
}

const codexListedHookSchema = z.object({
  key: z.string().min(1),
  eventName: z.string(),
  handlerType: z.string().optional(),
  async: z.boolean().optional(),
  matcher: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  source: z.string().optional(),
  currentHash: z.string().min(1),
  trustStatus: z.string().optional(),
  enabled: z.boolean().optional(),
});

const codexHooksListResultSchema = z.object({
  hooks: z.array(z.unknown()),
});

function parseExistingCodexConfig(rawConfig: string | undefined): Record<string, unknown> | null {
  if (rawConfig === undefined || rawConfig.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(rawConfig);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function existingCodexConfigValue(env: Record<string, string | undefined>): { ok: true; value: string | undefined; keys: string[] } | { ok: false } {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === CODEX_CONFIG_ENV);
  if (keys.length === 0) return { ok: true, value: undefined, keys };
  if (keys.length > 1) return { ok: false };
  return { ok: true, value: env[keys[0]], keys };
}

const CODEX_OPENROUTER_PROVIDER_ID = "glimmervoid-openrouter";
const CODEX_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CLAUDE_CLEAN_HOME_SETTING_SOURCES: readonly string[] = Object.freeze(["project", "local"]);

const acpSelectOptionEntrySchema = z.object({
  value: z.string(),
});

const acpSelectOptionGroupSchema = z.object({
  options: z.array(acpSelectOptionEntrySchema),
});

const acpConfigOptionSchema = z.object({
  id: z.string().min(1),
  category: z.string().nullable().optional(),
  type: z.string(),
  currentValue: z.unknown(),
  options: z.array(z.union([acpSelectOptionEntrySchema, acpSelectOptionGroupSchema])).optional(),
});

function offeredValuesOf(options: readonly (z.infer<typeof acpSelectOptionEntrySchema> | z.infer<typeof acpSelectOptionGroupSchema>)[] | undefined): string[] {
  if (!options) return [];
  return options.flatMap((entry) => ("options" in entry ? entry.options.map((nested) => nested.value) : [entry.value]));
}

function wantedAcpConfigValues(agentId: string, setup: ModelSelection | null | undefined): { model: string | null; effort: string | null } {
  if (!setup || setup.agent !== agentId) return { model: null, effort: null };
  const effort = setup.options.find((option) => option.id === EFFORT_OPTION_ID)?.value ?? null;
  const model = agentId === CLAUDE_AGENT_ID && setup.provider === "openrouter" ? null : setup.model;
  return { model, effort };
}

function planAcpConfigOption(
  configOptions: unknown,
  category: AcpConfigOptionCategory,
  wantedValue: string | null,
): AcpConfigOptionStep {
  if (wantedValue === null || wantedValue === "") return { kind: "skip", reason: "not-requested" };
  if (!Array.isArray(configOptions)) {
    return { kind: "warn", message: `ACP agent returned no configOptions list; ignoring configured ${category} "${wantedValue}"` };
  }
  for (const candidate of configOptions) {
    const parsedOption = acpConfigOptionSchema.safeParse(candidate);
    if (!parsedOption.success) continue;
    const option = parsedOption.data;
    if (option.category !== category) continue;
    if (option.type !== "select") {
      return { kind: "warn", message: `ACP config option "${option.id}" (${category}) is type "${option.type}", not select; ignoring "${wantedValue}"` };
    }
    const offeredValues = offeredValuesOf(option.options);
    if (!offeredValues.includes(wantedValue)) {
      return { kind: "warn", message: `ACP config option "${option.id}" (${category}) does not offer "${wantedValue}"; keeping "${String(option.currentValue)}"` };
    }
    if (option.currentValue === wantedValue) return { kind: "skip", reason: "already-set" };
    return { kind: "set", configId: option.id, value: wantedValue };
  }
  return { kind: "warn", message: `ACP agent did not advertise a "${category}" config option; ignoring configured value "${wantedValue}"` };
}

function acpCodexProviderConfigFor(
  agentId: string,
  setup: ModelSelection | null | undefined,
  platform: NodeJS.Platform,
): Record<string, unknown> | null {
  if (agentId !== CODEX_AGENT_ID || setup?.agent !== CODEX_AGENT_ID || setup.provider !== "openrouter") return null;
  const auth = platform === "win32"
    ? { command: "powershell", args: ["-NoProfile", "-Command", `Write-Output $env:${OPENROUTER_KEY_NAME}`] }
    : { command: "sh", args: ["-c", `echo $${OPENROUTER_KEY_NAME}`] };
  return {
    model_provider: CODEX_OPENROUTER_PROVIDER_ID,
    model_providers: {
      [CODEX_OPENROUTER_PROVIDER_ID]: {
        name: "OpenRouter",
        base_url: CODEX_OPENROUTER_BASE_URL,
        auth,
      },
    },
  };
}

function mergeCodexProviderConfig(
  baseConfig: Record<string, unknown>,
  providerConfig: Record<string, unknown> | null,
): Record<string, unknown> {
  if (providerConfig === null) return baseConfig;
  const existingProviders = isRecord(baseConfig.model_providers) ? baseConfig.model_providers : {};
  const addedProviders = isRecord(providerConfig.model_providers) ? providerConfig.model_providers : {};
  return {
    ...baseConfig,
    ...providerConfig,
    model_providers: { ...existingProviders, ...addedProviders },
  };
}

function acpCodexSaneYoloEnvFor(
  env: Record<string, string | undefined>,
  agentId: string,
  tool: ResolvedHookTool | undefined,
  homeDir: string,
  providerConfig: Record<string, unknown> | null = null,
): CodexSaneYoloEnv {
  if (agentId !== CODEX_AGENT_ID) return { env, hookCommand: null };
  const entry = tool === undefined ? null : HOOK_TOOLS.saneYolo.codexEntry(tool);
  if (entry === null && providerConfig === null) return { env, hookCommand: null };
  const existingEntry = existingCodexConfigValue(env);
  if (!existingEntry.ok) {
    return providerConfig === null
      ? { env, hookCommand: null }
      : { env, hookCommand: null, warning: "inherited CODEX_CONFIG has duplicate case-variant keys; Codex provider config was not applied" };
  }
  const existingConfig = parseExistingCodexConfig(existingEntry.value);
  if (existingConfig === null) {
    return providerConfig === null
      ? { env, hookCommand: null }
      : { env, hookCommand: null, warning: "inherited CODEX_CONFIG is not a JSON object; Codex provider config was not applied" };
  }
  let mergedConfig = mergeCodexProviderConfig(existingConfig, providerConfig);
  let hookCommand: string | null = null;
  if (entry !== null) {
    const existingHooks = mergedConfig.hooks;
    const isHooksValid = existingHooks === undefined || isRecord(existingHooks);
    const existingPreToolUse = isHooksValid && isRecord(existingHooks) ? existingHooks.PreToolUse : undefined;
    const isPreToolUseValid = existingPreToolUse === undefined || Array.isArray(existingPreToolUse);
    if (isHooksValid && isPreToolUseValid) {
      mergedConfig = {
        ...mergedConfig,
        hooks: {
          ...(isRecord(existingHooks) ? existingHooks : {}),
          PreToolUse: [...(Array.isArray(existingPreToolUse) ? existingPreToolUse : []), entry],
        },
      };
      hookCommand = entry.hooks[0].command;
    }
    if ((!isHooksValid || !isPreToolUseValid) && providerConfig === null) {
      return { env, hookCommand: null };
    }
  }
  const nextEnv: Record<string, string | undefined> = { ...env };
  for (const key of existingEntry.keys) delete nextEnv[key];
  if (hookCommand !== null) {
    for (const key of Object.keys(nextEnv)) {
      const upperKey = key.toUpperCase();
      if (SAFETY_NET_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) delete nextEnv[key];
    }
    Object.assign(nextEnv, saneYoloEnv(homeDir));
  }
  nextEnv[CODEX_CONFIG_ENV] = JSON.stringify(mergedConfig);
  return { env: nextEnv, hookCommand };
}

function findCodexSaneYoloHook(listResult: unknown, expectedCommand: string): MatchedCodexSaneYoloHook | null {
  const parsed = codexHooksListResultSchema.safeParse(listResult);
  if (!parsed.success) return null;
  for (const candidate of parsed.data.hooks) {
    const hookResult = codexListedHookSchema.safeParse(candidate);
    if (!hookResult.success) continue;
    const hook = hookResult.data;
    if (
      hook.source === "sessionFlags"
      && hook.eventName === "preToolUse"
      && hook.handlerType === "command"
      && hook.async === false
      && hook.matcher === "Bash"
      && hook.command === expectedCommand
      && hook.enabled === true
    ) {
      return { key: hook.key, currentHash: hook.currentHash, isTrusted: hook.trustStatus === "trusted" };
    }
  }
  return null;
}

function isCodexHooksTrustConfirmed(trustResult: unknown): boolean {
  return isRecord(trustResult) && trustResult.trusted === true;
}

function acpSaneYoloMetaFor(agentId: string, tool: ResolvedHookTool | undefined, homeDir: string): Record<string, unknown> | undefined {
  if (agentId !== CLAUDE_AGENT_ID || tool === undefined) return undefined;
  return {
    claudeCode: {
      options: {
        settings: { hooks: { PreToolUse: [HOOK_TOOLS.saneYolo.claudeEntry(tool)] } },
        env: HOOK_TOOLS.saneYolo.env(tool, homeDir),
      },
    },
  };
}

function acpSessionMetaFor({
  agentId,
  saneYoloTool,
  saneYoloHomeDir = "",
  isCleanHome = false,
  claudePluginDirs = [],
}: AcpSessionMetaInput): Record<string, unknown> | undefined {
  if (agentId !== CLAUDE_AGENT_ID) return undefined;
  const claudeOptions: Record<string, unknown> = {};
  if (saneYoloTool !== undefined) {
    claudeOptions.settings = { hooks: { PreToolUse: [HOOK_TOOLS.saneYolo.claudeEntry(saneYoloTool)] } };
    claudeOptions.env = HOOK_TOOLS.saneYolo.env(saneYoloTool, saneYoloHomeDir);
  }
  if (isCleanHome) claudeOptions.settingSources = [...CLAUDE_CLEAN_HOME_SETTING_SOURCES];
  if (claudePluginDirs.length > 0) {
    claudeOptions.plugins = claudePluginDirs.map((pluginPath) => ({ type: "local", path: pluginPath }));
  }
  if (Object.keys(claudeOptions).length === 0) return undefined;
  return { claudeCode: { options: claudeOptions } };
}

function supportsAcpSystemPrompt(initialized: InitializeResponse): boolean {
  const sessionCapabilities = initialized.agentCapabilities?.sessionCapabilities;
  return isRecord(sessionCapabilities) && isRecord(sessionCapabilities.systemPrompt);
}

function acpPackSystemPromptFor(
  contextLines: readonly string[] | undefined,
  hasSystemPromptSupport: boolean,
): AcpAppendSystemPrompt | undefined {
  if (!hasSystemPromptSupport || !contextLines || contextLines.length === 0) return undefined;
  const text = contextLines.map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
  if (text.length === 0) return undefined;
  return { mode: "append", content: [{ type: "text", text }] };
}

function openingModePlanFor(agentId: string, hasSaneYolo: boolean, modes: SessionModeState | null | undefined): AcpOpeningModePlan {
  if (agentId !== CLAUDE_AGENT_ID || !hasSaneYolo) return { kind: "none" };
  if (modes === null || modes === undefined || typeof modes !== "object") return { kind: "unreachable" };
  if (modes.currentModeId === CLAUDE_ASKING_MODE_ID) return { kind: "already-asking" };
  if (!Array.isArray(modes.availableModes)) return { kind: "unreachable" };
  const hasAskingMode = modes.availableModes.some((mode) => typeof mode === "object" && mode !== null && mode.id === CLAUDE_ASKING_MODE_ID);
  return hasAskingMode ? { kind: "set-mode", modeId: CLAUDE_ASKING_MODE_ID } : { kind: "unreachable" };
}

function isAcpSaneYoloCovered(agentId: string, hasSaneYolo: boolean, hasHookConfig: boolean, isConfirmed: boolean): boolean {
  return (agentId === CLAUDE_AGENT_ID || agentId === CODEX_AGENT_ID) && hasSaneYolo && hasHookConfig && isConfirmed;
}

function planSessionOpen(
  protocolVersion: number,
  initialized: InitializeResponse,
  cwd: string,
  mcpServers: McpServer[],
  resumeAgentSessionId: string | null,
  sessionMeta?: Record<string, unknown>,
  systemPrompt?: AcpAppendSystemPrompt,
): AcpSessionOpenPlan {
  if (initialized.protocolVersion !== protocolVersion) {
    return { method: "refuse", message: `the agent speaks ACP version ${initialized.protocolVersion}, not ${protocolVersion}` };
  }
  const sessionRequest: AcpSessionRequest = {
    cwd,
    mcpServers,
    ...(sessionMeta === undefined ? {} : { _meta: sessionMeta }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
  if (resumeAgentSessionId === null) return { method: "session/new", request: sessionRequest };
  if (initialized.agentCapabilities?.loadSession !== true) {
    return { method: "refuse", message: "the agent does not offer session/load, so the conversation cannot resume" };
  }
  return { method: "session/load", request: { ...sessionRequest, sessionId: resumeAgentSessionId } };
}

function decideAcpSend(facts: AcpSendFacts, options: DeliverOptions): AcpSendDecision {
  const noAgent: AcpSendDecision = { action: "refuse", outcome: { ok: false, kind: "refused", reason: "no-pty" } };
  const busy: AcpSendDecision = { action: "refuse", outcome: { ok: false, kind: "refused", reason: "not-idle" } };
  if (!options.submit) return noAgent;
  if (facts.phase === "idle" || facts.phase === "closed") return noAgent;
  if (facts.phase === "opening" || facts.isPromptOpen) return busy;
  return { action: "prompt", outcome: { ok: true, kind: "pasted" } };
}

function classifyAcpPromptError(facts: AcpPromptErrorFacts): AcpPromptErrorDecision {
  if (facts.isRequestError && facts.isConnectionAlive) {
    return { action: "end-turn", settlement: "dropped", failureMessage: facts.message };
  }
  return { action: "fail-driver", settlement: "dropped", failureMessage: null };
}

function doesUpdateConfirmPrompt(update: SessionUpdate): boolean {
  return PROMPT_CONFIRMING_UPDATES.has(update.sessionUpdate);
}

function questionFieldsOf(request: CreateElicitationRequest): AcpQuestionFields | null {
  if (request.mode !== "form" || !("requestedSchema" in request)) return null;
  const toolCallId = "toolCallId" in request && typeof request.toolCallId === "string" ? request.toolCallId : null;
  const message = request.message.length > 0 ? request.message : null;
  return { toolCallId, message, requestedSchema: request.requestedSchema as Record<string, unknown> };
}

interface AcpPermissionFields {
  toolCallId: string;
  title: string | null;
  toolKind: ToolKind | null;
  rawInput: unknown;
  locationPaths: string[];
}

function permissionFieldsOf(request: RequestPermissionRequest): AcpPermissionFields {
  return {
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? null,
    toolKind: request.toolCall.kind ?? null,
    rawInput: request.toolCall.rawInput,
    locationPaths: (request.toolCall.locations ?? []).map((location) => location.path),
  };
}

const ACP_ALLOWED_SESSION_ENV_KEYS: ReadonlySet<string> = new Set([AGENT_URL_ENV, SIGN_URL_ENV, GIT_CREDENTIAL_URL_ENV]);
const NPM_CONFIG_ENV_PREFIX = "npm_config_";

function acpSpawnEnvFor(
  env: Record<string, string | undefined>,
  sessionEnv?: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const scrubbed = withoutGlimmervoidSecrets(env);
  for (const key of Object.keys(scrubbed)) {
    if (key.toLowerCase().startsWith(NPM_CONFIG_ENV_PREFIX)) delete scrubbed[key];
  }
  if (!sessionEnv) return scrubbed;
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (ACP_ALLOWED_SESSION_ENV_KEYS.has(key) && value !== "") scrubbed[key] = value;
  }
  return scrubbed;
}

function pickAcpSessionEnv(env: Record<string, string | undefined>, mintedKeys: Iterable<string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of mintedKeys) {
    const value = env[key];
    if (ACP_ALLOWED_SESSION_ENV_KEYS.has(key) && typeof value === "string" && value !== "") picked[key] = value;
  }
  return picked;
}

function mergeAcpMcpServers(staticServers: readonly McpServer[], dynamicServers: readonly McpServer[]): McpServer[] {
  if (dynamicServers.length === 0) return [...staticServers];
  const dynamicNames = new Set(dynamicServers.map((server) => server.name));
  return [...staticServers.filter((server) => !dynamicNames.has(server.name)), ...dynamicServers];
}

export {
  CODEX_HOOKS_LIST_METHOD,
  CODEX_HOOKS_TRUST_METHOD,
  acpCodexProviderConfigFor,
  acpCodexSaneYoloEnvFor,
  acpPackSystemPromptFor,
  acpSaneYoloMetaFor,
  acpSessionMetaFor,
  acpSpawnEnvFor,
  classifyAcpPromptError,
  decideAcpSend,
  doesUpdateConfirmPrompt,
  findCodexSaneYoloHook,
  initializeRequestFor,
  isAcpSaneYoloCovered,
  isCodexHooksTrustConfirmed,
  mergeAcpMcpServers,
  openingModePlanFor,
  permissionFieldsOf,
  pickAcpSessionEnv,
  planAcpConfigOption,
  planSessionOpen,
  questionFieldsOf,
  supportsAcpSystemPrompt,
  wantedAcpConfigValues,
};
export type { AcpPhase };
