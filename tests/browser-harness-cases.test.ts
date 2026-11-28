import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCases } from '../harness/browser/cases-core.ts';
import { controlServerFrameDelayMs } from '../harness/browser/control-faults-core.ts';

test('selectCases reports unmatched --only names alongside real ones, including viewport mismatches and prove-failure gates', () => {
  const mixedUnknown = selectCases({
    only: ['board-session', 'chat-view', 'chat-page', 'chat-view'],
  });
  assert.deepEqual(mixedUnknown.unmatchedOnly, ['chat-view', 'chat-page']);
  assert.ok(mixedUnknown.cases.length > 0);

  const viewportMismatch = selectCases({
    only: ['phone-wake-prunes-removed', 'solid-island'],
    viewportNames: ['desktop-1280'],
  });
  assert.deepEqual(viewportMismatch.unmatchedOnly, ['phone-wake-prunes-removed']);

  const proveFailureWithoutFlag = selectCases({
    only: ['self-check-must-fail', 'solid-island'],
  });
  assert.deepEqual(proveFailureWithoutFlag.unmatchedOnly, ['self-check-must-fail']);

  const proveFailureWithFlag = selectCases({
    only: ['self-check-must-fail', 'solid-island'],
    proveFailure: true,
  });
  assert.deepEqual(proveFailureWithFlag.unmatchedOnly, []);
  assert.ok(proveFailureWithFlag.cases.some((harnessCase) => harnessCase.scenario.name === 'self-check-must-fail'));

  const validPair = selectCases({
    only: ['solid-island', 'confirm-dialog'],
  });
  assert.deepEqual(validPair.unmatchedOnly, []);
  assert.ok(validPair.cases.length > 0);
});

test('controlServerFrameDelayMs never delays heartbeat pong frames while still delaying action replies and collection pushes', () => {
  const c1Config = { replyDelayMs: 2000, pushDelayMs: 0 };
  assert.equal(controlServerFrameDelayMs({ type: 'pong', requestId: 'ping-1' }, c1Config), 0);
  assert.equal(controlServerFrameDelayMs({ type: 'pack-source-result', requestId: 'req-1', ok: true }, c1Config), 2000);

  const c5Config = { replyDelayMs: 0, pushDelayMs: 300 };
  assert.equal(controlServerFrameDelayMs({ type: 'pong', requestId: 'ping-2' }, c5Config), 0);
  assert.equal(controlServerFrameDelayMs({ type: 'packs-status', seq: 42 }, c5Config), 300);
  assert.equal(controlServerFrameDelayMs({ type: 'pack-source-result', requestId: 'req-2', ok: true }, c5Config), 0);
});
