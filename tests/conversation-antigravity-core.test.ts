import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TraceRecord } from '../shared/contracts/trace.ts';
import { antigravityRecordsFromLine } from '../server/core/conversation/antigravity-core.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'antigravity-transcript.jsonl');
const VENDOR_SESSION_ID = 'e49c4f93-2b16-498c-ac66-a509a837905c';

function fixtureRecords(): TraceRecord[] {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);
  return lines.flatMap((line) => antigravityRecordsFromLine(line, { vendorSessionId: VENDOR_SESSION_ID, now: 0 }));
}

test('an Antigravity transcript converts to schema-valid prompt, thinking, paired tool and reply records', () => {
  const records = fixtureRecords();
  for (const record of records) assert.ok(TraceRecord.safeParse(record).success, JSON.stringify(record));
  assert.deepEqual(records.map((record) => record.kind), ['prompt', 'thinking', 'tool_call', 'tool_result', 'thinking', 'tool_call', 'tool_result', 'assistant']);
  const [prompt, , commandCall, commandResult, , readCall, readResult, reply] = records;
  assert.equal(prompt.kind === 'prompt' ? prompt.text : '', 'Use your tools, one call each, in order: run `cat note.txt` in the terminal, then read the file missing-file-xyz.txt, then reply with the single word done.');
  assert.deepEqual(commandCall.kind === 'tool_call' ? [commandCall.name, commandCall.input] : null, ['run_command', { CommandLine: 'cat note.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Display note.txt' }]);
  assert.deepEqual(commandResult.kind === 'tool_result' && commandCall.kind === 'tool_call' ? [commandResult.toolUseId === commandCall.toolUseId, commandResult.isError, commandResult.content.includes('Created At')] : null, [true, false, false]);
  assert.deepEqual(readResult.kind === 'tool_result' && readCall.kind === 'tool_call' ? [readResult.toolUseId === readCall.toolUseId, readResult.isError] : null, [true, true]);
  assert.equal(reply.kind === 'assistant' ? reply.text : '', 'done');
  assert.ok(records.every((record) => record.vendorSessionId === VENDOR_SESSION_ID && record.ts > 0));
});

test('an oversized Antigravity MCP call keeps its server and tool names in the cut input', () => {
  const step = { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T18:12:19Z', thinking: '', tool_calls: [{ name: 'call_mcp_tool', args: { Arguments: { ops: 'x'.repeat(200000) }, ServerName: 'glimmervoid_glimmervoid', ToolName: 'whiteboard' } }] };
  const [call] = antigravityRecordsFromLine(JSON.stringify(step), { vendorSessionId: VENDOR_SESSION_ID, now: 0 });
  assert.ok(call?.kind === 'tool_call' && call.truncated === true && typeof call.input === 'string');
  assert.match(call.input, /^\{"ServerName":"glimmervoid_glimmervoid","ToolName":"whiteboard"/);
});
