import path from "node:path";

import { QUESTION_TOOL_HOLD_HOOK_EVENT, QUESTION_TOOL_HOLD_TIMEOUT_MS } from "../../shared/contracts/question-manager.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";
import { buildHookCommand } from "./hook-command-core.ts";

const ANTIGRAVITY_PLUGIN_NAME = "glimmervoid";
const AGENT_STATE_HOOK_EVENT = "AgentState";
const PLAIN_HOOK_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"] as const;
const TOOL_HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const ANTIGRAVITY_QUESTION_TOOL_NAME = "ask_question";
const ANTIGRAVITY_SUBAGENT_TOOL_NAME = "invoke_subagent";
const ENRICHED_PAYLOAD_KEYS: readonly string[] = ["agent_id", "isTurnOpen", "pendingToolName", "source", "tool_name", "tool_input"];
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
  const questionHoldHook = commandHook(relayLaunch, QUESTION_TOOL_HOLD_HOOK_EVENT);
  if (questionHoldHook === null) return null;
  hooks.PreToolUse?.push({ matcher: `^${ANTIGRAVITY_QUESTION_TOOL_NAME}$`, hooks: [{ ...questionHoldHook, timeout: QUESTION_HOLD_HOOK_TIMEOUT_SECONDS }] });
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

function toolCallOf(payload: HookPayloadRecord): { name: string | null; args: unknown } {
  const toolCall = payload.toolCall;
  if (typeof toolCall !== "object" || toolCall === null) return { name: null, args: null };
  const name = "name" in toolCall && typeof toolCall.name === "string" ? toolCall.name : null;
  return { name, args: "args" in toolCall ? toolCall.args : null };
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

function withAskUserQuestionFields(payload: HookPayloadRecord): HookPayloadRecord {
  const { name, args } = toolCallOf(payload);
  const toolInput = name === ANTIGRAVITY_QUESTION_TOOL_NAME ? askUserQuestionInputOf(args) : null;
  return toolInput === null ? payload : { ...payload, tool_name: ASK_USER_QUESTION_TOOL_NAME, tool_input: toolInput };
}

function createConversationTagger(): (event: string, payload: HookPayloadRecord) => HookPayloadRecord {
  const subagentConversationIds = new Set<string>();
  let isTurnOpen = false;
  let pendingToolName: string | null = null;
  let pendingSubagentStarts = 0;

  function tagAgentState(payload: HookPayloadRecord): HookPayloadRecord {
    const taggedPayload = { ...payload, isTurnOpen, pendingToolName };
    if (payload.agent_state === "idle" && !hasRunningSubagent(payload.subagents)) isTurnOpen = false;
    return taggedPayload;
  }

  function tagSubagentEvent(normalizedEvent: string, conversationId: string, payload: HookPayloadRecord): HookPayloadRecord {
    if (normalizedEvent === "stop") subagentConversationIds.delete(conversationId);
    return { ...payload, agent_id: conversationId };
  }

  function trackParentTurn(normalizedEvent: string, payload: HookPayloadRecord): void {
    if (normalizedEvent === "preinvocation") isTurnOpen = true;
    if (normalizedEvent === "stop" && payload.fullyIdle === true) isTurnOpen = false;
    if (normalizedEvent === "stop") pendingSubagentStarts = 0;
    if (normalizedEvent === "pretooluse") pendingToolName = toolCallOf(payload).name;
    if (normalizedEvent === "pretooluse" && pendingToolName === ANTIGRAVITY_SUBAGENT_TOOL_NAME) pendingSubagentStarts += 1;
    if (normalizedEvent === "posttooluse") pendingToolName = null;
  }

  return (event, payload) => {
    const normalizedEvent = event.toLowerCase();
    if (normalizedEvent === "agentstate") return tagAgentState(payload);
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null;
    const questionPayload = normalizedEvent === QUESTION_TOOL_HOLD_HOOK_EVENT ? withAskUserQuestionFields(payload) : payload;
    if (conversationId === null) return questionPayload;
    if (normalizedEvent === "sessionstart" && pendingSubagentStarts > 0) {
      pendingSubagentStarts -= 1;
      subagentConversationIds.add(conversationId);
    }
    if (subagentConversationIds.has(conversationId)) return tagSubagentEvent(normalizedEvent, conversationId, questionPayload);
    trackParentTurn(normalizedEvent, payload);
    if (normalizedEvent === "sessionstart" && !payload.source) return { ...payload, source: "startup" };
    return questionPayload;
  };
}

export { ANTIGRAVITY_PLUGIN_NAME, ANTIGRAVITY_QUESTION_TOOL_NAME, ENRICHED_PAYLOAD_KEYS, antigravitySessionSettings, createConversationTagger, hasRunningSubagent, packSkillWorkspacesOf, renderAntigravityPlugin };
