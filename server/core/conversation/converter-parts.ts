import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { boundedText, unwrapSpilledToolOutput } from '../trace-core.ts';
import type { SpillWrappingAgent } from '../trace-core.ts';

type RecordBase = Pick<TraceRecord, 'ts' | 'uuid' | 'parentUuid' | 'vendorSessionId' | 'agentId' | 'agentType'>;

function parsedJson(rawLine: string): unknown {
  try {
    return JSON.parse(rawLine);
  } catch {
    return null;
  }
}

function textRecords(base: RecordBase, kind: 'prompt' | 'assistant' | 'thinking' | 'expansion', text: string): TraceRecord[] {
  if (text.length === 0) return [];
  const bounded = boundedText(text);
  return [{ ...base, kind, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) }];
}

function boundedToolOutput(agent: SpillWrappingAgent, output: string): { content: string; truncated: boolean } {
  const unwrapped = unwrapSpilledToolOutput(agent, output);
  const bounded = boundedText(unwrapped.output);
  return { content: bounded.text, truncated: bounded.truncated || unwrapped.isSpilled };
}

export { boundedToolOutput, parsedJson, textRecords };
export type { RecordBase };
