import type { ClientCapabilities, CreateElicitationRequest, InitializeRequest, InitializeResponse, McpServer, NewSessionRequest, RequestPermissionRequest, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { DeliverOptions, DeliveryOutcome } from "./input-delivery-core.ts";

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

function planSessionOpen(
  protocolVersion: number,
  initialized: InitializeResponse,
  cwd: string,
  mcpServers: McpServer[],
  resumeAgentSessionId: string | null,
): AcpSessionOpenPlan {
  if (initialized.protocolVersion !== protocolVersion) {
    return { method: "refuse", message: `the agent speaks ACP version ${initialized.protocolVersion}, not ${protocolVersion}` };
  }
  const sessionRequest = { cwd, mcpServers };
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

export { classifyAcpPromptError, decideAcpSend, doesUpdateConfirmPrompt, initializeRequestFor, permissionFieldsOf, planSessionOpen, questionFieldsOf };
export type { AcpPhase };
