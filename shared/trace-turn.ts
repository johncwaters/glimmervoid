import type { TraceRecord } from './contracts/trace.ts';

export function opensOperatorTurn(record: TraceRecord): boolean {
  if (record.agentId !== undefined) return false;
  return record.kind === 'prompt' || (record.kind === 'expansion' && record.toolUseId === undefined);
}
