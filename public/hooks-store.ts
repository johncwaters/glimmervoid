import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { nextRequestId } from './control-ws.ts';
import type { HooksReport } from './hooks-view-core.ts';

let report: HooksReport | null = null;
let sendRequest: ((message: Record<string, unknown>) => boolean) | null = null;
let hasReportSendFailed = false;
let latestRequestId: string | null = null;
const subscribers = new Set<() => void>();

function shouldApplyHooksReport(msg: unknown, awaitedRequestId: unknown) {
  if (!msg || typeof msg !== 'object') return false;
  const requestId = (msg as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string' || !awaitedRequestId) return true;
  return requestId === awaitedRequestId;
}

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}

export function hooksSnapshot(): { report: HooksReport | null; hasReportSendFailed: boolean } {
  return { report, hasReportSendFailed };
}

export function subscribeHooks(subscriber: () => void): void {
  subscribers.add(subscriber);
}

export function setHooksRequestSender(send: (message: Record<string, unknown>) => boolean): void {
  sendRequest = send;
}

export function requestHooksReport(): void {
  if (!sendRequest) return;
  latestRequestId = nextRequestId('hooks-report');
  const wasSent = sendRequest({ type: 'request-hooks-report', requestId: latestRequestId });
  if (wasSent === !hasReportSendFailed) return;
  hasReportSendFailed = !wasSent;
  notifySubscribers();
}

export function applyHooksReport(msg: ServerMessageOf<'hooks-report'>): void {
  if (!shouldApplyHooksReport(msg, latestRequestId)) return;
  report = msg;
  hasReportSendFailed = false;
  notifySubscribers();
}

export function applyLateHookResult(): void {
  requestHooksReport();
}
