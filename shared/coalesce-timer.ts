import { DEFAULT_TIMER_FNS, unrefTimer } from './timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from './timer-deps.ts';

type CoalesceMode = 'leading' | 'trailing';

interface CoalescedTimer {
  schedule(): void;
  cancel(): void;
  readonly isArmed: boolean;
}

function createCoalescedTimer({
  mode,
  delayMs,
  run,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  unref = true,
}: {
  mode: CoalesceMode;
  delayMs: number;
  run: () => void;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  unref?: boolean;
}): CoalescedTimer {
  let timer: TimerHandle | null = null;

  function cancel(): void {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function schedule(): void {
    if (mode === 'leading' && timer) return;
    cancel();
    timer = setTimeoutFn(() => {
      timer = null;
      run();
    }, delayMs);
    if (unref) unrefTimer(timer);
  }

  return {
    schedule,
    cancel,
    get isArmed() { return timer !== null; },
  };
}

export { createCoalescedTimer };
export type { CoalesceMode, CoalescedTimer };
