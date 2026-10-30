import { createOutputRing } from "./core/output-ring.ts";
import type { OutputRingSlice, OutputRingStats } from "./core/output-ring.ts";
import { SCREEN_KEEPER_SEED_LIMIT, SCREEN_RESET } from "./core/screen-keeper-core.ts";
import { createScreenKeeper } from "./screen-keeper.ts";
import type { ScreenKeeperFactory } from "./screen-keeper.ts";
import { STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";

const PASTE_READY_STATES: Set<SessionState> = new Set([
  STATES.IDLE,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.COMPLETE,
]);

interface StateChange {
  to: SessionState;
}

interface SessionEventBinder {
  (event: "state-change", listener: (change: StateChange) => void): void;
  (event: "exit", listener: () => void): void;
}

interface SessionOutputOptions {
  maxBytes: number;
  getState: () => SessionState;
  isDestroyed: () => boolean;
  hasLivePty: () => boolean;
  write: (text: string) => void;
  start: () => void;
  restart: () => void;
  on: SessionEventBinder;
  once: SessionEventBinder;
  off: SessionEventBinder;
  screenKeeperFactory?: ScreenKeeperFactory | null;
}

type PasteResult = {
  ok: boolean;
  reason?: string;
  deferred?: boolean;
};

interface PasteWhenReadyOptions {
  timeoutMs?: number;
  settleMs?: number;
  submitDelayMs?: number | null;
}

interface ScreenSnapshot {
  data: string;
  offset: number;
}

interface SessionOutput {
  push(chunk: string): void;
  since(offset: number): OutputRingSlice;
  snapshot(): ScreenSnapshot;
  deepSnapshot(): Promise<ScreenSnapshot>;
  reset(): void;
  setMax(bytes: number): void;
  stats(): OutputRingStats;
  pasteText(text: string): PasteResult;
  pasteTextWhenReady(text: string, options?: PasteWhenReadyOptions): PasteResult;
  clearPendingPaste(): void;
  hasPendingPaste(): boolean;
  rememberSize(cols: number, rows: number): boolean;
  ptySize(): { cols: number; rows: number };
  disposeScreenKeeper(): void;
}

function createSessionOutput(options: SessionOutputOptions): SessionOutput {
  const ring = createOutputRing(options.maxBytes);
  const keeperFactory = options.screenKeeperFactory || createScreenKeeper;
  let keeper: ReturnType<ScreenKeeperFactory> | null = null;
  let keeperBaseOffset = 0;
  let pendingPaste: {
    timer: NodeJS.Timeout;
    onStateChange: (change: StateChange) => void;
    onExit: () => void;
  } | null = null;
  let lastCols: number | null = null;
  let lastRows: number | null = null;

  function clearPendingPaste(): void {
    if (!pendingPaste) return;
    const pending = pendingPaste;
    pendingPaste = null;
    clearTimeout(pending.timer);
    options.off("state-change", pending.onStateChange);
    options.off("exit", pending.onExit);
  }

  function pasteText(text: string): PasteResult {
    if (!options.hasLivePty()) return { ok: false, reason: "no-pty" };
    options.write(`\x1b[200~${text}\x1b[201~`);
    return { ok: true };
  }

  function pasteAndSubmit(text: string, submitDelayMs: number | null): PasteResult {
    const pasted = pasteText(text);
    if (!pasted.ok || submitDelayMs === null) return pasted;
    setTimeout(() => {
      if (options.hasLivePty()) options.write("\r");
    }, submitDelayMs).unref();
    return pasted;
  }

  function deliverPaste(text: string, settleMs: number, submitDelayMs: number | null): PasteResult {
    if (settleMs <= 0) return pasteAndSubmit(text, submitDelayMs);
    setTimeout(() => {
      if (!options.isDestroyed()) pasteAndSubmit(text, submitDelayMs);
    }, settleMs).unref();
    return { ok: true, deferred: true };
  }

  function pasteTextWhenReady(text: string, { timeoutMs = 120000, settleMs = 0, submitDelayMs = null }: PasteWhenReadyOptions = {}): PasteResult {
    if (options.isDestroyed()) return { ok: false, reason: "destroyed" };
    const stateBeforeWaiting = options.getState();
    if (options.hasLivePty() && PASTE_READY_STATES.has(stateBeforeWaiting)) return deliverPaste(text, settleMs, submitDelayMs);
    clearPendingPaste();
    const onStateChange = ({ to }: StateChange): void => {
      if (!PASTE_READY_STATES.has(to)) return;
      clearPendingPaste();
      deliverPaste(text, settleMs, submitDelayMs);
    };
    const onExit = (): void => clearPendingPaste();
    const timer = setTimeout(() => clearPendingPaste(), timeoutMs);
    timer.unref();
    pendingPaste = { timer, onStateChange, onExit };
    options.on("state-change", onStateChange);
    options.once("exit", onExit);
    if (stateBeforeWaiting === STATES.DORMANT) options.start();
    if (RESTARTABLE_STATES.includes(stateBeforeWaiting)) options.restart();
    return { ok: true, deferred: true };
  }

  function ptySize(): { cols: number; rows: number } {
    return { cols: lastCols ?? 80, rows: lastRows ?? 24 };
  }

  function disposeScreenKeeper(): void {
    if (!keeper) return;
    keeper.dispose();
    keeper = null;
  }

  function rememberSize(cols: number, rows: number): boolean {
    const changed = lastCols !== cols || lastRows !== rows;
    lastCols = cols;
    lastRows = rows;
    if (changed && keeper) keeper.resize(cols, rows);
    return changed;
  }

  function push(chunk: string): void {
    ring.push(chunk);
    if (keeper?.push(chunk)) return;
    if (keeper && !keeper.isDrained()) return;
    disposeScreenKeeper();
    const { total, bytes } = ring.stats();
    keeperBaseOffset = Math.max(total - bytes, total - SCREEN_KEEPER_SEED_LIMIT);
    keeper = keeperFactory(ptySize());
    keeper.push(ring.since(keeperBaseOffset).data);
  }

  function reset(): void {
    disposeScreenKeeper();
    ring.reset();
  }

  function ringSnapshot(): ScreenSnapshot {
    return { data: SCREEN_RESET + ring.replay(), offset: ring.stats().total };
  }

  function snapshot(): ScreenSnapshot {
    if (!keeper || keeper.isOverrun()) return ringSnapshot();
    const tail = ring.since(keeperBaseOffset + keeper.parsedOffset());
    if (tail.evicted) return ringSnapshot();
    return { data: SCREEN_RESET + keeper.serialize() + tail.data, offset: ring.stats().total };
  }

  async function deepSnapshot(): Promise<ScreenSnapshot> {
    const deepKeeper = keeper;
    if (!deepKeeper || deepKeeper.isOverrun()) return ringSnapshot();
    const deepScreen = await deepKeeper.serializeDeep();
    if (!deepScreen || keeper !== deepKeeper) return ringSnapshot();
    const tail = ring.since(keeperBaseOffset + deepScreen.parsedOffset);
    if (tail.evicted) return ringSnapshot();
    return { data: SCREEN_RESET + deepScreen.data + tail.data, offset: ring.stats().total };
  }

  options.on("exit", disposeScreenKeeper);

  return {
    push,
    since: (offset) => ring.since(offset),
    snapshot,
    deepSnapshot,
    reset,
    setMax: (bytes) => ring.setMax(bytes),
    stats: () => ring.stats(),
    pasteText,
    pasteTextWhenReady,
    clearPendingPaste,
    hasPendingPaste: () => pendingPaste !== null,
    rememberSize,
    ptySize,
    disposeScreenKeeper,
  };
}

export { createSessionOutput };
export type { ScreenSnapshot };
