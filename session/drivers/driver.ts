import type { McpServer, PermissionOption, SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk";
import type { DeliverOptions, DeliveryOutcome } from "../core/input-delivery-core.ts";

interface DriverLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  scopeUnit: string | null;
  resumeAgentSessionId: string | null;
}

type DriverFailureStage = "open" | "prompt";

type DriverPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

interface DriverPermissionRequest {
  toolCallId: string;
  title: string | null;
  toolKind: ToolKind | null;
  rawInput: unknown;
  locationPaths: readonly string[];
  options: readonly PermissionOption[];
  withdrawn: AbortSignal;
  respond(outcome: DriverPermissionOutcome): void;
}

type DriverQuestionAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

interface DriverQuestion {
  toolCallId: string | null;
  message: string | null;
  requestedSchema: Record<string, unknown>;
  withdrawn: AbortSignal;
  respond(answer: DriverQuestionAnswer): void;
}

type DriverEvent =
  | { kind: "output"; data: string }
  | { kind: "agent-session"; agentSessionId: string; isResumed: boolean }
  | { kind: "update"; agentSessionId: string; update: SessionUpdate }
  | { kind: "permission"; request: DriverPermissionRequest }
  | { kind: "question"; question: DriverQuestion }
  | { kind: "turn-end"; stopReason: StopReason }
  | { kind: "failure"; stage: DriverFailureStage; message: string }
  | { kind: "exit"; exitCode: number; signal: number | undefined };

type DriverListener = (event: DriverEvent) => void;

interface SessionDriver {
  readonly hasTerminal: boolean;
  readonly pid: number | null;
  readonly isLive: boolean;
  start(launch: DriverLaunch): void;
  send(text: string, options: DeliverOptions): DeliveryOutcome;
  interrupt(): void;
  stop(): boolean;
  subscribe(listener: DriverListener): () => void;
}

type SessionDriverChoice =
  | { kind: "pty" }
  | { kind: "acp"; command: { file: string; args: string[] }; mcpServers: McpServer[]; clientVersion: string };

const SESSION_DRIVER_EVENTS = Object.freeze({
  agentSession: "driver-agent-session",
  update: "driver-update",
  permission: "driver-permission",
  question: "driver-question",
  turnEnd: "driver-turn-end",
} as const);

interface SessionDriverEventPayloads {
  [SESSION_DRIVER_EVENTS.agentSession]: { agentSessionId: string; isResumed: boolean };
  [SESSION_DRIVER_EVENTS.update]: { agentSessionId: string; update: SessionUpdate; isInTurn: boolean };
  [SESSION_DRIVER_EVENTS.permission]: { request: DriverPermissionRequest };
  [SESSION_DRIVER_EVENTS.question]: { question: DriverQuestion };
  [SESSION_DRIVER_EVENTS.turnEnd]: { stopReason: StopReason };
}

export { SESSION_DRIVER_EVENTS };
export type {
  DriverEvent,
  DriverFailureStage,
  DriverLaunch,
  DriverListener,
  DriverPermissionOutcome,
  DriverPermissionRequest,
  DriverQuestion,
  DriverQuestionAnswer,
  SessionDriver,
  SessionDriverChoice,
  SessionDriverEventPayloads,
};
