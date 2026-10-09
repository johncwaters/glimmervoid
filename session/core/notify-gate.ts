import { isCompactionRestoreEvent } from '../../shared/compaction-restore-events.ts';
import { STATES } from '../../shared/states.ts';

interface NotifyGate {
  reset(): void;
  fire(category?: string | null): boolean;
}

interface NotifyOptions {
  signal?: string;
  hookSeen?: boolean;
}

interface NotifyDecision {
  category: string | null;
  reason: string;
}

function createNotifyGate(): NotifyGate {
  const fired = new Set<string>();

  function reset(): void {
    fired.clear();
  }

  function fire(category?: string | null): boolean {
    if (!category) return false;
    if (fired.has(category)) return false;
    fired.add(category);
    return true;
  }

  return { reset, fire };
}

function explainNotification(
  to: string,
  gate: NotifyGate,
  event?: string,
  opts?: NotifyOptions | null,
): NotifyDecision {
  if (isCompactionRestoreEvent(event)) return { category: null, reason: 'compaction-restored-silently' };
  if (to === STATES.INITIALIZING) {
    gate.reset();
    return { category: null, reason: 'cycle-reset-restart' };
  }
  if (to === STATES.RUNNING) {
    const userDriven = event === 'user_input'
      || Boolean(opts && opts.signal === 'resume')
      || !opts || !opts.hookSeen;
    if (userDriven) {
      gate.reset();
      return { category: null, reason: 'cycle-reset-user-driven' };
    }
    return { category: null, reason: 'self-wake-no-reset' };
  }

  if (event === 'user_kill') return { category: null, reason: 'user-kill-silent' };
  if (to === STATES.WAITING) return { category: 'waiting', reason: 'waiting-not-gated' };
  if (to === STATES.COMPLETE || to === STATES.DONE) {
    if (gate.fire('complete')) return { category: 'complete', reason: 'first-this-cycle' };
    return { category: null, reason: 'already-notified-this-cycle' };
  }
  if (to === STATES.FAILED) {
    if (gate.fire('failed')) return { category: 'failed', reason: 'first-this-cycle' };
    return { category: null, reason: 'already-notified-this-cycle' };
  }
  return { category: null, reason: 'not-a-notifying-state' };
}

interface AcknowledgeDecision {
  shouldAcknowledge: boolean;
  isAcknowledgeDeferred: boolean;
}

const NOTIFIED_STATES: ReadonlySet<string> = new Set([STATES.WAITING, STATES.COMPLETE, STATES.DONE, STATES.FAILED]);

function decideAcknowledge(
  isAcknowledgeDeferred: boolean,
  from: string,
  event: string | undefined,
  isIdleCompactionActivity: boolean,
): AcknowledgeDecision {
  const isLeavingNotifiedState = NOTIFIED_STATES.has(from);
  if (isLeavingNotifiedState && isIdleCompactionActivity) return { shouldAcknowledge: false, isAcknowledgeDeferred: true };
  if (isCompactionRestoreEvent(event)) return { shouldAcknowledge: false, isAcknowledgeDeferred: false };
  return { shouldAcknowledge: isLeavingNotifiedState || isAcknowledgeDeferred, isAcknowledgeDeferred: false };
}

function decideNotification(
  to: string,
  gate: NotifyGate,
  event?: string,
  opts?: NotifyOptions | null,
): string | null {
  return explainNotification(to, gate, event, opts).category;
}

export { createNotifyGate, decideAcknowledge, decideNotification, explainNotification };
export type { AcknowledgeDecision, NotifyDecision, NotifyGate, NotifyOptions };
