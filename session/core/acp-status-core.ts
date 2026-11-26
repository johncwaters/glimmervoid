import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";

type AcpStatusInput =
  | { kind: "opened" }
  | { kind: "prompt-accepted" }
  | { kind: "update" }
  | { kind: "ask" }
  | { kind: "ask-answered"; askedInTurn: number }
  | { kind: "turn-end" };

type AcpStatusSignal =
  | "opened"
  | "prompt-accepted"
  | "update-in-turn"
  | "update-after-turn"
  | "ask-raised"
  | "ask-answered-others-open"
  | "last-ask-answered-in-turn"
  | "ask-answered-after-its-turn-ended"
  | "turn-ended";

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
  "ask-answered-after-its-turn-ended": {},
  "turn-ended": { [STATES.RUNNING]: "task_complete", [STATES.WAITING]: "task_complete" },
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
      return { turn: answered, signal: answered.openAskCount > 0 ? "ask-answered-others-open" : "last-ask-answered-in-turn" };
    }
    case "turn-end":
      return { turn: { turnNumber: turn.turnNumber + 1, isPromptOpen: false, openAskCount: 0 }, signal: "turn-ended" };
  }
}

function acpStatusEventFor(signal: AcpStatusSignal, state: SessionState): string | null {
  return ACP_STATUS_EVENTS[signal][state] ?? null;
}

export { ACP_TURN_AT_START, acpStatusEventFor, stepAcpStatus };
export type { AcpStatusInput, AcpTurn };
