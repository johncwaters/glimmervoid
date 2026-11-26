import type { DeliverOptions, DeliveryOutcome } from "../core/input-delivery-core.ts";

interface DriverLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  scopeUnit: string | null;
}

type DriverStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

type DriverUpdate = { sessionUpdate: string } & Record<string, unknown>;

interface DriverPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

type DriverPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

interface DriverPermissionRequest {
  toolCallId: string;
  title: string | null;
  rawInput: unknown;
  options: readonly DriverPermissionOption[];
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
  | { kind: "update"; update: DriverUpdate }
  | { kind: "permission"; request: DriverPermissionRequest }
  | { kind: "question"; question: DriverQuestion }
  | { kind: "turn-end"; stopReason: DriverStopReason }
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

export type { DriverEvent, DriverLaunch, DriverListener, SessionDriver };
