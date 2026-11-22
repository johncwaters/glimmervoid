import path from "node:path";

import { QUESTION_TOOL_HOLD_HOOK_EVENT, QUESTION_TOOL_HOLD_TIMEOUT_MS } from "../../shared/contracts/question-manager.ts";
import { ASK_USER_QUESTION_TOOL_NAME, CONVERSATION_PERMISSION_HOOK_EVENT } from "../../shared/contracts/session.ts";
import { buildHookCommand } from "./hook-command-core.ts";
import { packSecretEnvName } from "../../mcp/core/agent-config.ts";
import { PACK_SECRET_ENV_FLAG, PACK_URL_FLAG } from "../../mcp/core/stdio-bridge-core.ts";
import type { PackMcpServer } from "../../shared/contracts/pack.ts";
import { ANTIGRAVITY_PACK_HOOK_FLAVOR, PACK_HOOK_RELAY_TIMEOUT_SECONDS, PACK_HOOK_RELAY_TOOL_ID, packHookToolNamesOf } from "./pack-hook-core.ts";
import { ANTIGRAVITY_SANE_YOLO_FLAVOR } from "./sane-yolo.ts";

const ANTIGRAVITY_PLUGIN_NAME = "glimmervoid";
const AGENT_STATE_HOOK_EVENT = "AgentState";
const PLAIN_HOOK_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"] as const;
const TOOL_HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const ANTIGRAVITY_QUESTION_TOOL_NAME = "ask_question";
const ANTIGRAVITY_SUBAGENT_TOOL_NAME = "invoke_subagent";
const ANTIGRAVITY_GATED_TOOL_NAMES: readonly string[] = ["run_command", "write_file", "edit_file", "create_file", "delete_file", "apply_patch"];
const ENRICHED_PAYLOAD_KEYS: readonly string[] = ["agent_id", "agent_transcript_path", "agent_type", "isTurnOpen", "pendingToolName", "prompt", "source", "tool_name", "tool_input"];
const QUESTION_HOLD_HOOK_TIMEOUT_SECONDS = Math.ceil(QUESTION_TOOL_HOLD_TIMEOUT_MS / 1000) + 10;

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

function packHooksEntry(packHookLaunch: readonly string[] | null): unknown[] | null {
  if (packHookLaunch === null) return [];
  const command = buildHookCommand(packHookLaunch, PACK_HOOK_RELAY_TOOL_ID, [ANTIGRAVITY_PACK_HOOK_FLAVOR]);
  if (command === null) return null;
  return [{ matcher: `^(?:${packHookToolNamesOf(ANTIGRAVITY_PACK_HOOK_FLAVOR).join("|")})$`, hooks: [{ type: "command", command, timeout: PACK_HOOK_RELAY_TIMEOUT_SECONDS }] }];
}

function saneYoloHooksEntry(saneYoloLaunch: readonly string[] | null): unknown[] | null {
  if (saneYoloLaunch === null) return [];
  const command = buildHookCommand(saneYoloLaunch, "saneYolo", [ANTIGRAVITY_SANE_YOLO_FLAVOR]);
  if (command === null) return null;
  return [{ matcher: "*", hooks: [{ type: "command", command }] }];
}

function hooksByEvent(
  relayLaunch: readonly string[],
  packHookLaunch: readonly string[] | null,
  saneYoloLaunch: readonly string[] | null,
): Record<string, unknown[]> | null {
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
  const questionHoldHook = commandHook(relayLaunch, QUESTION_TOOL_HOLD_HOOK_EVENT);
  if (questionHoldHook === null) return null;
  hooks.PreToolUse?.push({ matcher: `^${ANTIGRAVITY_QUESTION_TOOL_NAME}$`, hooks: [{ ...questionHoldHook, timeout: QUESTION_HOLD_HOOK_TIMEOUT_SECONDS }] });
  const permissionHoldHook = commandHook(relayLaunch, CONVERSATION_PERMISSION_HOOK_EVENT);
  if (permissionHoldHook === null) return null;
  hooks.PreToolUse?.push({ matcher: `^(?:${ANTIGRAVITY_GATED_TOOL_NAMES.join("|")})$`, hooks: [{ ...permissionHoldHook, timeout: QUESTION_HOLD_HOOK_TIMEOUT_SECONDS }] });
  const saneYoloEntries = saneYoloHooksEntry(saneYoloLaunch);
  if (saneYoloEntries === null) return null;
  hooks.PreToolUse?.push(...saneYoloEntries);
  const packHookEntries = packHooksEntry(packHookLaunch);
  if (packHookEntries === null) return null;
  hooks.PreToolUse?.push(...packHookEntries);
  return hooks;
}

