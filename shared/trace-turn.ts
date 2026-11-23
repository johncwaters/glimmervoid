import type { TraceRecord } from './contracts/trace.ts';

export function opensOperatorTurn(record: TraceRecord): boolean {
  if (record.agentId !== undefined) return false;
  if (record.kind === 'prompt') return true;
  return record.kind === 'expansion' && record.toolUseId === undefined && record.midTurn !== true;
}
