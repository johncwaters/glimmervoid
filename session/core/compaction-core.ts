import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";
import type { PendingPromptDetail } from "../../shared/contracts/session.ts";
import { COMPACTION_RESTORE_EVENTS } from "../../shared/compaction-restore-events.ts";

type SettledState = typeof STATES.IDLE | typeof STATES.COMPLETE | typeof STATES.WAITING;

interface CompactionReturnState {
  state: SettledState;
  pendingPromptKind: string | null;
  pendingPromptDetail: PendingPromptDetail | null;
}

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
  pendingPromptDetail?: PendingPromptDetail | null;
}

function createCompactionTracking(): CompactionTracking {
  return { isCompacting: false, hasPromptInFlight: false, hasFinishedCompaction: false, idleTitleState: null, returnState: null };
}

function settledStateOf(observation: CompactionObservation): CompactionReturnState | null {
  const { state } = observation;
  if (state !== STATES.IDLE && state !== STATES.COMPLETE && state !== STATES.WAITING) return null;
  return { state, pendingPromptKind: observation.pendingPromptKind ?? null, pendingPromptDetail: observation.pendingPromptDetail ?? null };
}

function observeCompaction(tracking: CompactionTracking, observation: CompactionObservation): CompactionTracking {
  const { signal, source } = observation;
  if (signal === "resume") return { ...tracking, isCompacting: false, hasPromptInFlight: true, idleTitleState: null, returnState: null };
  if (signal === "stop") return { ...tracking, isCompacting: false, hasPromptInFlight: false };
  if (signal === "settled") return { ...tracking, hasPromptInFlight: observation.state === STATES.COMPLETE ? false : tracking.hasPromptInFlight, idleTitleState: null, returnState: null };
  if (signal === "awaiting-input") return { ...tracking, isCompacting: false, idleTitleState: null, returnState: null };
  if (signal === "working" && source === "title" && !tracking.hasPromptInFlight) {
    return { ...tracking, idleTitleState: tracking.idleTitleState ?? settledStateOf(observation) };
  }
  if (signal !== "compaction-start" || tracking.isCompacting) return tracking;
  const returnState = tracking.hasPromptInFlight ? null : settledStateOf(observation) ?? tracking.idleTitleState;
  return { ...tracking, isCompacting: true, hasFinishedCompaction: false, returnState };
}

function finishCompaction(tracking: CompactionTracking, state: SessionState) {
  const returnState = tracking.hasPromptInFlight ? null : tracking.returnState ?? tracking.idleTitleState;
  const event = state === STATES.RUNNING && returnState ? COMPACTION_RESTORE_EVENTS[returnState.state] : null;
  const shouldResetDetectionSources = !tracking.hasFinishedCompaction || tracking.isCompacting || tracking.idleTitleState !== null;
  return { tracking: { ...tracking, isCompacting: false, hasFinishedCompaction: true, idleTitleState: null, returnState: null }, event, returnState, shouldResetDetectionSources };
}

function isCompactionEndingSignal(tracking: CompactionTracking, signal: string, source?: string | null): boolean {
  return tracking.isCompacting && signal === "ready" && source !== "hook";
}

function suppressCompactionSignal(tracking: CompactionTracking, signal: string): boolean {
  return tracking.isCompacting && signal === "working" && tracking.returnState !== null;
}

function mapCompactionActivityEvent(tracking: CompactionTracking, signal: string, event: string | null): string | null {
  if (signal !== "working" || event !== "user_input" || tracking.hasPromptInFlight || !tracking.idleTitleState) return event;
  return "new_output";
}

function isIdleCompactionActivity(tracking: CompactionTracking, signal: string, source: string | null | undefined): boolean {
  return signal === "working" && source === "title" && !tracking.hasPromptInFlight && tracking.idleTitleState !== null;
}

export { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent, isIdleCompactionActivity };
export type { CompactionTracking };
