import type { Page } from 'playwright-core';
import type { Layout } from './cases-core.ts';
import {
  OPTIMISTIC_DOM_BUDGET_MS,
  PUSH_DELAY_MS,
  RECONNECT_DOWN_MS,
  REPLY_DELAY_MS,
  ROLLBACK_DOM_BUDGET_MS,
} from './continuity-budgets.ts';
import {
  ACTION_CONTINUITY_CASES,
  COLLECTION_CONTINUITY_CASES,
} from './continuity-cases.ts';
import type {
  ActionContinuityCase,
  CollectionContinuityCase,
  ContinuityCaseContext,
} from './continuity-cases.ts';
import { CLIENT_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';

export type StubReplyResponder = (
  frame: Record<string, unknown>,
  nextSeq: number,
) => { reply: Record<string, unknown>; push?: Record<string, unknown> };

export interface ControlFaultController {
  setReplyDelayMs(delayMs: number): void;
  setPushDelayMs(delayMs: number): void;
  failRequestType(requestType: string, errorMessage?: string): void;
  clearFailedRequestTypes(): void;
  stubRequestReply(requestType: string, responder: StubReplyResponder): void;
  clearStubbedReplies(): void;
  syncSeqFloor(seq: number): void;
  dropControlSocketFor(durationMs: number): Promise<void>;
  startCountingClientFrames(): void;
  stopCountingClientFrames(): string[];
  reset(): void;
}

export interface ContinuityRunOptions {
  page: Page;
  layout: Layout;
  sessionId: string;
  projectDirectory: string;
  faults: ControlFaultController;
}

export interface ActionBudgetMeasurement {
  name: string;
  c1Passed: boolean;
  c1Ms: number;
  c2Passed: boolean;
  c2Ms: number;
  c5Passed: boolean;
  c5SampledFrames: number;
  detail: string;
}

export interface CollectionBudgetMeasurement {
  name: string;
  c3Passed: boolean;
  c3RemovedNodes: number;
  c4Passed: boolean;
  c4ControlRequests: string[];
  detail: string;
}

export interface ContinuityRunResult {
  ok: boolean;
  detail: string;
  actions: ActionBudgetMeasurement[];
  collections: CollectionBudgetMeasurement[];
}

const ACTION_SETTLE_TIMEOUT_MS = 8000;
const RECONNECT_SETTLE_DELAY_MS = 200;
const VIEW_RETURN_SETTLE_DELAY_MS = 150;
const ACTION_STATUS_MODULE_URL = '/action-status.ts';
const SEQ_MODULE_URL = '/state/seq.ts';

async function syncBrowserSeqFloor(page: Page, faults: ControlFaultController): Promise<void> {
  const browserSeq = await page.evaluate(async (seqUrl) => {
    const seqMod = await import(seqUrl) as { currentSeq: () => number };
    return seqMod.currentSeq();
  }, SEQ_MODULE_URL);
  faults.syncSeqFloor(browserSeq);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function isControlRequestFrame(frameType: string): boolean {
  if (!Object.hasOwn(CLIENT_MESSAGE_CLASS, frameType)) return true;
  return CLIENT_MESSAGE_CLASS[frameType as keyof typeof CLIENT_MESSAGE_CLASS] !== 'signal';
}

function selectedCaseFilter(): Set<string> | null {
  const raw = process.env.GLIMMERVOID_CONTINUITY_ONLY?.trim();
  if (!raw) return null;
  const names = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

async function clearAllHeaderNotices(page: Page): Promise<void> {
  await page.evaluate(async (actionStatusUrl) => {
    const actionStatus = await import(actionStatusUrl) as {
      clearAllHeaderErrors?: () => void;
    };
    actionStatus.clearAllHeaderErrors?.();
  }, ACTION_STATUS_MODULE_URL);
}

async function countVisibleNotices(page: Page): Promise<number> {
  return page.evaluate(() => {
    const notice = document.getElementById('header-error-notice');
    if (!notice || notice.hidden) return 0;
    const text = notice.textContent?.trim() ?? '';
    if (text.length === 0) return 0;
    return 1;
  });
}

async function waitForDomPredicate(
  page: Page,
  predicate: () => Promise<boolean>,
  budgetMs: number,
): Promise<{ matched: boolean; elapsedMs: number }> {
  const startedAt = performance.now();
  while (true) {
    const matched = await predicate();
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (matched) return { matched: true, elapsedMs };
    if (elapsedMs >= budgetMs) return { matched: false, elapsedMs };
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
  }
}

async function runActionContinuityCase(
  actionCase: ActionContinuityCase,
  ctx: ContinuityCaseContext,
): Promise<ActionBudgetMeasurement> {
  const { page, faults } = ctx;
  const failures: string[] = [];

  if (actionCase.stub === true) {
    return {
      name: actionCase.name,
      c1Passed: false,
      c1Ms: -1,
      c2Passed: false,
      c2Ms: -1,
      c5Passed: false,
      c5SampledFrames: 0,
      detail: `stub continuity case "${actionCase.name}" is not implemented yet`,
    };
  }

  let c1Ms = -1;
  let c1Passed = false;
  let c2Ms = -1;
  let c2Passed = false;
  let c5Passed = false;
  let c5SampledFrames = 0;

  faults.reset();
  await clearAllHeaderNotices(page);
  const c1Handle = await actionCase.prepare(ctx, 'C1');
  try {
    await syncBrowserSeqFloor(page, faults);
    faults.setReplyDelayMs(REPLY_DELAY_MS);
    const c1Start = performance.now();
    await c1Handle.fire();
    const fireMs = Math.round(performance.now() - c1Start);
    const c1Wait = await waitForDomPredicate(page, () => c1Handle.isOptimisticShown(), OPTIMISTIC_DOM_BUDGET_MS);
    c1Ms = Math.round(performance.now() - c1Start);
    c1Passed = c1Wait.matched && c1Ms <= OPTIMISTIC_DOM_BUDGET_MS;
    if (!c1Passed) {
      failures.push(`C1 optimistic state not shown within ${OPTIMISTIC_DOM_BUDGET_MS}ms (elapsed ${c1Ms}ms, fire=${fireMs}ms, replyDelay ${REPLY_DELAY_MS}ms)`);
    }
    await Promise.race([c1Handle.waitSettled(), sleep(ACTION_SETTLE_TIMEOUT_MS)]);
  } finally {
    faults.reset();
    await clearAllHeaderNotices(page);
    await c1Handle.cleanup();
  }

  faults.reset();
  await clearAllHeaderNotices(page);
  const c2Handle = await actionCase.prepare(ctx, 'C2');
  try {
    const beforeValue = await c2Handle.readValue();
    faults.failRequestType(actionCase.name, `Continuity C2 injected failure for ${actionCase.name}`);
    await c2Handle.fire();
    await Promise.race([c2Handle.waitSettled(), sleep(ACTION_SETTLE_TIMEOUT_MS)]);
    const c2Start = performance.now();
    const c2Wait = await waitForDomPredicate(
      page,
      async () => {
        const currentValue = await c2Handle.readValue();
        const noticeCount = await countVisibleNotices(page);
        return currentValue === beforeValue && noticeCount === 1;
      },
      ROLLBACK_DOM_BUDGET_MS,
    );
    c2Ms = Math.round(performance.now() - c2Start);
    const afterValue = await c2Handle.readValue();
    const finalNoticeCount = await countVisibleNotices(page);
    c2Passed = c2Wait.matched && c2Ms <= ROLLBACK_DOM_BUDGET_MS && afterValue === beforeValue && finalNoticeCount === 1;
    if (!c2Passed) {
      failures.push(`C2 rollback failed (elapsed ${c2Ms}ms, before=${JSON.stringify(beforeValue)}, after=${JSON.stringify(afterValue)}, notices=${finalNoticeCount})`);
    }
  } finally {
    faults.reset();
    await clearAllHeaderNotices(page);
    await c2Handle.cleanup();
  }

  faults.reset();
  await clearAllHeaderNotices(page);
  const c5Handle = await actionCase.prepare(ctx, 'C5');
  try {
    await syncBrowserSeqFloor(page, faults);
    const beforeValue = await c5Handle.readValue();
    faults.setReplyDelayMs(0);
    faults.setPushDelayMs(PUSH_DELAY_MS);
    await c5Handle.fire();
    const optimisticShown = await waitForDomPredicate(page, () => c5Handle.isOptimisticShown(), OPTIMISTIC_DOM_BUDGET_MS);
    let revertedDuringHold = false;
    const holdDeadline = performance.now() + PUSH_DELAY_MS - 30;
    while (performance.now() < holdDeadline) {
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }));
      c5SampledFrames += 1;
      const sampledValue = await c5Handle.readValue();
      if (sampledValue === beforeValue) {
        revertedDuringHold = true;
      }
    }
    await Promise.race([c5Handle.waitSettled(), sleep(ACTION_SETTLE_TIMEOUT_MS)]);
    c5Passed = optimisticShown.matched && !revertedDuringHold && c5SampledFrames > 0;
    if (!c5Passed) {
      failures.push(`C5 early drop check failed (optimisticShown=${String(optimisticShown.matched)}, revertedDuringHold=${String(revertedDuringHold)}, frames=${c5SampledFrames})`);
    }
  } finally {
    faults.reset();
    await clearAllHeaderNotices(page);
    await c5Handle.cleanup();
  }

  return {
    name: actionCase.name,
    c1Passed,
    c1Ms,
    c2Passed,
    c2Ms,
    c5Passed,
    c5SampledFrames,
    detail: failures.length === 0
      ? `C1=${c1Ms}ms C2=${c2Ms}ms C5=ok(${c5SampledFrames}f)`
      : failures.join('; '),
  };
}

