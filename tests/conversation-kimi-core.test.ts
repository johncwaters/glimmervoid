import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TraceRecord } from '../shared/contracts/trace.ts';
import { kimiRecordsFromLine } from '../server/core/conversation/kimi-core.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'kimi-wire.jsonl');
const VENDOR_SESSION_ID = 'session_2c2d0092-eee8-4450-a133-5c9887f826b3';

function fixtureRecords(): TraceRecord[] {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);
  return lines.flatMap((line) => kimiRecordsFromLine(line, { vendorSessionId: VENDOR_SESSION_ID, now: 0 }));
}

test('a live kimi wire log converts to schema-valid prompt, thinking, reply and paired command records', () => {
  const records = fixtureRecords();
  for (const record of records) assert.ok(TraceRecord.safeParse(record).success, JSON.stringify(record));
  assert.deepEqual(records.map((record) => record.kind), ['prompt', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'thinking', 'assistant']);
  const [prompt, , catCall, catResult, lsCall, lsResult, , finalReply] = records;
  assert.match(prompt.kind === 'prompt' ? prompt.text : '', /^Run these with your shell tool/);
  assert.deepEqual(catCall.kind === 'tool_call' ? [catCall.name, catCall.input] : null, ['Bash', { command: 'cat note.txt' }]);
  assert.deepEqual(catResult.kind === 'tool_result' ? [catResult.toolUseId, catResult.content, catResult.isError] : null, [catCall.kind === 'tool_call' ? catCall.toolUseId : '', 'probe\n', false]);
  assert.equal(lsResult.kind === 'tool_result' && lsCall.kind === 'tool_call' ? lsResult.toolUseId === lsCall.toolUseId && lsResult.isError : false, true);
  assert.equal(finalReply.kind === 'assistant' ? finalReply.text : '', 'done');
  assert.ok(records.every((record) => record.vendorSessionId === VENDOR_SESSION_ID));
});

test('a kimi slash skill keeps the typed command as the prompt and the injected skill body as an expansion', () => {
  const skillPromptLine = JSON.stringify({
    type: 'turn.prompt',
    input: [
      { type: 'text', text: 'User activated the skill "mcp-config". Follow the loaded skill instructions.', meta: { source: 'skill activation', activationId: 'a1' } },
      { type: 'text', text: '/mcp-config' },
    ],
    origin: { kind: 'user', skillActivations: [{ activationId: 'a1', skillName: 'mcp-config' }] },
    promptId: 'msg_skill',
    time: 1,
  });
  const records = kimiRecordsFromLine(skillPromptLine, { vendorSessionId: VENDOR_SESSION_ID, now: 0 });
  assert.deepEqual(records.map((record) => [record.kind, 'text' in record ? record.text : null]), [
    ['expansion', 'User activated the skill "mcp-config". Follow the loaded skill instructions.'],
    ['prompt', '/mcp-config'],
  ]);
});
