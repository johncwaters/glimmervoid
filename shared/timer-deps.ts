type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (fn: () => void, ms: number) => TimerHandle;
type ClearTimeoutFn = (handle: TimerHandle) => void;
type SetIntervalFn = (fn: () => void, ms: number) => TimerHandle;
type ClearIntervalFn = (handle: TimerHandle) => void;

interface TimerFns {
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  setIntervalFn: SetIntervalFn;
  clearIntervalFn: ClearIntervalFn;
}

const DEFAULT_TIMER_FNS: Readonly<TimerFns> = Object.freeze({
  setTimeoutFn: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn: (handle: TimerHandle) => clearTimeout(handle),
  setIntervalFn: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn: (handle: TimerHandle) => clearInterval(handle),
});

function unrefTimer<Handle>(handle: Handle): Handle {
  if (typeof handle !== 'object' || handle === null) return handle;
  if (!('unref' in handle) || typeof handle.unref !== 'function') return handle;
  handle.unref();
  return handle;
}

export { DEFAULT_TIMER_FNS, unrefTimer };
export type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn, TimerFns, TimerHandle };
