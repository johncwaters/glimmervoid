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
  return { toolCount: endedTurn.toolCount, ...endedTurn.fileEdits, durationText: endedTurn.durationText, patchedPaths: endedTurn.filePatches.map((filePatch) => filePatch.path) };
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
    assert.deepEqual(endedTurnFacts(editCalls), { toolCount: 3, fileCount: 3, added: 6, removed: 2, hasLineCounts: true, durationText: '8s', patchedPaths: ['a.ts', 'b.ts', 'c.ts'] }, agent);
  }
});

function promptTextsOf(records: readonly TraceRecord[]) {
  const { parts } = appendChatRecords(createChatPartsState(WORKING_DIRECTORY), records);
  return parts.flatMap((part) => (part.kind === 'prompt' ? [{ text: part.text, attachments: part.attachments }] : []));
}

test('a prompt Claude Code wrapped as pasted content shows the pasted text with any typed text around it', () => {
  const recordOf = (text: string): TraceRecord => ({ kind: 'prompt', text, ts: 1_000, uuid: null, parentUuid: null, vendorSessionId: 'vendor' });
  assert.deepEqual(promptTextsOf([recordOf('\n\n<pasted_content id="d831">\nBoard cards should scroll\n\nlike pages\n</pasted_content id="d831">')]), [{ text: 'Board cards should scroll\n\nlike pages', attachments: [] }]);
  assert.deepEqual(promptTextsOf([recordOf('see this:\n<pasted_content id="a1">\npasted body\n</pasted_content id="a1">\nthanks')]), [{ text: 'see this:\npasted body\nthanks', attachments: [] }]);
  assert.deepEqual(promptTextsOf([recordOf('<pasted_content id="z9">\nquote: <pasted_content id="a1">x</pasted_content id="a1">\n</pasted_content id="z9">')]), [{ text: 'quote: <pasted_content id="a1">x</pasted_content id="a1">', attachments: [] }]);
  const imageName = '2026-11-19T23-02-41-516Z-f8f5932a-chat.png';
  const pastedPrefix = `/uploads/${imageName}`;
  const attachments: TraceRecord = { kind: 'attachments', files: [imageName], pastedPrefix, ts: 900, uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  assert.deepEqual(promptTextsOf([attachments, recordOf(`\n\n<pasted_content id="b2">\n${pastedPrefix} what is wrong here\n</pasted_content id="b2">`)]), [{ text: 'what is wrong here', attachments: [imageName] }]);
});

test('a board answer prompt is marked whether its record arrives before or after the prompt, and the next operator prompt is not', () => {
  const recordBase = { uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  const boardAnswer: TraceRecord = { kind: 'board-answer', ts: 2_000, ...recordBase };
  const answerPrompt: TraceRecord = { kind: 'prompt', text: 'Answer to your board question', ts: 2_100, ...recordBase };
  const reply: TraceRecord = { kind: 'assistant', text: 'Reusing it.', ts: 2_200, ...recordBase };
  const nextPrompt: TraceRecord = { kind: 'prompt', text: 'Now add tax', ts: 3_000, ...recordBase };
  const boardAnswerFlagsOf = (records: readonly TraceRecord[]) => {
    const { parts } = appendChatRecords(createChatPartsState(WORKING_DIRECTORY), records);
    const promptById = new Map(parts.flatMap((part) => (part.kind === 'prompt' ? [[part.id, part.isBoardAnswer] as const] : [])));
    return [...promptById.values()];
  };
  assert.deepEqual(boardAnswerFlagsOf([boardAnswer, answerPrompt, reply, nextPrompt]), [true, false]);
  assert.deepEqual(boardAnswerFlagsOf([answerPrompt, boardAnswer, reply, nextPrompt]), [true, false]);
  const askingPrompt: TraceRecord = { kind: 'prompt', text: 'ask-shop', ts: 1_000, ...recordBase };
  assert.deepEqual(boardAnswerFlagsOf([askingPrompt, boardAnswer, answerPrompt, reply]), [false, true]);
  assert.deepEqual(boardAnswerFlagsOf([boardAnswer, askingPrompt, answerPrompt, reply]), [false, true]);
  const answeredMidSecond: TraceRecord = { kind: 'board-answer', ts: 2_480, ...recordBase };
  const wholeSecondAnswerPrompt: TraceRecord = { kind: 'prompt', text: 'Answer to your board question', ts: 2_000, ...recordBase };
  assert.deepEqual(boardAnswerFlagsOf([answeredMidSecond, wholeSecondAnswerPrompt, reply, nextPrompt]), [true, false]);
  assert.deepEqual(boardAnswerFlagsOf([wholeSecondAnswerPrompt, answeredMidSecond, reply, nextPrompt]), [true, false]);
  assert.deepEqual(boardAnswerFlagsOf([answerPrompt, reply, boardAnswer, nextPrompt]), [true, false]);
});

test('a background shell the Stop payload reports running gets a row named by its call that keeps its start and ends at its stop or when a new agent process starts', () => {
  const state = createChatPartsState(WORKING_DIRECTORY);
  const recordBase = { uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  const appended = appendChatRecords(state, [
    { kind: 'prompt', text: 'Find the bad commit', ts: 1_000, ...recordBase },
    toolCall('Bash', { command: 'git bisect run ./check.sh', description: 'Bisect the pane failure', run_in_background: true }, 2_000),
    { kind: 'tool_result', toolUseId: 'call-2000', content: 'Command running in background with ID: b1', isError: false, truncated: false, backgroundTaskId: 'b1', ts: 2_500, ...recordBase },
    { kind: 'background-task', phase: 'start', taskId: 'b1', taskType: 'shell', ts: 9_000, ...recordBase },
    { kind: 'background-task', phase: 'start', taskId: 'm2', taskType: 'monitor', ts: 9_000, ...recordBase },
    { kind: 'background-task', phase: 'stop', taskId: 'b1', taskType: 'shell', ts: 70_000, ...recordBase },
    { kind: 'session', vendor: 'claude', transcriptPath: '/transcripts/vendor.jsonl', ts: 90_000, ...recordBase },
  ]);
  const backgroundTaskParts = appended.parts.flatMap((part) => part.kind === 'background-task' ? [part] : []);
  assert.deepEqual(backgroundTaskParts.map(({ taskType, label, command, startedAt, endedAt }) => ({ taskType, label, command, startedAt, endedAt })), [
    { taskType: 'shell', label: 'Bisect the pane failure', command: 'git bisect run ./check.sh', startedAt: 2_500, endedAt: 70_000 },
    { taskType: 'monitor', label: 'm2', command: null, startedAt: 9_000, endedAt: 90_000 },
  ]);
});

test('a workflow row is named by its workflow and summary whether its hook start comes before or after the launch result', () => {
  const recordBase = { uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  const workflowCall = toolCall('Workflow', { name: 'qa-swarm', args: { reviewCmd: 'git diff a..b' } }, 2_000);
  const launchResult: TraceRecord = { kind: 'tool_result', toolUseId: 'call-2000', content: 'Workflow launched in background. Task ID: w1', isError: false, truncated: false, backgroundTaskId: 'w1', backgroundTaskName: 'qa-swarm', backgroundTaskSummary: 'Routes a pinned review through the lanes.', ts: 2_100, ...recordBase };
  const hookStart: TraceRecord = { kind: 'background-task', phase: 'start', taskId: 'w1', taskType: 'workflow', ts: 2_200, ...recordBase };
  const prompt: TraceRecord = { kind: 'prompt', text: 'Review the PR', ts: 1_000, ...recordBase };
  const lastRowOf = (records: TraceRecord[]) => {
    const rows = appendChatRecords(createChatPartsState(WORKING_DIRECTORY), records).parts.flatMap((part) => part.kind === 'background-task' ? [part] : []);
    const lastRow = rows.at(-1);
    return lastRow === undefined ? null : { rowCount: new Set(rows.map((row) => row.id)).size, label: lastRow.label, command: lastRow.command, startedAt: lastRow.startedAt };
  };
  const expectedRow = { rowCount: 1, label: 'qa-swarm', command: 'Routes a pinned review through the lanes.', startedAt: 2_100 };
  assert.deepEqual(lastRowOf([prompt, workflowCall, launchResult, hookStart]), expectedRow);
  assert.deepEqual(lastRowOf([prompt, hookStart, workflowCall, launchResult]), expectedRow);
});

test('a running subagent left open before a restart closes when a new session record arrives', () => {
  const state = createChatPartsState(WORKING_DIRECTORY);
  const recordBase = { uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  const started = appendChatRecords(state, [
    { kind: 'prompt', text: 'Review the diff', ts: 1_000, ...recordBase },
    { kind: 'subagent', phase: 'start', subagentId: 'sub-1', subagentType: 'redteam', task: 'Check invariants', ts: 2_000, ...recordBase },
  ]);
  assert.equal(started.runningSubagents.length, 1);

  const restarted = appendChatRecords(state, [
    { kind: 'session', vendor: 'antigravity', transcriptPath: '/transcripts/vendor.jsonl', ts: 10_000, ...recordBase },
  ]);
  assert.deepEqual(restarted.runningSubagents, []);
});

test('each tool call settles from its result into the turn rows with its state, duration and output head, a call left unanswered reads stopped once the turn ends, and thinking time reaches the ended turn', () => {
  const state = createChatPartsState(WORKING_DIRECTORY);
  const recordBase = { uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  appendChatRecords(state, [
    { kind: 'prompt', text: 'Run the checks', ts: 1_000, ...recordBase },
    { kind: 'thinking', text: 'Which checks matter here', ts: 1_500, ...recordBase },
    toolCall('Bash', { command: 'npm test' }, 4_000),
    toolCall('Read', { file_path: `${WORKING_DIRECTORY}/src/deep/a.ts` }, 4_100),
    toolCall('Grep', { pattern: 'never answered' }, 4_200),
    { kind: 'tool_result', toolUseId: 'call-4100', content: 'line one\nline two', isError: false, truncated: false, ts: 4_400, ...recordBase },
    { kind: 'tool_result', toolUseId: 'call-4000', content: '1 failing', isError: true, truncated: false, ts: 6_000, ...recordBase },
    { kind: 'assistant', text: 'One test fails.', ts: 7_000, ...recordBase },
  ]);
  const [endedTurn] = endChatTurn(state);
  assert.equal(endedTurn?.kind, 'turn');
  if (endedTurn?.kind !== 'turn') return;
  const toolSegment = endedTurn.segments.find((segment) => segment.kind === 'tools');
  assert.deepEqual(toolSegment?.kind === 'tools' ? toolSegment.calls.map(({ label, state: callState, durationMs, outputHead }) => ({ label, callState, durationMs, outputHead })) : null, [
    { label: 'npm test', callState: 'failed', durationMs: 2_000, outputHead: '1 failing' },
    { label: 'Read a.ts', callState: 'done', durationMs: 300, outputHead: 'line one\nline two' },
    { label: 'Grep never answered', callState: 'stopped', durationMs: null, outputHead: null },
  ]);
  assert.deepEqual({ failedCount: endedTurn.failedCount, thoughtText: endedTurn.thoughtText }, { failedCount: 1, thoughtText: 'thought 2s' });
});
