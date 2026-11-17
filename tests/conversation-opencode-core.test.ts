import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONVERSATION_EVENTS_HOOK_EVENT, TraceRecord } from '../shared/contracts/trace.ts';
import { opencodeRecordsFromPayload } from '../server/core/conversation/opencode-core.ts';

const RECEIVED_AT = 1_700_000_000_000;
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'opencode-relay.jsonl');

function fixtureRecords(): TraceRecord[] {
  const relays = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  return relays
    .filter((relay) => relay.event === CONVERSATION_EVENTS_HOOK_EVENT)
    .flatMap((relay) => opencodeRecordsFromPayload(relay.body, RECEIVED_AT));
}

test('an OpenCode turn relayed by the plugin converts to schema-valid prompt, thinking, tool and reply records', () => {
  const records = fixtureRecords();
  for (const record of records) assert.ok(TraceRecord.safeParse(record).success, JSON.stringify(record));
  assert.deepEqual(records.map((record) => record.kind), ['prompt', 'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant']);
  const toolCalls = records.filter((record) => record.kind === 'tool_call');
  const toolResults = records.filter((record) => record.kind === 'tool_result');
  assert.deepEqual(toolResults.map((result) => result.toolUseId), toolCalls.map((call) => call.toolUseId));
  assert.deepEqual(toolCalls.map((call) => call.name), ['shell', 'read']);
  assert.deepEqual(toolResults.map((result) => [result.content, result.isError]), [['probe\n', false], ['File not found: missing-file-xyz.txt', true]]);
  assert.ok(records.every((record) => record.ts === RECEIVED_AT && record.vendorSessionId.startsWith('ses_')));
});
