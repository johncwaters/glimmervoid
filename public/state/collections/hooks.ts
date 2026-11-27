import { isRecord } from '#shared/coerce.ts';
import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { cloneValue } from '#shared/settings/registry-core.ts';
import { nextRequestId, sendControlMsg } from '../../control-ws.ts';
import type { HooksReport } from '../../hooks-view-core.ts';
import { applyCollectionServerMessage, defineCollection, watchCollection } from '../define-collection.ts';
import {
  INITIAL_HOOKS_STATE,
  applyHooksServerMessage,
  shouldApplyHooksReport,
} from '../hooks-core.ts';
import type { HooksCollectionState } from '../hooks-core.ts';

type HooksChangeListener = () => void;

const changeListeners = new Set<HooksChangeListener>();
let hasReportSendFailed = false;
let latestRequestId: string | null = null;

function notifyChangeListeners(): void {
  for (const listener of [...changeListeners]) {
    listener();
  }
}

const hooksCollection = defineCollection<HooksCollectionState>({
  name: 'hooks',
  key: null,
  initial: INITIAL_HOOKS_STATE,
  apply: applyHooksServerMessage,
});

watchCollection(
  hooksCollection,
  (state) => `${state.serverRevision}:${state.optimisticRevision}`,
  notifyChangeListeners,
);

export function hooksSnapshot(): { report: HooksReport | null; hasReportSendFailed: boolean } {
  const report = hooksCollection.state.report
    ? cloneValue(hooksCollection.state.report) as HooksReport
    : null;
  return { report, hasReportSendFailed };
}

export function onHooksChanged(listener: HooksChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function requestHooksReport(): void {
  latestRequestId = nextRequestId('hooks-report');
  const wasSent = sendControlMsg({ type: 'request-hooks-report', requestId: latestRequestId });
  if (wasSent === !hasReportSendFailed) return;
  hasReportSendFailed = !wasSent;
  notifyChangeListeners();
}

export function applyHooksReport(message: ServerMessageOf<'hooks-report'>): void {
  if (!shouldApplyHooksReport(message, latestRequestId)) return;
  hasReportSendFailed = false;
  applyCollectionServerMessage('hooks', message);
}

export function applyLateHookResult(): void {
  requestHooksReport();
}

export function reconcileSavedHook(hook: unknown): void {
  if (!isRecord(hook) || typeof hook.id !== 'string') return;
  applyCollectionServerMessage('hooks', {
    type: 'save-hook-result',
    ok: true,
    hook: cloneValue(hook) as Record<string, unknown>,
    appliedSeq: 0,
  } as ServerMessage);
}

export function reconcileDeletedHook(hookId: string): void {
  applyCollectionServerMessage('hooks', {
    type: 'delete-hook-result',
    ok: true,
    id: hookId,
    appliedSeq: 0,
  } as ServerMessage);
}

export default hooksCollection;
