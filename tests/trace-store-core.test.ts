import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import { appendTraceRecords, chatToolOutcome, createTraceGrouping, prependTraceRecords, trimTraceGrouping } from '../public/trace-store-core.ts';

type ToolCallRecord = Extract<TraceRecord, { kind: 'tool_call' }>;

const base = { uuid: null, parentUuid: null, vendorSessionId: 'conversation-1' };

function prompt(ts: number, agentId?: string): TraceRecord {
  return { ...base, ts, kind: 'prompt', text: `prompt at ${ts}`, ...(agentId ? { agentId, agentType: 'Explore' } : {}) };
}

function toolCall(ts: number, toolUseId: string): ToolCallRecord {
  return { ...base, ts, kind: 'tool_call', toolUseId, name: 'Bash', input: { command: 'npm test' } };
}

function toolResult(ts: number, toolUseId: string): TraceRecord {
  return { ...base, ts, kind: 'tool_result', toolUseId, content: 'ok', isError: false, truncated: true };
}

test('a chat tool call runs until its result, and closes as no-result once the operator moves on or the session stops', () => {
  const grouping = createTraceGrouping();
  const answered = toolCall(2, 'answered');
  const abandoned = toolCall(3, 'abandoned');
  appendTraceRecords(grouping, [prompt(1), answered, abandoned, prompt(4, 'subagent-1')]);

  assert.deepEqual(chatToolOutcome(grouping, abandoned, true), { status: 'running' });
  assert.deepEqual(chatToolOutcome(grouping, abandoned, false), { status: 'no-result' });

  appendTraceRecords(grouping, [toolResult(5, 'answered'), prompt(6)]);
  assert.deepEqual(chatToolOutcome(grouping, answered, true), { status: 'done', isError: false, truncated: true });
  assert.deepEqual(chatToolOutcome(grouping, abandoned, true), { status: 'no-result' });

  const beforeSlashCommand = toolCall(7, 'before-slash-command');
  appendTraceRecords(grouping, [beforeSlashCommand, { ...base, ts: 8, kind: 'expansion', text: '<command-name>/review</command-name>' }]);
  assert.deepEqual(chatToolOutcome(grouping, beforeSlashCommand, true), { status: 'no-result' });

  const earlierCall = toolCall(0.5, 'earlier');
  prependTraceRecords(grouping, [prompt(0), earlierCall, toolResult(0.7, 'earlier')]);
  assert.deepEqual(chatToolOutcome(grouping, earlierCall, true), { status: 'done', isError: false, truncated: true });

  trimTraceGrouping(grouping, 3);
  assert.equal(grouping.toolResultByUseId.has('earlier'), false);
});
