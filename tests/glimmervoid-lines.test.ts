import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWakeLine as describeChannelWakeLine, openChannel } from '../server/core/child-channel-core.ts';
import { appendChatRecords, createChatPartsState } from '../public/chat/chat-parts-core.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';

const RECORD_BASE = { uuid: null, parentUuid: null, vendorSessionId: 'vendor-session' } as const;

function chatKindsOf(records: readonly TraceRecord[]): { kind: string; label?: string }[] {
  return appendChatRecords(createChatPartsState(null), records).parts.map((part) => ({ kind: part.kind, ...(part.kind === 'system-line' ? { label: part.label } : {}) }));
}

test('every line the server types into an agent, and the parent line traces before siblings carry, shows in Chat as a system line', () => {
  const channel = openChannel({ kind: 'spawned', parentId: 'parent-1', childId: 'child-1', childName: 'Pack MCP' });
  const typedLines = [
    describeChannelWakeLine(channel, 'toParent'),
    describeChannelWakeLine(channel, 'toChild'),
    'Glimmervoid: the session that spawned you sent a message. Run glimmervoid read and act on it.',
  ];
  const records: TraceRecord[] = typedLines.map((text, index) => ({ ...RECORD_BASE, ts: index + 1, kind: 'prompt', text }));
  assert.deepEqual(chatKindsOf(records).map((part) => part.kind), ['system-line', 'system-line', 'system-line']);
});

test('an operator message quoting a task notification stays the operator message', () => {
  const records: TraceRecord[] = [
    { ...RECORD_BASE, ts: 1, kind: 'prompt', text: 'Chat shows <task-notification><summary>Build done</summary></task-notification> wrong' },
    { ...RECORD_BASE, ts: 2, kind: 'expansion', text: '<task-notification>\n<summary>Background command &quot;npm test &amp;&amp; echo ok&quot; completed</summary>\n</task-notification>' },
  ];
  assert.deepEqual(chatKindsOf(records), [{ kind: 'prompt' }, { kind: 'system-line', label: 'Background command "npm test && echo ok" completed' }]);
});
