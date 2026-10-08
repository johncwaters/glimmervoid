const READY_STATE_CONNECTING = 0;
const READY_STATE_OPEN = 1;

export const CONNECTING_WEDGE_MS = 10000;
export const RECYCLE_AFTER_HIDDEN_MS = 10000;

interface LivenessInput {
  hasSocket: boolean;
  readyState: number | null;
  retryPending: boolean;
  connectingAgeMs?: number;
  hiddenForMs?: number;
}

function wasHiddenLongEnoughToPresumeDead(hiddenForMs: number | undefined) {
  if (typeof hiddenForMs !== 'number' || !Number.isFinite(hiddenForMs)) return false;
  return hiddenForMs >= RECYCLE_AFTER_HIDDEN_MS;
}

export function decideLivenessAction({ hasSocket, readyState, retryPending, connectingAgeMs = 0, hiddenForMs }: LivenessInput) {
  if (retryPending) return 'retry-now';
  if (!hasSocket) return 'connect';
  if (wasHiddenLongEnoughToPresumeDead(hiddenForMs)) return 'connect';
  if (readyState === READY_STATE_CONNECTING) {
    return connectingAgeMs > CONNECTING_WEDGE_MS ? 'connect' : 'wait';
  }
  if (readyState === READY_STATE_OPEN) return 'probe';
  return 'connect';
}
