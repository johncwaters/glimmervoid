import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";
import { COMPACTION_RESTORE_EVENTS } from "../../shared/compaction-restore-events.ts";
import { isWaitingOnHookRaisedPrompt } from "./waiting-input-core.ts";

type SettledState = typeof STATES.IDLE | typeof STATES.COMPLETE | typeof STATES.WAITING;

interface CompactionHeldReady {
  source: string | null | undefined;
  signal: string;
  confidence: string;
  state: SessionState;
  ts: number;
  agentWorkExpiriesAtHold: number;
  shellWorkExpiriesAtHold: number;
  hadWorkAtHold: boolean;
}

type SettledReturnState = {
  kind: "settled";
  state: SettledState;
  pendingPromptKind: string | null;
  pendingPromptToolName: string | null;
};

type HeldReadyReturnState = {
  kind: "held-ready";
  heldReady: CompactionHeldReady;
};

type CompactionReturnState = SettledReturnState | HeldReadyReturnState;

interface CompactionTracking {
  isCompacting: boolean;
  hasPromptInFlight: boolean;
  hasFinishedCompaction: boolean;
  idleTitleState: CompactionReturnState | null;
  returnState: CompactionReturnState | null;
}

interface CompactionObservation {
  signal: string;
  state: SessionState;
  source?: string | null;
  pendingPromptKind?: string | null;
  pendingPromptToolName?: string | null;
  heldReady?: CompactionHeldReady | null;
}

function createCompactionTracking(): CompactionTracking {
  return { isCompacting: false, hasPromptInFlight: false, hasFinishedCompaction: false, idleTitleState: null, returnState: null };
}

function returnStateOf(observation: CompactionObservation): CompactionReturnState | null {
  const { state, heldReady } = observation;
  if (state === STATES.RUNNING && heldReady) return { kind: "held-ready", heldReady };
  if (state !== STATES.IDLE && state !== STATES.COMPLETE && state !== STATES.WAITING) return null;
  return {
    kind: "settled",
    state,
    pendingPromptKind: observation.pendingPromptKind ?? null,
    pendingPromptToolName: observation.pendingPromptToolName ?? null,
  };
}

function observeCompaction(tracking: CompactionTracking, observation: CompactionObservation): CompactionTracking {
  const { signal, source } = observation;
  if (signal === "resume") return { ...tracking, isCompacting: false, hasPromptInFlight: true, idleTitleState: null, returnState: null };
  if (signal === "stop") return { ...tracking, isCompacting: false, hasPromptInFlight: false, idleTitleState: null, returnState: null };
  if (signal === "settled") return { ...tracking, hasPromptInFlight: observation.state === STATES.COMPLETE ? false : tracking.hasPromptInFlight, idleTitleState: null, returnState: null };
  if (signal === "ready") {
    if (tracking.idleTitleState?.kind !== "held-ready") return tracking;
    return { ...tracking, idleTitleState: null };
  }
  if (signal === "awaiting-input") {
    const isPromptRaisedInsideTurn = isWaitingOnHookRaisedPrompt(source === "hook", observation.pendingPromptKind ?? null);
    return { ...tracking, isCompacting: false, hasPromptInFlight: tracking.hasPromptInFlight || isPromptRaisedInsideTurn, idleTitleState: null, returnState: null };
  }
  if (signal === "working" && source === "title" && !tracking.hasPromptInFlight) {
    return { ...tracking, idleTitleState: tracking.idleTitleState ?? returnStateOf(observation) };
  }
  if (signal !== "compaction-start" || tracking.isCompacting) return tracking;
  const returnState = tracking.hasPromptInFlight ? null : returnStateOf(observation) ?? tracking.idleTitleState;
  return { ...tracking, isCompacting: true, hasFinishedCompaction: false, returnState };
}

function finishCompaction(tracking: CompactionTracking, state: SessionState, heldReady: CompactionHeldReady | null = null) {
  const shouldResetDetectionSources = !tracking.hasFinishedCompaction || tracking.isCompacting || tracking.idleTitleState !== null;
  const liveFallback = shouldResetDetectionSources ? returnStateOf({ signal: "compaction-end", state, heldReady }) : null;
  const candidate = tracking.hasPromptInFlight ? null : tracking.returnState ?? tracking.idleTitleState ?? liveFallback;
  const settledReturnState = candidate?.kind === "settled" ? candidate : null;
  const returnHeldReady = state === STATES.RUNNING && candidate?.kind === "held-ready" ? candidate.heldReady : null;
  const event = state === STATES.RUNNING && settledReturnState ? COMPACTION_RESTORE_EVENTS[settledReturnState.state] : null;
  return {
    tracking: { ...tracking, isCompacting: false, hasFinishedCompaction: true, idleTitleState: null, returnState: null },
    event,
    returnState: settledReturnState,
    returnHeldReady,
    shouldResetDetectionSources,
  };
}

function isIdleTitleActivity(tracking: CompactionTracking): boolean {
  return !tracking.hasPromptInFlight && tracking.idleTitleState?.kind === "settled";
}

function isCompactionEndingSignal(tracking: CompactionTracking, signal: string, source: string | null | undefined, hooksReportPrompts: boolean): boolean {
  if (signal !== "ready" || source === "hook") return false;
  if (tracking.isCompacting) return true;
  return hooksReportPrompts && isIdleTitleActivity(tracking);
}

function suppressCompactionSignal(tracking: CompactionTracking, signal: string): boolean {
  return tracking.isCompacting && signal === "working" && tracking.returnState !== null;
}

function mapCompactionActivityEvent(tracking: CompactionTracking, signal: string, event: string | null): string | null {
  if (signal !== "working" || event !== "user_input" || tracking.hasPromptInFlight || tracking.idleTitleState?.kind !== "settled") return event;
  return "new_output";
}

function isIdleCompactionActivity(tracking: CompactionTracking, signal: string, source: string | null | undefined): boolean {
  return signal === "working" && source === "title" && isIdleTitleActivity(tracking);
}

export { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent, isIdleCompactionActivity };
export type { CompactionTracking };
