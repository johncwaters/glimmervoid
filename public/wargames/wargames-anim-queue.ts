type BoardQueueState = 'idle' | 'playing' | 'disposed';
type BoardQueueEvent = 'enqueue' | 'step_complete' | 'queue_drained' | 'clear' | 'dispose';

export type BoardOverlayMode = 'idle' | 'recap' | 'preview';
type BoardOverlayEvent = 'start_recap' | 'recap_drained' | 'show_previews' | 'hide_previews' | 'reset';

type TransitionTable<State extends string, Event extends string> = Readonly<Record<State, Readonly<Partial<Record<Event, State>>>>>;

const BOARD_QUEUE_TRANSITIONS: TransitionTable<BoardQueueState, BoardQueueEvent> = Object.freeze({
  idle: { enqueue: 'playing', clear: 'idle', dispose: 'disposed' },
  playing: { step_complete: 'playing', queue_drained: 'idle', clear: 'idle', dispose: 'disposed' },
  disposed: {},
});

const BOARD_OVERLAY_TRANSITIONS: TransitionTable<BoardOverlayMode, BoardOverlayEvent> = Object.freeze({
  idle: { start_recap: 'recap', show_previews: 'preview', hide_previews: 'idle', reset: 'idle' },
  recap: { start_recap: 'recap', recap_drained: 'idle', reset: 'idle' },
  preview: { start_recap: 'recap', show_previews: 'preview', hide_previews: 'idle', reset: 'idle' },
});

export function transitionBoardQueue(state: BoardQueueState, event: BoardQueueEvent): BoardQueueState | null {
  return BOARD_QUEUE_TRANSITIONS[state][event] ?? null;
}

export function transitionBoardOverlay(state: BoardOverlayMode, event: BoardOverlayEvent): BoardOverlayMode | null {
  return BOARD_OVERLAY_TRANSITIONS[state][event] ?? null;
}

export interface BoardAnimationBeat {
  readonly id: string;
  readonly durationMs: number;
  readonly start: (scaledDurationMs: number) => (() => void) | undefined;
}

interface BoardAnimationQueueOptions<TimerHandle = ReturnType<typeof setTimeout>> {
  readonly maxBatchDurationMs?: number;
  readonly minBeatDurationMs?: number;
  readonly shouldSkip?: () => boolean;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimer?: (handle: TimerHandle) => void;
  readonly onDrain?: () => void;
}

interface BoardAnimationQueue {
  enqueueBatch(beats: readonly BoardAnimationBeat[]): void;
  clear(): void;
  dispose(): void;
  getState(): BoardQueueState;
}

const DEFAULT_MAX_BATCH_DURATION_MS = 40_000;
const DEFAULT_MIN_BEAT_DURATION_MS = 260;

export function createBoardAnimationQueue<TimerHandle = ReturnType<typeof setTimeout>>(
  options: BoardAnimationQueueOptions<TimerHandle> = {},
): BoardAnimationQueue {
  const maxBatchDurationMs = options.maxBatchDurationMs ?? DEFAULT_MAX_BATCH_DURATION_MS;
  const minBeatDurationMs = options.minBeatDurationMs ?? DEFAULT_MIN_BEAT_DURATION_MS;
  const shouldSkip = options.shouldSkip ?? (() => false);
  const scheduleTimer = options.scheduleTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as TimerHandle);
  const cancelTimer = options.cancelTimer
    ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onDrain = options.onDrain;

  let state: BoardQueueState = 'idle';
  let pending: { beat: BoardAnimationBeat; scaledDurationMs: number }[] = [];
  let activeTimer: TimerHandle | null = null;
  let activeCleanup: (() => void) | null = null;

  function applyTransition(event: BoardQueueEvent): boolean {
    const nextState = transitionBoardQueue(state, event);
    if (nextState === null) return false;
    state = nextState;
    return true;
  }

  function stopActiveBeat(): void {
    if (activeTimer !== null) {
      cancelTimer(activeTimer);
      activeTimer = null;
    }
    if (activeCleanup !== null) {
      const cleanup = activeCleanup;
      activeCleanup = null;
      cleanup();
    }
  }

  function runNextBeat(): void {
    if (state !== 'playing') return;
    const nextEntry = pending.shift();
    if (!nextEntry) {
      applyTransition('queue_drained');
      onDrain?.();
      return;
    }
    const cleanup = nextEntry.beat.start(nextEntry.scaledDurationMs);
    if (state !== 'playing') {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    activeCleanup = typeof cleanup === 'function' ? cleanup : null;
    activeTimer = scheduleTimer(() => {
      activeTimer = null;
      if (activeCleanup !== null) {
        const teardown = activeCleanup;
        activeCleanup = null;
        teardown();
      }
      if (state !== 'playing') return;
      if (pending.length === 0) {
        applyTransition('queue_drained');
        onDrain?.();
        return;
      }
      applyTransition('step_complete');
      runNextBeat();
    }, nextEntry.scaledDurationMs);
  }

  function clear(): void {
    if (state === 'disposed') return;
    stopActiveBeat();
    pending = [];
    applyTransition('clear');
  }

  function enqueueBatch(beats: readonly BoardAnimationBeat[]): void {
    if (state === 'disposed') return;
    stopActiveBeat();
    pending = [];
    applyTransition('clear');

    if (beats.length === 0 || shouldSkip()) {
      onDrain?.();
      return;
    }

    const totalRawDuration = beats.reduce((sum, beat) => sum + Math.max(1, beat.durationMs), 0);
    const scaleFactor = totalRawDuration > maxBatchDurationMs ? maxBatchDurationMs / totalRawDuration : 1;
    pending = beats.map((beat) => ({
      beat,
      scaledDurationMs: Math.max(minBeatDurationMs, Math.round(beat.durationMs * scaleFactor)),
    }));
    if (!applyTransition('enqueue')) return;
    runNextBeat();
  }

  function dispose(): void {
    if (state === 'disposed') return;
    stopActiveBeat();
    pending = [];
    applyTransition('dispose');
  }

  function getState(): BoardQueueState {
    return state;
  }

  return { enqueueBatch, clear, dispose, getState };
}