function packServerEntry(server: PackMcpServer, bridgeCommand: string, bridgeArgs: readonly string[]): unknown {
  if (server.secret === undefined) return { serverUrl: server.url };
  return { command: bridgeCommand, args: [...bridgeArgs, `--${PACK_URL_FLAG}`, server.url, `--${PACK_SECRET_ENV_FLAG}`, packSecretEnvName(server.secret)] };
}

function renderAntigravityPlugin(
  relayLaunch: readonly string[],
  bridgeLaunch: readonly string[],
  packServers: readonly PackMcpServer[] = [],
  packHookLaunch: readonly string[] | null = null,
  saneYoloLaunch: readonly string[] | null = null,
): Record<AntigravityPluginFileName, string> | null {
  const hooks = hooksByEvent(relayLaunch, packHookLaunch, saneYoloLaunch);
  const [bridgeCommand, ...bridgeArgs] = bridgeLaunch;
  if (hooks === null || bridgeCommand === undefined) return null;
  const packEntries = Object.fromEntries(packServers.map((server) => [server.name, packServerEntry(server, bridgeCommand, bridgeArgs)]));
  return {
    "plugin.json": jsonFileText({ name: ANTIGRAVITY_PLUGIN_NAME, version: "1.0.0", description: "Reports session status to the Glimmervoid dashboard that started this session." }),
    "hooks.json": jsonFileText({ [ANTIGRAVITY_PLUGIN_NAME]: hooks }),
    "mcp_config.json": jsonFileText({ mcpServers: { ...packEntries, [ANTIGRAVITY_PLUGIN_NAME]: { command: bridgeCommand, args: bridgeArgs } } }),
  };
}

function antigravityInstalledHooks(): { event: string; matcher: string | null; route: string | null }[] {
  const plainHooks = PLAIN_HOOK_EVENTS.map((event) => ({ event, matcher: null, route: null }));
  const toolHooks = TOOL_HOOK_EVENTS.map((event) => ({ event, matcher: "*", route: null }));
  const agentStateHook = { event: AGENT_STATE_HOOK_EVENT, matcher: null, route: null };
  const questionHoldHook = { event: "PreToolUse", matcher: `^${ANTIGRAVITY_QUESTION_TOOL_NAME}$`, route: QUESTION_TOOL_HOLD_HOOK_EVENT };
  const permissionHoldHook = { event: "PreToolUse", matcher: `^(?:${ANTIGRAVITY_GATED_TOOL_NAMES.join("|")})$`, route: CONVERSATION_PERMISSION_HOOK_EVENT };
  const saneYoloHook = { event: "PreToolUse", matcher: "*", route: "saneYolo" };
  return [...plainHooks, ...toolHooks, agentStateHook, questionHoldHook, permissionHoldHook, saneYoloHook];
}

function antigravitySessionSettings(trustedFolders: readonly string[], relayLaunch: readonly string[]): string | null {
  const titleCommand = buildHookCommand(relayLaunch, AGENT_STATE_HOOK_EVENT);
  if (titleCommand === null) return null;
  return JSON.stringify({ trustedWorkspaces: trustedFolders, title: { type: "command", command: titleCommand } });
}

function packSkillWorkspacesOf(packSkillDirs: readonly string[]): string[] {
  return [...new Set(packSkillDirs.map((skillDir) => path.dirname(path.dirname(path.dirname(skillDir)))))];
}

type HookPayloadRecord = Record<string, unknown>;

function hasRunningSubagent(subagents: unknown): boolean {
  return Array.isArray(subagents) && subagents.some((subagent: unknown) => typeof subagent === "object" && subagent !== null && "status" in subagent && subagent.status === "running");
}