async function runCollectionContinuityCase(
  collectionCase: CollectionContinuityCase,
  ctx: ContinuityCaseContext,
): Promise<CollectionBudgetMeasurement> {
  const { page, faults } = ctx;
  const failures: string[] = [];

  if (collectionCase.stub === true) {
    return {
      name: collectionCase.name,
      c3Passed: false,
      c3RemovedNodes: -1,
      c4Passed: false,
      c4ControlRequests: [],
      detail: `stub continuity case "${collectionCase.name}" is not implemented yet`,
    };
  }

  let c3Passed = false;
  let c3RemovedNodes = 0;
  let c4Passed = false;
  let c4ControlRequests: string[] = [];

  faults.reset();
  const c3Handle = await collectionCase.prepare(ctx, 'C3');
  try {
    await page.evaluate(({ listSelector, focusSelector, scrollSelector }) => {
      const focusTarget = focusSelector ? document.querySelector<HTMLElement>(focusSelector) : null;
      focusTarget?.focus();
      const scrollContainers = [...document.querySelectorAll<HTMLElement>(scrollSelector)];
      const initialScrollTops = scrollContainers.map((container) => container.scrollTop);
      let removedNodeCount = 0;
      const observers: MutationObserver[] = [];
      for (const listEl of document.querySelectorAll<HTMLElement>(listSelector)) {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const removedNode of record.removedNodes) {
              if (removedNode.nodeType === Node.ELEMENT_NODE) removedNodeCount += 1;
            }
          }
        });
        observer.observe(listEl, { childList: true });
        observers.push(observer);
      }
      Reflect.set(window, '__continuityC3', {
        focusTarget,
        scrollContainers,
        initialScrollTops,
        observers,
        readRemovedCount: () => removedNodeCount,
      });
    }, {
      listSelector: c3Handle.listSelector,
      focusSelector: c3Handle.focusSelector,
      scrollSelector: c3Handle.scrollSelector,
    });

    await faults.dropControlSocketFor(RECONNECT_DOWN_MS);
    await sleep(RECONNECT_SETTLE_DELAY_MS);

    const c3Check = await page.evaluate(() => {
      const state = Reflect.get(window, '__continuityC3') as {
        focusTarget: HTMLElement | null;
        scrollContainers: HTMLElement[];
        initialScrollTops: number[];
        observers: MutationObserver[];
        readRemovedCount: () => number;
      };
      for (const observer of state.observers) observer.disconnect();
      const removedCount = state.readRemovedCount();
      const activeElementUnchanged = state.focusTarget === null || document.activeElement === state.focusTarget;
      const activeDesc = document.activeElement ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id}.${document.activeElement.className}` : 'null';
      const targetConnected = state.focusTarget?.isConnected ?? true;
      const scrollUnchanged = state.scrollContainers.every(
        (container, index) => container.scrollTop === state.initialScrollTops[index],
      );
      Reflect.deleteProperty(window, '__continuityC3');
      return { removedCount, activeElementUnchanged, scrollUnchanged, activeDesc, targetConnected };
    });

    c3RemovedNodes = c3Check.removedCount;
    c3Passed = c3Check.removedCount === 0 && c3Check.activeElementUnchanged && c3Check.scrollUnchanged;
    if (!c3Passed) {
      failures.push(`C3 reconnect failed (removed=${c3Check.removedCount}, activeUnchanged=${String(c3Check.activeElementUnchanged)}[${c3Check.activeDesc},connected=${String(c3Check.targetConnected)}], scrollUnchanged=${String(c3Check.scrollUnchanged)})`);
    }
  } finally {
    faults.reset();
    await c3Handle.cleanup();
  }

  faults.reset();
  const c4Handle = await collectionCase.prepare(ctx, 'C4');
  try {
    await page.evaluate(({ listSelector, focusSelector, scrollSelector }) => {
      const focusTarget = focusSelector
        ? ([...document.querySelectorAll<HTMLElement>(focusSelector)].find(
          (candidate) => candidate.closest('[hidden], [inert]') === null && !candidate.hasAttribute('disabled') && candidate.getClientRects().length > 0,
        ) ?? document.querySelector<HTMLElement>(focusSelector))
        : null;
      focusTarget?.focus();
      const scrollContainers = [...document.querySelectorAll<HTMLElement>(scrollSelector)];
      const initialScrollTops = scrollContainers.map((container) => container.scrollTop);
      let removedNodeCount = 0;
      const observers: MutationObserver[] = [];
      for (const listEl of document.querySelectorAll<HTMLElement>(listSelector)) {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const removedNode of record.removedNodes) {
              if (removedNode.nodeType === Node.ELEMENT_NODE) removedNodeCount += 1;
            }
          }
        });
        observer.observe(listEl, { childList: true });
        observers.push(observer);
      }
      Reflect.set(window, '__continuityC4', {
        focusTarget,
        scrollContainers,
        initialScrollTops,
        observers,
        readRemovedCount: () => removedNodeCount,
      });
    }, {
      listSelector: c4Handle.listSelector,
      focusSelector: c4Handle.focusSelector,
      scrollSelector: c4Handle.scrollSelector,
    });

    faults.startCountingClientFrames();
    await c4Handle.switchAwayAndBack();
    await sleep(VIEW_RETURN_SETTLE_DELAY_MS);
    const allFrames = faults.stopCountingClientFrames();
    c4ControlRequests = allFrames.filter(isControlRequestFrame);

    const c4Check = await page.evaluate(() => {
      const state = Reflect.get(window, '__continuityC4') as {
        focusTarget: HTMLElement | null;
        scrollContainers: HTMLElement[];
        initialScrollTops: number[];
        observers: MutationObserver[];
        readRemovedCount: () => number;
      };
      for (const observer of state.observers) observer.disconnect();
      const removedCount = state.readRemovedCount();
      const scrollUnchanged = state.scrollContainers.every(
        (container, index) => container.scrollTop === state.initialScrollTops[index],
      );
      const focusNodeRetained = state.focusTarget === null || state.focusTarget.isConnected;
      const activeElementUnchanged = state.focusTarget === null || document.activeElement === state.focusTarget;
      const activeDesc = document.activeElement
        ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id}.${document.activeElement.className}`
        : 'null';
      Reflect.deleteProperty(window, '__continuityC4');
      return { removedCount, scrollUnchanged, focusNodeRetained, activeElementUnchanged, activeDesc };
    });

    const extraFailure = c4Handle.verifyAfterReturn ? await c4Handle.verifyAfterReturn() : null;
    const isRemovedOk = c4Handle.observeRemovedNodesOnC4 === false || c4Check.removedCount === 0;
    const isRequestsOk = c4Handle.allowControlRequestsOnC4 === true || c4ControlRequests.length === 0;
    c4Passed = isRequestsOk
      && isRemovedOk
      && c4Check.scrollUnchanged
      && c4Check.focusNodeRetained
      && c4Check.activeElementUnchanged
      && extraFailure === null;
    if (!c4Passed) {
      const extraPart = extraFailure ? `, extra=${extraFailure}` : '';
      failures.push(`C4 view return failed (requests=[${c4ControlRequests.join(',')}], removed=${c4Check.removedCount}, scrollUnchanged=${String(c4Check.scrollUnchanged)}, focusNodeRetained=${String(c4Check.focusNodeRetained)}, activeUnchanged=${String(c4Check.activeElementUnchanged)}[${c4Check.activeDesc}]${extraPart})`);
    }
  } finally {
    faults.reset();
    await c4Handle.cleanup();
  }

  return {
    name: collectionCase.name,
    c3Passed,
    c3RemovedNodes,
    c4Passed,
    c4ControlRequests,
    detail: failures.length === 0
      ? `C3=ok(removed=${c3RemovedNodes}) C4=ok(requests=0)`
      : failures.join('; '),
  };
}

