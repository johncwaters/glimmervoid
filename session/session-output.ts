import { createOutputRing } from "./core/output-ring.ts";
import type { OutputRingSlice, OutputRingStats } from "./core/output-ring.ts";
import { PASTE_SETTLE_MS, QUEUED_DELIVERY_TIMEOUT_MS, SUBMIT_DELAY_MS, canLandNow, canSubmit, framePaste } from "./core/input-delivery-core.ts";
import type { DeliverOptions, DeliveryOutcome, DeliverySettlement, DeliveryWhen } from "./core/input-delivery-core.ts";
import { SCREEN_KEEPER_SEED_LIMIT, SCREEN_RESET } from "./core/screen-keeper-core.ts";
import { createScreenKeeper } from "./screen-keeper.ts";
import type { ScreenKeeperFactory } from "./screen-keeper.ts";
import { STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { clock } from "../shared/clock.ts";

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
  lastOperatorInputAt: () => number;
  write: (text: string) => void;
  start: () => void;
  restart: () => void;
  on: SessionEventBinder;
  off: SessionEventBinder;
  screenKeeperFactory?: ScreenKeeperFactory | null;
  onPasteExpired?: (text: string) => void;
}

type SettleListener = (settlement: DeliverySettlement) => void;

interface QueuedDelivery {
  text: string;
  submit: boolean;
  onSettled: SettleListener | undefined;
  expiryTimer: NodeJS.Timeout;
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
  deliver(text: string, options: DeliverOptions): DeliveryOutcome;
  clearPendingPaste(): void;
  hasPendingPaste(): boolean;
  forgetUnsubmittedComposerPaste(): void;
  rememberSize(cols: number, rows: number): boolean;
  ptySize(): { cols: number; rows: number };
  disposeScreenKeeper(): void;
}

function settleLater(onSettled: SettleListener | undefined, settlement: DeliverySettlement): void {
  if (!onSettled) return;
  queueMicrotask(() => onSettled(settlement));
}

