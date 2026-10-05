import test from 'node:test';
import assert from 'node:assert/strict';
import { pickComponent } from '../public/calm/calm-priority-core.ts';
import {
  answerWithOptionKeystrokes,
  answerWithTextKeystrokes,
  approveKeystrokes,
  decideInstructionDelivery,
  hasPermissionKeys,
  INSTRUCTION_WAIT_TIMEOUT_MS,
  isAnyPromptShowing,
  rejectAndInstructKeystrokes,
  replyKeystrokes,
} from '../public/calm/permission-keys-core.ts';

const ESCAPE = String.fromCharCode(27);

test('claude-code approves a permission prompt with a single carriage return', () => {
  assert.deepEqual(approveKeystrokes('claude-code'), [{ data: '\r' }]);
  assert.equal(hasPermissionKeys('claude-code'), true);
});

test('claude-code rejects with escape, then types the instruction and submits it after a pause', () => {
  assert.deepEqual(rejectAndInstructKeystrokes('claude-code', 'run the linter first'), {
    dismissPrompt: [{ data: ESCAPE }],
    instruct: [{ data: 'run the linter first', delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: 800 }],
  });
});

for (const agent of ['codex', 'grok', 'custom', 'constructor', '__proto__', '', null, undefined]) {
  test(`agent ${String(agent)} has no permission keystroke plan`, () => {
    assert.equal(hasPermissionKeys(agent), false);
    assert.equal(approveKeystrokes(agent), null);
    assert.equal(rejectAndInstructKeystrokes(agent, 'anything'), null);
    assert.equal(answerWithOptionKeystrokes(agent, 0, 2, false), null);
    assert.equal(answerWithTextKeystrokes(agent, 2, 'anything', false), null);
    assert.equal(replyKeystrokes(agent, 'anything'), null);
  });
}

test('claude-code answers a question option with the single digit of its one-based position', () => {
  assert.deepEqual(answerWithOptionKeystrokes('claude-code', 0, 2, false), [{ data: '1' }]);
  assert.deepEqual(answerWithOptionKeystrokes('claude-code', 1, 2, false), [{ data: '2' }]);
  assert.deepEqual(answerWithOptionKeystrokes('claude-code', 7, 8, false), [{ data: '8' }]);
});

test('answerWithOptionKeystrokes refuses multiSelect, more than eight options and an index outside the options', () => {
  assert.equal(answerWithOptionKeystrokes('claude-code', 0, 2, true), null);
  assert.equal(answerWithOptionKeystrokes('claude-code', 0, 9, false), null);
  assert.equal(answerWithOptionKeystrokes('claude-code', 0, 0, false), null);
  assert.equal(answerWithOptionKeystrokes('claude-code', 2, 2, false), null);
  assert.equal(answerWithOptionKeystrokes('claude-code', -1, 2, false), null);
  assert.equal(answerWithOptionKeystrokes('claude-code', 0.5, 2, false), null);
});

test('claude-code types an answer by picking the type-something row, then typing and submitting after pauses', () => {
  assert.deepEqual(answerWithTextKeystrokes('claude-code', 2, 'use DuckDB', false), [
    { data: '3', delayBeforeMs: 0 },
    { data: 'use DuckDB', delayBeforeMs: 800 },
    { data: '\r', delayBeforeMs: 800 },
  ]);
  assert.deepEqual(answerWithTextKeystrokes('claude-code', 8, 'other', false)?.[0], { data: '9', delayBeforeMs: 0 });
});

test('answerWithTextKeystrokes refuses multiSelect, empty text and more than eight options', () => {
  assert.equal(answerWithTextKeystrokes('claude-code', 2, 'use DuckDB', true), null);
  assert.equal(answerWithTextKeystrokes('claude-code', 2, '', false), null);
  assert.equal(answerWithTextKeystrokes('claude-code', 2, '   ', false), null);
  assert.equal(answerWithTextKeystrokes('claude-code', 9, 'use DuckDB', false), null);
  assert.equal(answerWithTextKeystrokes('claude-code', 0, 'use DuckDB', false), null);
});

test('claude-code replies to a finished session by typing the instruction and submitting it after a short pause', () => {
  assert.deepEqual(replyKeystrokes('claude-code', 'now add tests'), [{ data: 'now add tests', delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: 300 }]);
});

test('replyKeystrokes refuses empty text', () => {
  assert.equal(replyKeystrokes('claude-code', ''), null);
  assert.equal(replyKeystrokes('claude-code', ' \t '), null);
});

for (const agent of ['claude-code', 'codex', 'grok', null]) {
  test(`pickComponent offers the permission panel for ${String(agent)} only when the keystroke table has an entry`, () => {
    const choice = pickComponent({
      id: 'session', name: 'session', state: 'WAITING', agent, pendingPromptKind: 'permission',
      pendingPromptDetail: { toolName: 'Bash', summary: 'npm test', isComplete: true },
    });
    const hasKeys = approveKeystrokes(agent) !== null;
    assert.equal(choice.component === 'permission', hasKeys);
    assert.equal(choice.canApprove, hasKeys);
  });
}

test('isAnyPromptShowing only holds while waiting on a named prompt', () => {
  assert.equal(isAnyPromptShowing('WAITING', 'permission'), true);
  assert.equal(isAnyPromptShowing('WAITING', 'question'), true);
  assert.equal(isAnyPromptShowing('WAITING', null), false);
  assert.equal(isAnyPromptShowing('WAITING', ''), false);
  assert.equal(isAnyPromptShowing('RUNNING', 'permission'), false);
});

test('decideInstructionDelivery keeps waiting while the permission prompt is still showing', () => {
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'permission', elapsedMs: 0 }), 'wait');
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'permission', elapsedMs: INSTRUCTION_WAIT_TIMEOUT_MS - 1 }), 'wait');
});

test('decideInstructionDelivery gives up once the wait times out with a prompt still showing', () => {
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'permission', elapsedMs: INSTRUCTION_WAIT_TIMEOUT_MS }), 'give-up');
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'question', elapsedMs: INSTRUCTION_WAIT_TIMEOUT_MS }), 'give-up');
});

test('decideInstructionDelivery never types into a different dialog that replaced the permission prompt', () => {
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'question', elapsedMs: 0 }), 'wait');
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: 'plan', elapsedMs: 0 }), 'wait');
});

test('decideInstructionDelivery sends once the session leaves the prompt', () => {
  assert.equal(decideInstructionDelivery({ currentState: 'RUNNING', pendingPromptKind: 'permission', elapsedMs: 0 }), 'send');
  assert.equal(decideInstructionDelivery({ currentState: 'IDLE', pendingPromptKind: null, elapsedMs: INSTRUCTION_WAIT_TIMEOUT_MS }), 'send');
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: null, elapsedMs: 0 }), 'send');
  assert.equal(decideInstructionDelivery({ currentState: 'WAITING', pendingPromptKind: undefined, elapsedMs: 0 }), 'send');
});
