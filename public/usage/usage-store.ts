import type { OperatorActionOf, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { createAttentionAck } from '../attention-ack-core.ts';
import { nextRequestId } from '../control-ws.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { formatAgo } from '../poll-ago.ts';
import { getUsageAttentionAck, setUsageAttentionAck } from '../ui-prefs.ts';
import {
  DEFAULT_RANGE_VALUE,
  RANGE_OPTIONS,
  planLimitsVendorOf,
  pricingFetchedAtMs,
  pricingSourceLine,
  scanLine,
  shouldApplyUsageReport,
  usageAttentionSignature,
  usageErrorLine,
} from './usage-view-core.ts';
import type { PlanLimits, PlanLimitsVendor, UsageReport } from './usage-view-core.ts';

const REFRESH_STATUS_TIMEOUT_MS = 20000;

type UsageSessionsPush = ServerMessageOf<'usage-sessions'>;
export type UsageChange = 'report' | 'sessions' | 'plan-limits' | 'refresh-status';

let report: UsageReport | null = null;
let sessions: UsageSessionsPush | null = null;
let planLimitsByVendor: Record<PlanLimitsVendor, PlanLimits | null> = { claude: null, codex: null };
let activityCallback: ((isActive: boolean) => void) | null = null;
let sendRequest: ((message: Record<string, unknown>) => boolean) | null = null;
let latestRequestId: string | null = null;
let rangeValue: string = DEFAULT_RANGE_VALUE;
let isRefreshPending = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshFailureText: string | null = null;
let isConnected = true;
let isViewLooking: () => boolean = () => false;
const subscribers = new Set<(change: UsageChange) => void>();

const attention = createAttentionAck({
  getAck: getUsageAttentionAck,
  setAck: setUsageAttentionAck,
  signature: () => usageAttentionSignature(report, planLimitsByVendor.claude),
  isLooking: () => isViewLooking(),
});

function notifySubscribers(change: UsageChange): void {
  for (const subscriber of subscribers) subscriber(change);
}

function refreshAttention(): void {
  activityCallback?.(attention.refresh());
}

function setRefreshPending(pending: boolean): void {
  isRefreshPending = pending;
  notifySubscribers('refresh-status');
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!pending) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    isRefreshPending = false;
    refreshFailureText = `Usage did not answer within ${Math.round(REFRESH_STATUS_TIMEOUT_MS / 1000)} s. Refresh to try again.`;
    notifySubscribers('refresh-status');
  }, REFRESH_STATUS_TIMEOUT_MS);
}

function daysForRange(value: string): number | null {
  const option = RANGE_OPTIONS.find((entry) => entry.value === value);
  if (!option) return null;
  return option.days;
}

export function usageSnapshot() {
  return { report, sessions, planLimitsByVendor, rangeValue };
}

export function usageRefreshStatus(): { text: string; isPending: boolean; hasFailure: boolean } {
  const hasFailure = !isConnected || (!isRefreshPending && refreshFailureText !== null);
  if (!isConnected) return { text: report ? `${NOT_CONNECTED_TEXT} The figures below are from before the connection dropped.` : NOT_CONNECTED_TEXT, isPending: isRefreshPending, hasFailure };
  if (isRefreshPending) return { text: 'Refreshing', isPending: true, hasFailure };
  return { text: refreshFailureText ?? '', isPending: false, hasFailure };
}

export function subscribeUsage(subscriber: (change: UsageChange) => void): void {
  subscribers.add(subscriber);
}

export function setUsageLookingProbe(probe: () => boolean): void {
  isViewLooking = probe;
  refreshAttention();
}

export function acknowledgeUsageAttention(): void {
  attention.acknowledge();
  refreshAttention();
}

export function setUsageActivityCallback(callback: (isActive: boolean) => void): void {
  activityCallback = callback;
  refreshAttention();
}

export function reportUsageAction(action: OperatorActionOf<'usage'>): void {
  sendRequest?.({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'usage', action } });
}

export function setUsageRequestSender(send: (message: Record<string, unknown>) => boolean): void {
  sendRequest = send;
}

export function setUsageRange(value: string): void {
  rangeValue = value;
}

export function requestUsageReport({ force = false }: { force?: boolean } = {}): void {
  if (!sendRequest) return;
  latestRequestId = nextRequestId('usage');
  const msg: Record<string, unknown> = { type: 'request-usage-report', requestId: latestRequestId };
  if (force) msg.force = true;
  const days = daysForRange(rangeValue);
  if (days !== null) msg.days = days;
  refreshFailureText = null;
  setRefreshPending(true);
  if (sendRequest(msg)) return;
  refreshFailureText = NOT_CONNECTED_TEXT;
  setRefreshPending(false);
}

export function applyUsageConnectionState(connected: boolean): void {
  isConnected = connected;
  notifySubscribers('refresh-status');
}

export function applyUsageSessions(msg: UsageSessionsPush): void {
  sessions = msg;
  notifySubscribers('sessions');
}

export function applyPlanLimits(msg: unknown): void {
  const planLimits = msg as PlanLimits;
  planLimitsByVendor = { ...planLimitsByVendor, [planLimitsVendorOf(planLimits)]: planLimits };
  notifySubscribers('plan-limits');
  refreshAttention();
}

export function applyUsageReport(msg: unknown): void {
  if (!shouldApplyUsageReport(msg, latestRequestId)) return;
  refreshFailureText = null;
  setRefreshPending(false);
  report = msg as UsageReport;
  notifySubscribers('report');
  refreshAttention();
}

export function usageStatusLines(): string[] {
  const pricing = report?.pricing || (sessions ? { source: sessions.pricingSource } : null);
  const fetchedAt = pricingFetchedAtMs(pricing?.fetchedAt);
  const agoText = fetchedAt !== null && fetchedAt > 0 ? formatAgo(fetchedAt) : '';
  const lines = [pricingSourceLine(pricing, agoText)];
  const error = usageErrorLine(report);
  if (error) lines.push(error);
  const scan = scanLine(report?.scan);
  if (scan) lines.push(scan);
  return lines;
}
