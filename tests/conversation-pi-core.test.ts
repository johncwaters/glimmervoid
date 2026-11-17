import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TraceRecord } from '../shared/contracts/trace.ts';
import { piRecordsFromLine } from '../server/core/conversation/pi-core.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'pi-session.jsonl');
const VENDOR_SESSION_ID = '01a1eaa3-6a11-745a-8f7a-862a3b0fdbe9';

function fixtureRecords(): TraceRecord[] {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);
  return lines.flatMap((line) => piRecordsFromLine(line, { vendorSessionId: VENDOR_SESSION_ID, now: 0 }));
}

test('a pi session file converts to schema-valid prompt, thinking, reply and paired command records', () => {
  const records = fixtureRecords();
  for (const record of records) assert.ok(TraceRecord.safeParse(record).success, JSON.stringify(record));
  assert.deepEqual(records.map((record) => record.kind), ['prompt', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant']);
  const [prompt, , catCall, catResult, lsCall, lsResult, finalReply] = records;
  assert.match(prompt.kind === 'prompt' ? prompt.text : '', /^Run cat note\.txt/);
  assert.deepEqual(catCall.kind === 'tool_call' ? [catCall.name, catCall.input] : null, ['bash', { command: 'cat note.txt' }]);
  assert.deepEqual(catResult.kind === 'tool_result' ? [catResult.toolUseId, catResult.content, catResult.isError] : null, [catCall.kind === 'tool_call' ? catCall.toolUseId : '', 'probe\n', false]);
  assert.equal(lsResult.kind === 'tool_result' && lsCall.kind === 'tool_call' ? lsResult.toolUseId === lsCall.toolUseId && lsResult.isError : false, true);
  assert.equal(finalReply.kind === 'assistant' ? finalReply.text : '', 'done');
  assert.ok(records.every((record) => record.vendorSessionId === VENDOR_SESSION_ID));
});
