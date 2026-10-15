import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFollowableThread,
  isNoRolloutError,
  parseListenUrl,
  pendingApprovalFromServerRequest,
  traceRecordsForItemEvent,
} from '../session/core/codex-app-server-core.ts';
import { TraceRecord } from '../shared/contracts/trace.ts';

const eventContext = { threadId: 'thread-1', turnId: 'turn-1', nowMs: 1234, alreadyStartedItemIds: new Set<string>() };
const commandItem = {
  type: 'commandExecution', id: 'command-1', pluginId: null, scriptPath: null,
  command: 'npm test', cwd: '/project', processId: '42', source: 'agent', status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null, durationMs: null,
};

test('command lifecycle emits one call and a capped failing result with trace identity', () => {
  const started = traceRecordsForItemEvent({ ...eventContext, phase: 'started', item: commandItem });
  assert.deepEqual(started.startedItemIds, ['command-1']);
  assert.deepEqual(started.records, [{
    ts: 1234, uuid: 'command-1', parentUuid: 'turn-1', vendorSessionId: 'thread-1',
    kind: 'tool_call', toolUseId: 'command-1', name: 'Bash', input: { command: 'npm test', cwd: '/project' },
  }]);
  const completed = traceRecordsForItemEvent({
    ...eventContext, phase: 'completed', alreadyStartedItemIds: new Set(started.startedItemIds),
    item: { ...commandItem, status: 'completed', aggregatedOutput: 'x'.repeat(65537), exitCode: 1, durationMs: 250 },
  });
  assert.equal(completed.records.length, 1);
  const record = completed.records[0];
  assert.ok(record?.kind === 'tool_result');
  assert.equal(record.content.length, 65536);
  assert.equal(record.isError, true);
  assert.equal(record.truncated, true);
  for (const trace of [...started.records, ...completed.records]) assert.equal(TraceRecord.safeParse(trace).success, true);
});

test('assistant text waits for completion and prompts join only text input parts', () => {
  const agentMessage = { type: 'agentMessage', id: 'answer-1', text: 'All checks passed.', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
  assert.deepEqual(traceRecordsForItemEvent({ ...eventContext, phase: 'started', item: agentMessage }).records, []);
  const answer = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: agentMessage });
  assert.equal(answer.records[0]?.kind, 'assistant');
  assert.ok(answer.records[0]?.kind === 'assistant');
  assert.equal(answer.records[0].text, 'All checks passed.');
  const prompt = traceRecordsForItemEvent({ ...eventContext, phase: 'started', item: {
    type: 'userMessage', id: 'prompt-1', clientId: null,
    content: [{ type: 'text', text: 'Inspect this', text_elements: [] }, { type: 'localImage', path: '/image.png' }, { type: 'text', text: 'and fix it.', text_elements: [] }],
  } });
  assert.ok(prompt.records[0]?.kind === 'prompt');
  assert.equal(prompt.records[0].text, 'Inspect this\nand fix it.');
  const thinking = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: { type: 'reasoning', id: 'thought-1', summary: ['Inspect the tests'], content: ['Then run them'] } });
  assert.ok(thinking.records[0]?.kind === 'thinking');
  assert.equal(thinking.records[0].text, 'Inspect the tests\nThen run them');
  assert.deepEqual(traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: { type: 'reasoning', id: 'empty', summary: [], content: [] } }).records, []);
});

test('file changes keep diffs out of call inputs and return unified diffs on completion', () => {
  const changes = [{ path: '/project/app.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }];
  const item = { type: 'fileChange', id: 'edit-1', changes, status: 'completed' };
  const hydrated = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item });
  assert.equal(hydrated.records.length, 2);
  assert.ok(hydrated.records[0]?.kind === 'tool_call');
  assert.equal(hydrated.records[0].name, 'Edit');
  assert.deepEqual(hydrated.records[0].input, { changes: [{ path: '/project/app.ts', kind: { type: 'update', move_path: null } }] });
  assert.ok(hydrated.records[1]?.kind === 'tool_result');
  assert.equal(hydrated.records[1].content, changes[0]?.diff);
  assert.equal(hydrated.records[1].isError, false);
});

test('repeated starts and history hydration never duplicate tool calls', () => {
  const started = traceRecordsForItemEvent({ ...eventContext, phase: 'started', item: commandItem });
  const alreadyStartedItemIds = new Set(started.startedItemIds);
  assert.deepEqual(traceRecordsForItemEvent({ ...eventContext, alreadyStartedItemIds, phase: 'started', item: commandItem }), { records: [], startedItemIds: [] });
  const completedItem = { ...commandItem, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 };
  const hydrated = traceRecordsForItemEvent({ ...eventContext, alreadyStartedItemIds, phase: 'completed', item: completedItem });
  assert.deepEqual(hydrated.records.map((record) => record.kind), ['tool_result']);
  const freshHydration = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: completedItem });
  assert.deepEqual(freshHydration.records.map((record) => record.kind), ['tool_call', 'tool_result']);
  assert.deepEqual(freshHydration.startedItemIds, ['command-1']);
});