function createSessionOutput(options: SessionOutputOptions): SessionOutput {
  const ring = createOutputRing(options.maxBytes);
  const keeperFactory = options.screenKeeperFactory || createScreenKeeper;
  let keeper: ReturnType<ScreenKeeperFactory> | null = null;
  let keeperBaseOffset = 0;
  const queuedDeliveries: QueuedDelivery[] = [];
  let isWatchingForReady = false;
  let isDrainingQueue = false;
  let drainTimer: NodeJS.Timeout | null = null;
  let pendingSubmitListener: SettleListener | undefined;
  let hasUnsubmittedPasteInComposer = false;
  let lastCols: number | null = null;
  let lastRows: number | null = null;

  function stopWatchingForReady(): void {
    if (!isWatchingForReady) return;
    isWatchingForReady = false;
    options.off("state-change", onStateChangeWhilePasteQueued);
  }

  function clearPendingPaste(): void {
    const droppedListeners = queuedDeliveries.map((queued) => queued.onSettled);
    for (const queued of queuedDeliveries) clearTimeout(queued.expiryTimer);
    queuedDeliveries.length = 0;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    isDrainingQueue = false;
    droppedListeners.push(pendingSubmitListener);
    pendingSubmitListener = undefined;
    stopWatchingForReady();
    for (const onSettled of droppedListeners) settleLater(onSettled, "dropped");
  }

  function forgetUnsubmittedComposerPaste(): void {
    hasUnsubmittedPasteInComposer = false;
  }

  function hasPastesAhead(): boolean {
    return queuedDeliveries.length > 0 || isDrainingQueue;
  }

  function pasteIntoComposer(text: string, when: DeliveryWhen, wantsSubmit: boolean): boolean {
    options.write(framePaste(text));
    if (when !== "ready") return wantsSubmit;
    const willSubmit = wantsSubmit && !hasUnsubmittedPasteInComposer;
    if (!willSubmit) hasUnsubmittedPasteInComposer = true;
    return willSubmit;
  }

  function submitIfStillAllowed(when: DeliveryWhen, pastedAt: number): DeliverySettlement {
    if (options.isDestroyed() || !options.hasLivePty()) return "dropped";
    if (!canSubmit({ when, state: options.getState(), pastedAt, lastOperatorInputAt: options.lastOperatorInputAt() })) {
      if (when === "ready") hasUnsubmittedPasteInComposer = true;
      return "withheld";
    }
    options.write("\r");
    return "submitted";
  }

  function submitAfterDelayThenContinue(when: DeliveryWhen, pastedAt: number, onSettled: SettleListener | undefined): void {
    isDrainingQueue = true;
    pendingSubmitListener = onSettled;
    drainTimer = setTimeout(() => {
      pendingSubmitListener = undefined;
      settleLater(onSettled, submitIfStillAllowed(when, pastedAt));
      pasteNextQueued();
    }, SUBMIT_DELAY_MS);
    drainTimer.unref();
  }

  function landPaste(text: string, when: DeliveryWhen, wantsSubmit: boolean, onSettled: SettleListener | undefined): boolean {
    const pastedAt = clock.nowMs();
    if (pasteIntoComposer(text, when, wantsSubmit)) {
      submitAfterDelayThenContinue(when, pastedAt, onSettled);
      return true;
    }
    settleLater(onSettled, "pasted");
    return false;
  }

  function pasteNextQueued(): void {
    drainTimer = null;
    const next = queuedDeliveries.shift();
    if (!next) {
      clearPendingPaste();
      return;
    }
    clearTimeout(next.expiryTimer);
    if (options.isDestroyed() || !options.hasLivePty()) {
      settleLater(next.onSettled, "dropped");
      clearPendingPaste();
      return;
    }
    if (landPaste(next.text, "ready", next.submit, next.onSettled)) return;
    pasteNextQueued();
  }

  function startDrainingQueue(): void {
    if (queuedDeliveries.length === 0) return;
    isDrainingQueue = true;
    drainTimer = setTimeout(pasteNextQueued, PASTE_SETTLE_MS);
    drainTimer.unref();
  }

  function onStateChangeWhilePasteQueued({ to }: StateChange): void {
    if (!canLandNow("ready", to)) return;
    stopWatchingForReady();
    startDrainingQueue();
  }

  function dropExpiredDelivery(expired: QueuedDelivery): void {
    const expiredIndex = queuedDeliveries.indexOf(expired);
    if (expiredIndex === -1) return;
    queuedDeliveries.splice(expiredIndex, 1);
    options.onPasteExpired?.(expired.text);
    settleLater(expired.onSettled, "expired");
    if (queuedDeliveries.length === 0 && !isDrainingQueue) stopWatchingForReady();
  }

  function enqueueAheadOfUnsubmittedPastes(queued: QueuedDelivery): void {
    const firstUnsubmittedIndex = queued.submit ? queuedDeliveries.findIndex((waiting) => !waiting.submit) : -1;
    if (firstUnsubmittedIndex === -1) {
      queuedDeliveries.push(queued);
      return;
    }
    queuedDeliveries.splice(firstUnsubmittedIndex, 0, queued);
  }

  function queueUntilReady(text: string, submit: boolean, timeoutMs: number, onSettled: SettleListener | undefined): DeliveryOutcome {
    const stateBeforeWaiting = options.getState();
    const queued: QueuedDelivery = {
      text,
      submit,
      onSettled,
      expiryTimer: setTimeout(() => dropExpiredDelivery(queued), timeoutMs),
    };
    queued.expiryTimer.unref();
    enqueueAheadOfUnsubmittedPastes(queued);
    if (!isDrainingQueue && !isWatchingForReady) {
      isWatchingForReady = true;
      options.on("state-change", onStateChangeWhilePasteQueued);
    }
    if (stateBeforeWaiting === STATES.DORMANT) options.start();
    if (RESTARTABLE_STATES.includes(stateBeforeWaiting)) options.restart();
    return { ok: true, kind: "queued" };
  }

  function deliver(text: string, { when, submit, timeoutMs = QUEUED_DELIVERY_TIMEOUT_MS, onSettled }: DeliverOptions): DeliveryOutcome {
    if (options.isDestroyed()) return { ok: false, kind: "refused", reason: "destroyed" };
    const isReadyToLand = !hasPastesAhead() && options.hasLivePty() && canLandNow(when, options.getState());
    if (when === "ready" && !isReadyToLand) return queueUntilReady(text, submit, timeoutMs, onSettled);
    if (!options.hasLivePty()) return { ok: false, kind: "refused", reason: "no-pty" };
    if (when === "idle" && !isReadyToLand) return { ok: false, kind: "refused", reason: "not-idle" };
    landPaste(text, when, submit && !hasPastesAhead(), onSettled);
    return { ok: true, kind: "pasted" };
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
  options.on("exit", clearPendingPaste);
  options.on("exit", forgetUnsubmittedComposerPaste);

  return {
    push,
    since: (offset) => ring.since(offset),
    snapshot,
    deepSnapshot,
    reset,
    setMax: (bytes) => ring.setMax(bytes),
    stats: () => ring.stats(),
    deliver,
    clearPendingPaste,
    hasPendingPaste: () => queuedDeliveries.length > 0,
    forgetUnsubmittedComposerPaste,
    rememberSize,
    ptySize,
    disposeScreenKeeper,
  };
}

export { createSessionOutput };
export type { ScreenSnapshot };