export async function verifyContinuity(options: ContinuityRunOptions): Promise<ContinuityRunResult> {
  const ctx: ContinuityCaseContext = {
    page: options.page,
    layout: options.layout,
    sessionId: options.sessionId,
    projectDirectory: options.projectDirectory,
    faults: options.faults,
  };
  const filter = selectedCaseFilter();
  const collectionCases = filter
    ? COLLECTION_CONTINUITY_CASES.filter((entry) => filter.has(entry.name))
    : COLLECTION_CONTINUITY_CASES;
  const actionCases = filter
    ? ACTION_CONTINUITY_CASES.filter((entry) => filter.has(entry.name))
    : ACTION_CONTINUITY_CASES;

  const collections: CollectionBudgetMeasurement[] = [];
  const actions: ActionBudgetMeasurement[] = [];

  for (const collectionCase of collectionCases) {
    const measurement = await runCollectionContinuityCase(collectionCase, ctx);
    collections.push(measurement);
    console.log(`[continuity ${options.layout}] collection ${measurement.name}: ${measurement.detail}`);
  }

  for (const actionCase of actionCases) {
    const measurement = await runActionContinuityCase(actionCase, ctx);
    actions.push(measurement);
    console.log(`[continuity ${options.layout}] action ${measurement.name}: ${measurement.detail}`);
  }

  const failedCollections = collections.filter((entry) => !entry.c3Passed || !entry.c4Passed);
  const failedActions = actions.filter((entry) => !entry.c1Passed || !entry.c2Passed || !entry.c5Passed);
  const ok = failedCollections.length === 0 && failedActions.length === 0;

  if (ok) {
    return {
      ok: true,
      detail: `${collections.length} collections and ${actions.length} actions passed C1 to C5 on ${options.layout}`,
      actions,
      collections,
    };
  }

  const failureLines = [
    ...failedCollections.map((entry) => `collection ${entry.name}: ${entry.detail}`),
    ...failedActions.map((entry) => `action ${entry.name}: ${entry.detail}`),
  ];
  return {
    ok: false,
    detail: failureLines.join(' | '),
    actions,
    collections,
  };
}
