import { nextRequestId } from './control-ws.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';
import type { BenchmarkAction, BenchmarkStatus } from '#shared/contracts/benchmark.ts';

type BenchmarkRequestSender = (message: Record<string, unknown>) => boolean;

const ACTION_PENDING_TEXT: Readonly<Record<BenchmarkAction, string>> = { mine: 'Mining merged pull requests.', run: 'Starting the run.', cancel: 'Cancelling the run.' };

let status: BenchmarkStatus | null = null;
let requestSender: BenchmarkRequestSender | null = null;
let isServerConnected = true;
const pendingActionBySuite = new Map<string, BenchmarkAction>();
const outcomeBySuite = new Map<string, string>();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}

export function subscribeBenchmarks(subscriber: () => void): void {
  subscribers.add(subscriber);
}

export function benchmarkSnapshot(): { status: BenchmarkStatus | null; isServerConnected: boolean; pendingActionBySuite: ReadonlyMap<string, BenchmarkAction>; outcomeBySuite: ReadonlyMap<string, string> } {
  return { status, isServerConnected, pendingActionBySuite, outcomeBySuite };
}

export function setBenchmarkRequestSender(sender: BenchmarkRequestSender): void {
  requestSender = sender;
}

export function sendBenchmarkAction(suiteId: string, action: BenchmarkAction): void {
  const isSent = requestSender?.({ type: 'benchmark-action', requestId: nextRequestId('benchmark'), suiteId, action }) === true;
  if (!isSent) {
    outcomeBySuite.set(suiteId, NOT_CONNECTED_TEXT);
    notifySubscribers();
    return;
  }
  pendingActionBySuite.set(suiteId, action);
  outcomeBySuite.set(suiteId, ACTION_PENDING_TEXT[action]);
  notifySubscribers();
}

export function applyBenchmarkConnectionState(connected: boolean): void {
  isServerConnected = connected;
  if (!connected) {
    for (const suiteId of pendingActionBySuite.keys()) outcomeBySuite.delete(suiteId);
    pendingActionBySuite.clear();
  }
  notifySubscribers();
}

export function applyBenchmarkStatus(message: BenchmarkStatus): void {
  status = message;
  notifySubscribers();
}

export function applyBenchmarkActionResult(message: { suiteId: string; action: BenchmarkAction; ok: boolean; error?: string; runId?: string }): void {
  pendingActionBySuite.delete(message.suiteId);
  const candidateCount = status?.suites.find((suite) => suite.id === message.suiteId)?.candidateCount ?? 0;
  const doneText: Record<BenchmarkAction, string> = { mine: `Mining finished. ${candidateCount} candidate${candidateCount === 1 ? '' : 's'} awaiting approval in the candidates folder.`, run: `Run ${message.runId ?? ''} started.`, cancel: 'Run cancelled.' };
  outcomeBySuite.set(message.suiteId, message.ok ? doneText[message.action] : message.error || 'The server refused the action.');
  notifySubscribers();
}
