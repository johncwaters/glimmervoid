import type { ClientCapabilities, CreateElicitationRequest, InitializeRequest, InitializeResponse, McpServer, NewSessionRequest, RequestPermissionRequest, SessionModeState, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { isRecord } from "../../shared/coerce.ts";
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

type AcpSessionOpenPlan =
  | { method: "session/new"; request: NewSessionRequest }
  | { method: "session/load"; request: NewSessionRequest & { sessionId: string } }
  | { method: "refuse"; message: string };

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

function acpCodexSaneYoloEnvFor(
  env: Record<string, string | undefined>,
  agentId: string,
  tool: ResolvedHookTool | undefined,
  homeDir: string,
): CodexSaneYoloEnv {
  if (agentId !== CODEX_AGENT_ID || tool === undefined) return { env, hookCommand: null };
  const entry = HOOK_TOOLS.saneYolo.codexEntry(tool);
  if (entry === null) return { env, hookCommand: null };
  const existingEntry = existingCodexConfigValue(env);
  if (!existingEntry.ok) return { env, hookCommand: null };
  const existingConfig = parseExistingCodexConfig(existingEntry.value);
  if (existingConfig === null) return { env, hookCommand: null };
  const existingHooks = existingConfig.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) return { env, hookCommand: null };
  const existingPreToolUse = existingHooks?.PreToolUse;
  if (existingPreToolUse !== undefined && !Array.isArray(existingPreToolUse)) return { env, hookCommand: null };
  const mergedConfig: Record<string, unknown> = {
    ...existingConfig,
    hooks: {
      ...(existingHooks ?? {}),
      PreToolUse: [...(existingPreToolUse ?? []), entry],
    },
  };
  const nextEnv: Record<string, string | undefined> = { ...env };
  for (const key of existingEntry.keys) delete nextEnv[key];
  for (const key of Object.keys(nextEnv)) {
    const upperKey = key.toUpperCase();
    if (SAFETY_NET_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) delete nextEnv[key];
  }
  Object.assign(nextEnv, saneYoloEnv(homeDir));
  nextEnv[CODEX_CONFIG_ENV] = JSON.stringify(mergedConfig);
  return { env: nextEnv, hookCommand: entry.hooks[0].command };
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
): AcpSessionOpenPlan {
  if (initialized.protocolVersion !== protocolVersion) {
    return { method: "refuse", message: `the agent speaks ACP version ${initialized.protocolVersion}, not ${protocolVersion}` };
  }
  const sessionRequest = sessionMeta === undefined ? { cwd, mcpServers } : { cwd, mcpServers, _meta: sessionMeta };
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
  acpCodexSaneYoloEnvFor,
  acpSaneYoloMetaFor,
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
  planSessionOpen,
  questionFieldsOf,
};
export type { AcpPhase };