function hasRunningTask(taskCount: unknown): boolean {
  return typeof taskCount === "number" && taskCount > 0;
}

function toolCallOf(payload: HookPayloadRecord): { id: string | null; name: string | null; args: unknown } {
  const toolCall = payload.toolCall;
  if (typeof toolCall !== "object" || toolCall === null) return { id: null, name: null, args: null };
  const id = "id" in toolCall && typeof toolCall.id === "string" && toolCall.id ? toolCall.id : null;
  const name = "name" in toolCall && typeof toolCall.name === "string" ? toolCall.name : null;
  return { id, name, args: "args" in toolCall ? toolCall.args : null };
}

function askUserQuestionInputOf(questionArgs: unknown): Record<string, unknown> | null {
  if (typeof questionArgs !== "object" || questionArgs === null || !("questions" in questionArgs) || !Array.isArray(questionArgs.questions)) return null;
  const questions = questionArgs.questions.map((question: unknown) => {
    if (typeof question !== "object" || question === null) return question;
    const options = "options" in question && Array.isArray(question.options) ? question.options.map((option: unknown) => (typeof option === "string" ? { label: option } : option)) : [];
    const multiSelect = "is_multi_select" in question && question.is_multi_select === true;
    return { question: "question" in question ? question.question : null, options, multiSelect };
  });
  return { questions };
}

function withToolCallFields(payload: HookPayloadRecord): HookPayloadRecord {
  const { name, args } = toolCallOf(payload);
  if (name === null || typeof args !== "object" || args === null) return payload;
  return { ...payload, tool_name: name, tool_input: args };
}

function heldPayloadFor(normalizedEvent: string, payload: HookPayloadRecord): HookPayloadRecord {
  if (normalizedEvent === QUESTION_TOOL_HOLD_HOOK_EVENT) return withAskUserQuestionFields(payload);
  return withToolCallFields(payload);
}

function withAskUserQuestionFields(payload: HookPayloadRecord): HookPayloadRecord {
  const { name, args } = toolCallOf(payload);
  const toolInput = name === ANTIGRAVITY_QUESTION_TOOL_NAME ? askUserQuestionInputOf(args) : null;
  return toolInput === null ? payload : { ...payload, tool_name: ASK_USER_QUESTION_TOOL_NAME, tool_input: toolInput };
}

interface PendingSubagentMetadata {
  callId: string | null;
  typeName: string | null;
  role: string | null;
}

function subagentMetadataOf(callId: string | null, args: unknown): PendingSubagentMetadata {
  if (typeof args !== "object" || args === null) return { callId, typeName: null, role: null };
  const rawTypeName = "TypeName" in args && typeof args.TypeName === "string" ? args.TypeName.trim() : "";
  const rawRole = "Role" in args && typeof args.Role === "string" ? args.Role.trim() : "";
  return { callId, typeName: rawTypeName || null, role: rawRole || null };
}

