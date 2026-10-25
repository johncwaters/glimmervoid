import { CHANGES_WATCH_LEASE_MS } from '../../shared/contracts/control-messages.ts';

type ChangesWatch<Holder> = { holder: Holder; sessionId: string; renewedAtMs: number };

function decideWatchRequest<Holder>(
  current: ChangesWatch<Holder> | null,
  request: { holder: Holder; sessionId: string | null; nowMs: number },
): { next: ChangesWatch<Holder> | null; shouldCheckNow: boolean } {
  if (request.sessionId === null) {
    const isHeldByRequester = current !== null && current.holder === request.holder;
    return { next: isHeldByRequester ? null : current, shouldCheckNow: false };
  }
  const isRenewal = current !== null && current.holder === request.holder && current.sessionId === request.sessionId;
  return {
    next: { holder: request.holder, sessionId: request.sessionId, renewedAtMs: request.nowMs },
    shouldCheckNow: !isRenewal,
  };
}

function decidePollTick<Holder>(
  current: ChangesWatch<Holder> | null,
  tick: { nowMs: number; isHolderOpen: boolean },
): { next: ChangesWatch<Holder> | null; sessionIdToCheck: string | null } {
  if (current === null) return { next: null, sessionIdToCheck: null };
  const isLeaseExpired = tick.nowMs - current.renewedAtMs > CHANGES_WATCH_LEASE_MS;
  if (isLeaseExpired || !tick.isHolderOpen) return { next: null, sessionIdToCheck: null };
  return { next: current, sessionIdToCheck: current.sessionId };
}

export { decidePollTick, decideWatchRequest };
export type { ChangesWatch };