test('MCP and dynamic tools preserve arguments and normalize their text results', () => {
  const mcp = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: {
    type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: { query: 'protocol' }, status: 'completed',
    result: { content: [{ type: 'text', text: 'Found it' }], structuredContent: null, _meta: null }, error: null, durationMs: 1,
  } });
  assert.ok(mcp.records[0]?.kind === 'tool_call');
  assert.equal(mcp.records[0].name, 'mcp:docs/search');
  assert.deepEqual(mcp.records[0].input, { query: 'protocol' });
  assert.ok(mcp.records[1]?.kind === 'tool_result');
  assert.equal(mcp.records[1].content, 'Found it');
  const dynamic = traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item: {
    type: 'dynamicToolCall', id: 'dynamic-1', namespace: null, tool: 'lookup', arguments: { id: 2 }, status: 'failed',
    contentItems: [{ type: 'inputText', text: 'Unavailable' }], success: false, durationMs: 1,
  } });
  assert.ok(dynamic.records[1]?.kind === 'tool_result');
  assert.equal(dynamic.records[1].content, 'Unavailable');
  assert.equal(dynamic.records[1].isError, true);
});

test('approval parsing accepts only approval methods and bounds display summaries', () => {
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: `  ${'x'.repeat(400)}  `, cwd: '/project', reason: null };
  assert.deepEqual(pendingApprovalFromServerRequest('item/commandExecution/requestApproval', params, 7), { requestId: 7, kind: 'command', threadId: 'thread-1', summary: 'x'.repeat(300), isSummaryTruncated: true });
  assert.deepEqual(pendingApprovalFromServerRequest('item/fileChange/requestApproval', { threadId: 'thread-1', changes: [{ path: 'app.ts' }] }, 'edit'), { requestId: 'edit', kind: 'fileChange', threadId: 'thread-1', summary: 'app.ts', isSummaryTruncated: false });
  assert.equal(pendingApprovalFromServerRequest('item/fileChange/requestApproval', { threadId: 'thread-1', reason: 'Write app.ts', grantRoot: '/project' }, 8)?.summary, 'Write access to /project. Write app.ts');
  assert.deepEqual(pendingApprovalFromServerRequest('item/permissions/requestApproval', { threadId: 'thread-1', reason: 'Fetch deps', permissions: { network: { enabled: true }, fileSystem: { write: ['/cache'] } } }, 9), { requestId: 9, kind: 'permissions', threadId: 'thread-1', summary: 'Network access. File system write: /cache. Fetch deps', isSummaryTruncated: false });
  assert.equal(pendingApprovalFromServerRequest('item/permissions/requestApproval', { threadId: 'thread-1', reason: 'Fetch deps', permissions: { network: null, fileSystem: { write: { root: '/' } } } }, 9)?.isSummaryTruncated, true);
  assert.equal(pendingApprovalFromServerRequest('item/tool/requestUserInput', params, 7), null);
  assert.equal(pendingApprovalFromServerRequest('item/commandExecution/requestApproval', { threadId: 1 }, 7), null);
});

test('listen and thread guards reject unsafe or malformed wire payloads', () => {
  assert.equal(parseListenUrl('  listening on: ws://127.0.0.1:54321\r'), 'ws://127.0.0.1:54321');
  for (const url of ['ws://localhost:1234', 'ws://0.0.0.0:1234', 'wss://127.0.0.1:1234', 'ws://127.0.0.1:0', 'ws://127.0.0.1:65536', 'ws://127.0.0.1:1234/path']) assert.equal(parseListenUrl(`listening on: ${url}`), null);
  assert.equal(isFollowableThread({ id: 'thread-1', environments: [{ id: 'local' }] }), true);
  assert.equal(isFollowableThread({ id: 'helper', environments: [] }), false);
  assert.equal(isFollowableThread({ id: '', environments: [{}] }), false);
  assert.equal(isNoRolloutError({ code: -32600, message: 'no rollout found for thread' }), true);
  assert.equal(isNoRolloutError(new Error('Permission denied')), false);
  for (const item of [null, { type: 'futureItem', id: 'new' }, { ...commandItem, command: 42 }]) {
    assert.deepEqual(traceRecordsForItemEvent({ ...eventContext, phase: 'completed', item }), { records: [], startedItemIds: [] });
  }
  assert.deepEqual(traceRecordsForItemEvent({ ...eventContext, threadId: '', phase: 'started', item: commandItem }), { records: [], startedItemIds: [] });
});
