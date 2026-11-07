import crypto from 'node:crypto';

function observedPayloadEventKey(payload: { observedAt: string }, intervalStartMs: number): string {
  const { observedAt: _observedAt, ...observed } = payload;
  return `${intervalStartMs}:${crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex')}`;
}

export { observedPayloadEventKey };
