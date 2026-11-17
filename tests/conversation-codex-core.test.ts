import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TraceRecord } from '../shared/contracts/trace.ts';
import { codexRecordsFromLine } from '../server/core/conversation/codex-core.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'codex-rollout.jsonl');

function fixtureRecords(): TraceRecord[] {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);
  return lines.flatMap((line) => codexRecordsFromLine(line, { vendorSessionId: 'fallback-session', now: 0 }));
}

test('a live codex rollout converts to schema-valid prompt, reply and paired command records', () => {
  const records = fixtureRecords();
  for (const record of records) assert.ok(TraceRecord.safeParse(record).success, JSON.stringify(record));
  assert.deepEqual(records.map((record) => record.kind), ['prompt', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant']);
  const [prompt, , catCall, catResult, lsCall, lsResult, finalReply] = records;
  assert.match(prompt.kind === 'prompt' ? prompt.text : '', /^Run the shell command: cat note\.txt/);
  assert.deepEqual(catCall.kind === 'tool_call' ? [catCall.name, catCall.input] : null, ['shell', { command: 'cat note.txt' }]);
  assert.deepEqual(catResult.kind === 'tool_result' ? [catResult.toolUseId, catResult.content, catResult.isError] : null, [catCall.kind === 'tool_call' ? catCall.toolUseId : '', 'probe\n', false]);
  assert.equal(lsResult.kind === 'tool_result' && lsCall.kind === 'tool_call' ? lsResult.toolUseId === lsCall.toolUseId && lsResult.isError : false, true);
  assert.equal(finalReply.kind === 'assistant' ? finalReply.text : '', 'done');
  assert.ok(records.every((record) => record.vendorSessionId === '01a1ea8d-3204-7bf3-a022-1aedf182e1dc'));
});
