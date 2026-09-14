import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";
import { TRANSITIONS } from "./state-machine.ts";

type LifecycleEvent = "new_output" | "user_input" | "task_complete" | "prompt_detected";

function mapSignalToEvent(
  signal: string,
  state: string,
  confidence?: string,
  activeAgents = 0,
): LifecycleEvent | null {
  switch (signal) {
    case "working":
    case "resume":

      if (state === STATES.IDLE || state === STATES.COMPLETE) return "new_output";
      if (state === STATES.WAITING) return "user_input";
      return null;
    case "ready":

      if (activeAgents > 0) return null;

      if (state === STATES.RUNNING) return "task_complete";
      if ((state === STATES.WAITING || state === STATES.IDLE) && confidence === "high") {
        return "task_complete";
      }
      return null;
    case "awaiting-input":

      if (state === STATES.RUNNING || state === STATES.IDLE || state === STATES.COMPLETE) {
        return "prompt_detected";
      }
      return null;
    case "session-start":
    case "session-end":

      return null;
    default:
      return null;
  }
}

const STARTUP_STATES: readonly SessionState[] = Object.freeze([
  STATES.DORMANT,
  STATES.INITIALIZING,
  STATES.STARTING,
]);

function acceptsAttentionSignal(state: SessionState): boolean {
  if (mapSignalToEvent("awaiting-input", state, "high", 0) !== "prompt_detected") return false;
  return "prompt_detected" in TRANSITIONS[state];
}

function shouldDeferAttention(state: SessionState): boolean {
  if (acceptsAttentionSignal(state)) return false;
  return STARTUP_STATES.includes(state);
}

export { acceptsAttentionSignal, mapSignalToEvent, shouldDeferAttention };
export type { LifecycleEvent };
