import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";
import { COMPACTION_RESTORE_EVENTS } from "../../shared/compaction-restore-events.ts";
import type { UnseenOutcome } from "../../shared/contracts/session.ts";


interface GuardSession {
  state?: SessionState;
  ptyProcess?: unknown;
  worktreeDir?: unknown;
}

interface HookSession {
  id?: string;
  name?: string;
  path?: string;
  worktreeDir?: unknown;
  emit(event: string, payload: unknown): unknown;
}

type TransitionTable = Readonly<Record<SessionState, Readonly<Record<string, SessionState>>>>;
type GuardTable = Record<string, (session: GuardSession, detail?: unknown) => boolean>;
type StateHookTable = Partial<Record<SessionState, (session: HookSession) => void>>;

const TRANSITIONS: TransitionTable = Object.freeze({
  [STATES.DORMANT]: {
    user_start: STATES.INITIALIZING,
  },
  [STATES.INITIALIZING]: {
    spawn_success: STATES.STARTING,
    spawn_fail: STATES.FAILED,
    provision_blocked: STATES.DORMANT,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
  },
  [STATES.STARTING]: {
    first_output: STATES.IDLE,
    process_exit: STATES.FAILED,
    process_exit_ok: STATES.DONE,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
  },
  [STATES.RUNNING]: {
    [COMPACTION_RESTORE_EVENTS[STATES.IDLE]]: STATES.IDLE,
    [COMPACTION_RESTORE_EVENTS[STATES.COMPLETE]]: STATES.COMPLETE,
    [COMPACTION_RESTORE_EVENTS[STATES.WAITING]]: STATES.WAITING,
    prompt_detected: STATES.WAITING,
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
  },
  [STATES.WAITING]: {
    new_output: STATES.RUNNING,
    user_input: STATES.RUNNING,
    user_dismiss: STATES.RUNNING,
    check_terminal_dismiss: STATES.IDLE,
    task_complete: STATES.COMPLETE,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
  },
  [STATES.IDLE]: {
    new_output: STATES.RUNNING,
    prompt_detected: STATES.WAITING,
    task_complete: STATES.COMPLETE,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
  },
  [STATES.COMPLETE]: {
    new_output: STATES.RUNNING,
    user_dismiss: STATES.IDLE,
    prompt_detected: STATES.WAITING,
    process_exit_ok: STATES.DONE,
    process_exit_fail: STATES.FAILED,
    user_kill: STATES.DONE,
    user_snooze: STATES.DORMANT,
  },
  [STATES.DONE]: {
    user_restart: STATES.INITIALIZING,
    user_reset: STATES.DORMANT,
    user_snooze: STATES.DORMANT,
  },
  [STATES.FAILED]: {
    user_restart: STATES.INITIALIZING,
    user_reset: STATES.DORMANT,
    process_exit_ok: STATES.FAILED,
    process_exit_fail: STATES.FAILED,
  },
});

const GUARDS: GuardTable = {
  spawn_success(_session, detail) {
    return (detail as { spawnCwdExists?: unknown } | null | undefined)?.spawnCwdExists === true;
  },
  user_restart(session) {
    return session.state === STATES.DONE || session.state === STATES.FAILED;
  },
  user_reset(session) {
    return (
      (session.state === STATES.DONE || session.state === STATES.FAILED) &&
      session.ptyProcess == null &&
      session.worktreeDir == null
    );
  },
};

const ENTRY_HOOKS: StateHookTable = {
  [STATES.COMPLETE](session) {
    session.emit("post-turn-check", {
      id: session.id,
      name: session.name,
      path: session.worktreeDir || session.path,
    });
  },
  [STATES.WAITING](session) {
    session.emit("needs-attention", { name: session.name });
  },
  [STATES.FAILED](session) {
    session.emit("session-failed", { name: session.name });
  },
  [STATES.DONE](session) {
    session.emit("session-done", { name: session.name });
  },
};

const UNSEEN_OUTCOME_ON_ENTRY: ReadonlyMap<SessionState, UnseenOutcome | null> = new Map<SessionState, UnseenOutcome | null>([
  [STATES.COMPLETE, "finished"],
  [STATES.FAILED, "failed"],
  [STATES.INITIALIZING, null],
  [STATES.DORMANT, null],
  [STATES.DONE, null],
]);

const EXIT_HOOKS: StateHookTable = {
  [STATES.WAITING](session) {
    session.emit("attention-cleared", { name: session.name });
  },
};

type StateClock = { stateSince: number; firstTurnSince: number | null };

function nextStateClock(from: SessionState, to: SessionState, enteredAt: number, previousStateSince: number, firstTurnSince: number | null): StateClock {
  if (to === STATES.INITIALIZING) return { stateSince: enteredAt, firstTurnSince: enteredAt };
  if (from === STATES.INITIALIZING && to === STATES.STARTING) return { stateSince: previousStateSince, firstTurnSince };
  if (to === STATES.STARTING || to === STATES.IDLE) return { stateSince: enteredAt, firstTurnSince };
  if (to === STATES.RUNNING) return { stateSince: firstTurnSince ?? enteredAt, firstTurnSince: null };
  return { stateSince: enteredAt, firstTurnSince: null };
}

export { TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS, UNSEEN_OUTCOME_ON_ENTRY, nextStateClock };
