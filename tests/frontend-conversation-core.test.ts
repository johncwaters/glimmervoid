import test from 'node:test';
import assert from 'node:assert/strict';

import type { TraceRecord } from '../shared/contracts/trace.ts';
import { conversationEntries, runningAgentRuns } from '../public/conversation/conversation-core.ts';

const base = { uuid: null, parentUuid: null, vendorSessionId: 'vendor-session' };

function backgroundAgentLaunch(toolUseId: string, ts: number): TraceRecord[] {
  return [
    { ...base, ts, kind: 'tool_call', toolUseId, name: 'Agent', input: { description: 'Fix findings', run_in_background: true } },
    { ...base, ts: ts + 1, kind: 'tool_result', toolUseId, content: 'Async agent launched successfully.\nagentId: a9af4e88125ab644e', isError: false, truncated: false },
  ];
}

const taskNotificationTexts = {
  withToolUseId: '<task-notification>\n<task-id>a9af4e88125ab644e</task-id>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n</task-notification>',
  taskIdOnly: '<task-notification>\n<task-id>a9af4e88125ab644e</task-id>\n<status>completed</status>\n</task-notification>',
};

test('a background agent finishes on its task notice, even one an older server recorded as an operator prompt or one carrying only a task id', () => {
  for (const [noticeShape, noticeText] of Object.entries(taskNotificationTexts)) {
    for (const noticeKind of ['expansion', 'prompt'] as const) {
      const caseName = `${noticeShape} ${noticeKind}`;
      const records: TraceRecord[] = [
        { ...base, ts: 1, kind: 'prompt', text: 'fix it' },
        ...backgroundAgentLaunch('toolu_agent', 2),
        { ...base, ts: 10, kind: noticeKind, text: noticeText },
      ];
      const entries = conversationEntries(records);
      assert.deepEqual(runningAgentRuns(entries), [], caseName);
      assert.deepEqual(entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text), ['fix it'], caseName);
    }
  }
});
