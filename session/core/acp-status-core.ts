import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";

type AcpStatusInput =
  | { kind: "opened" }
  | { kind: "prompt-accepted" }
  | { kind: "update" }
  | { kind: "ask" }
  | { kind: "ask-answered"; askedInTurn: number }
  | { kind: "asks-closed" }
  | { kind: "turn-end"; survivingAskCount?: number };

type AcpStatusSignal =
  | "opened"
  | "prompt-accepted"
  | "update-in-turn"
  | "update-after-turn"
  | "ask-raised"
  | "ask-answered-others-open"
  | "last-ask-answered-in-turn"
  | "last-ask-answered-after-turn"
  | "ask-answered-after-its-turn-ended"
  | "asks-closed"
  | "turn-ended"
  | "turn-ended-with-ask";

interface AcpTurn {
  turnNumber: number;
  isPromptOpen: boolean;
  openAskCount: number;
}

const ACP_TURN_AT_START: AcpTurn = Object.freeze({ turnNumber: 0, isPromptOpen: false, openAskCount: 0 });

const ACP_STATUS_EVENTS: Readonly<Record<AcpStatusSignal, Readonly<Partial<Record<SessionState, string>>>>> = Object.freeze({
  opened: { [STATES.STARTING]: "first_output" },
  "prompt-accepted": { [STATES.IDLE]: "new_output", [STATES.COMPLETE]: "new_output", [STATES.WAITING]: "user_input" },
  "update-in-turn": {},
  "update-after-turn": {},
  "ask-raised": { [STATES.RUNNING]: "prompt_detected", [STATES.IDLE]: "prompt_detected", [STATES.COMPLETE]: "prompt_detected" },
  "ask-answered-others-open": {},
  "last-ask-answered-in-turn": { [STATES.WAITING]: "user_input" },
  "last-ask-answered-after-turn": { [STATES.WAITING]: "task_complete" },
  "ask-answered-after-its-turn-ended": {},
  "asks-closed": {},
  "turn-ended": { [STATES.RUNNING]: "task_complete", [STATES.WAITING]: "task_complete" },
  "turn-ended-with-ask": {},
});

function stepAcpStatus(turn: AcpTurn, input: AcpStatusInput): { turn: AcpTurn; signal: AcpStatusSignal } {
  switch (input.kind) {
    case "opened":
      return { turn: { ...ACP_TURN_AT_START, turnNumber: turn.turnNumber + 1 }, signal: "opened" };
    case "prompt-accepted":
      return { turn: { ...turn, isPromptOpen: true }, signal: "prompt-accepted" };
    case "update":
      return { turn, signal: turn.isPromptOpen ? "update-in-turn" : "update-after-turn" };
    case "ask":
      return { turn: { ...turn, openAskCount: turn.openAskCount + 1 }, signal: "ask-raised" };
    case "ask-answered": {
      if (input.askedInTurn !== turn.turnNumber || turn.openAskCount === 0) return { turn, signal: "ask-answered-after-its-turn-ended" };
      const answered = { ...turn, openAskCount: turn.openAskCount - 1 };
      if (answered.openAskCount > 0) return { turn: answered, signal: "ask-answered-others-open" };
      return { turn: answered, signal: answered.isPromptOpen ? "last-ask-answered-in-turn" : "last-ask-answered-after-turn" };
    }
    case "asks-closed":
      return { turn: { ...turn, openAskCount: 0 }, signal: "asks-closed" };
    case "turn-end": {
      const surviving = input.survivingAskCount ?? 0;
      if (surviving > 0) return { turn: { ...turn, isPromptOpen: false, openAskCount: surviving }, signal: "turn-ended-with-ask" };
      return { turn: { turnNumber: turn.turnNumber + 1, isPromptOpen: false, openAskCount: 0 }, signal: "turn-ended" };
    }
  }
}

function acpStatusEventFor(signal: AcpStatusSignal, state: SessionState): string | null {
  return ACP_STATUS_EVENTS[signal][state] ?? null;
}

export { ACP_TURN_AT_START, acpStatusEventFor, stepAcpStatus };
export type { AcpStatusInput, AcpTurn };
