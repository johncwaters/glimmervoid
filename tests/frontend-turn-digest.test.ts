import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import { appendChatRecords, createChatPartsState, endChatTurn } from '../public/chat/chat-parts-core.ts';

const WORKING_DIRECTORY = '/work/repo';

function toolCall(name: string, input: unknown, ts: number): TraceRecord {
  return { kind: 'tool_call', toolUseId: `call-${ts}`, name, input, ts, uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
}

function endedTurnFacts(editCalls: readonly { name: string; input: unknown }[]) {
  const state = createChatPartsState(WORKING_DIRECTORY);
  appendChatRecords(state, [
    { kind: 'prompt', text: 'Make the change', ts: 1_000, uuid: null, parentUuid: null, vendorSessionId: 'vendor' },
    ...editCalls.map((call, index) => toolCall(call.name, call.input, 2_000 + index)),
    { kind: 'assistant', text: 'Done.', ts: 9_000, uuid: null, parentUuid: null, vendorSessionId: 'vendor' },
  ]);
  const [endedTurn] = endChatTurn(state);
  assert.equal(endedTurn?.kind, 'turn');
  if (endedTurn?.kind !== 'turn') return null;
  return { toolCount: endedTurn.toolCount, ...endedTurn.fileEdits, durationText: endedTurn.durationText };
}

test('every first-class agent edit input counts toward the turn files and changed lines', () => {
  const editCallsByAgent: Record<string, { name: string; input: unknown }[]> = {
    claude: [
      { name: 'Edit', input: { file_path: `${WORKING_DIRECTORY}/a.ts`, old_string: 'one\ntwo', new_string: 'one\nTWO\nthree' } },
      { name: 'MultiEdit', input: { file_path: `${WORKING_DIRECTORY}/b.ts`, edits: [{ old_string: 'x', new_string: 'y' }] } },
      { name: 'Write', input: { file_path: `${WORKING_DIRECTORY}/c.ts`, content: 'l1\nl2\nl3\n' } },
    ],
    kimi: [
      { name: 'Edit', input: { path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\nTWO\nthree' } },
      { name: 'Edit', input: { path: 'b.ts', old_string: 'x', new_string: 'y' } },
      { name: 'Write', input: { path: 'c.ts', content: 'l1\nl2\nl3' } },
    ],
    pi: [
      { name: 'edit', input: { path: 'a.ts', oldText: 'one\ntwo', newText: 'one\nTWO\nthree' } },
      { name: 'edit', input: { path: 'b.ts', oldText: 'x', newText: 'y' } },
      { name: 'write', input: { path: 'c.ts', content: 'l1\nl2\nl3' } },
    ],
    opencode: [
      { name: 'edit', input: { filePath: 'a.ts', oldString: 'one\ntwo', newString: 'one\nTWO\nthree' } },
      { name: 'edit', input: { filePath: 'b.ts', oldString: 'x', newString: 'y' } },
      { name: 'write', input: { filePath: 'c.ts', content: 'l1\nl2\nl3' } },
    ],
    antigravity: [
      { name: 'replace_file_content', input: { TargetFile: 'a.ts', ReplacementChunks: [{ TargetContent: 'one\ntwo', ReplacementContent: 'one\nTWO\nthree' }] } },
      { name: 'multi_replace_file_content', input: { TargetFile: 'b.ts', ReplacementChunks: [{ TargetContent: 'x', ReplacementContent: 'y' }] } },
      { name: 'write_to_file', input: { TargetFile: 'c.ts', CodeContent: 'l1\nl2\nl3' } },
    ],
    codex: [
      { name: 'apply_patch', input: { changes: { 'a.ts': { type: 'update', unified_diff: '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n', move_path: null } } } },
      { name: 'apply_patch', input: { changes: { 'b.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n', move_path: null }, 'c.ts': { type: 'add', content: 'l1\nl2\nl3\n' } } } },
      { name: 'shell', input: { command: 'npm test' } },
    ],
  };
  for (const [agent, editCalls] of Object.entries(editCallsByAgent)) {
    assert.deepEqual(endedTurnFacts(editCalls), { toolCount: 3, fileCount: 3, added: 6, removed: 2, hasLineCounts: true, durationText: '8s' }, agent);
  }
});
