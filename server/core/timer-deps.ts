type SetTimeoutFn = (fn: () => void, ms: number) => NodeJS.Timeout;
type ClearTimeoutFn = (handle: NodeJS.Timeout) => void;
type SetIntervalFn = (fn: () => void, ms: number) => NodeJS.Timeout;
type ClearIntervalFn = (handle: NodeJS.Timeout) => void;

interface TimerFns {
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  setIntervalFn: SetIntervalFn;
  clearIntervalFn: ClearIntervalFn;
}

const DEFAULT_TIMER_FNS: Readonly<TimerFns> = Object.freeze({
  setTimeoutFn: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeoutFn: (handle: NodeJS.Timeout) => clearTimeout(handle),
  setIntervalFn: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn: (handle: NodeJS.Timeout) => clearInterval(handle),
});

function unrefTimer<Handle extends { unref?: () => unknown } | null | undefined>(handle: Handle): Handle {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export { DEFAULT_TIMER_FNS, unrefTimer };
export type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn, TimerFns };