function createConversationTagger(): (event: string, payload: HookPayloadRecord) => HookPayloadRecord {
  const subagentConversationIds = new Set<string>();
  const subagentMetadataById = new Map<string, PendingSubagentMetadata>();
  const pendingSubagentQueue: PendingSubagentMetadata[] = [];
  let isTurnOpen = false;
  let pendingToolName: string | null = null;
  let lastOperatorPrompt: string | null = null;
  let lastInjectedStepInput: string | null = null;

  function tagAgentState(payload: HookPayloadRecord): HookPayloadRecord {
    const { subagents, ...withoutSubagents } = payload;
    const isSubagentRunning = payload.hasRunningSubagent === true || hasRunningSubagent(subagents);
    const taggedPayload = { ...withoutSubagents, hasRunningSubagent: isSubagentRunning, isTurnOpen, pendingToolName };
    if (payload.agent_state === "idle" && !isSubagentRunning && !hasRunningTask(payload.task_count)) isTurnOpen = false;
    return taggedPayload;
  }

  function tagSubagentEvent(normalizedEvent: string, conversationId: string, payload: HookPayloadRecord): HookPayloadRecord {
    const metadata = subagentMetadataById.get(conversationId) ?? null;
    const enriched: HookPayloadRecord = { ...payload, agent_id: conversationId };
    if (metadata?.typeName) enriched.agent_type = metadata.typeName;
    if (normalizedEvent === "sessionstart" && (metadata?.typeName || metadata?.role)) {
      enriched.tool_input = {
        ...(metadata.typeName ? { subagent_type: metadata.typeName } : {}),
        ...(metadata.role ? { description: metadata.role } : {}),
      };
    }
    if (normalizedEvent === "stop") {
      if (typeof payload.transcriptPath === "string" && payload.transcriptPath) {
        enriched.agent_transcript_path = payload.transcriptPath;
      }
      subagentConversationIds.delete(conversationId);
      subagentMetadataById.delete(conversationId);
    }
    return enriched;
  }

  function trackParentTurn(normalizedEvent: string, payload: HookPayloadRecord): void {
    if (normalizedEvent === "preinvocation") isTurnOpen = true;
    if (normalizedEvent === "stop" && payload.fullyIdle === true) isTurnOpen = false;
    if (normalizedEvent === "stop") pendingSubagentQueue.length = 0;
    if (normalizedEvent === "pretooluse") {
      const { id, name, args } = toolCallOf(payload);
      pendingToolName = name;
      if (name === ANTIGRAVITY_SUBAGENT_TOOL_NAME) pendingSubagentQueue.push(subagentMetadataOf(id, args));
    }
    if (normalizedEvent === "posttooluse") {
      pendingToolName = null;
      const { id, name } = toolCallOf(payload);
      const hasToolError = typeof payload.error === "string" && payload.error.length > 0;
      if (name === ANTIGRAVITY_SUBAGENT_TOOL_NAME && hasToolError && pendingSubagentQueue.length > 0) {
        const failedIndex = id === null ? 0 : pendingSubagentQueue.findIndex((entry) => entry.callId === id);
        pendingSubagentQueue.splice(failedIndex >= 0 ? failedIndex : 0, 1);
      }
    }
  }

  function withOperatorPrompt(normalizedEvent: string, payload: HookPayloadRecord): HookPayloadRecord {
    if (normalizedEvent === "sessionstart") {
      lastOperatorPrompt = null;
      lastInjectedStepInput = null;
      return payload;
    }
    const inputText = typeof payload.lastUserInput === "string" ? payload.lastUserInput : "";
    if (!inputText) return payload;
    if (normalizedEvent !== "preinvocation" || payload.invocationNum !== 0) {
      if (inputText !== lastOperatorPrompt) lastInjectedStepInput = inputText;
      return payload;
    }
    if (inputText === lastOperatorPrompt || inputText === lastInjectedStepInput) return payload;
    lastOperatorPrompt = inputText;
    lastInjectedStepInput = null;
    return { ...payload, prompt: inputText };
  }

  return (event, payload) => {
    const normalizedEvent = event.toLowerCase();
    if (normalizedEvent === "agentstate") return tagAgentState(payload);
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null;
    const questionPayload = heldPayloadFor(normalizedEvent, payload);
    if (conversationId === null) return questionPayload;
    if (normalizedEvent === "sessionstart" && pendingSubagentQueue.length > 0) {
      const metadata = pendingSubagentQueue.shift() ?? { callId: null, typeName: null, role: null };
      subagentConversationIds.add(conversationId);
      subagentMetadataById.set(conversationId, metadata);
    }
    if (subagentConversationIds.has(conversationId)) return tagSubagentEvent(normalizedEvent, conversationId, questionPayload);
    trackParentTurn(normalizedEvent, payload);
    const parentPayload = withOperatorPrompt(normalizedEvent, questionPayload);
    if (normalizedEvent === "sessionstart" && !parentPayload.source) return { ...parentPayload, source: "startup" };
    return parentPayload;
  };
}

export { ANTIGRAVITY_PLUGIN_NAME, ANTIGRAVITY_QUESTION_TOOL_NAME, ENRICHED_PAYLOAD_KEYS, antigravityInstalledHooks, antigravitySessionSettings, createConversationTagger, hasRunningSubagent, hasRunningTask, packSkillWorkspacesOf, renderAntigravityPlugin };
