import type { PermissionOption, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
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
  rawInput: unknown;
  options: readonly PermissionOption[];
  respond(outcome: DriverPermissionOutcome): void;
}

type DriverQuestionAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

interface DriverQuestion {
  toolCallId: string | null;
  message: string | null;
  requestedSchema: Record<string, unknown>;
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

export type { DriverEvent, DriverFailureStage, DriverLaunch, DriverListener, SessionDriver };
