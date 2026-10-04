import test from 'node:test';
import assert from 'node:assert/strict';
import { pickComponent } from '../public/calm/calm-priority-core.ts';
import {
  approveKeystrokes,
  decideInstructionDelivery,
  hasPermissionKeys,
  INSTRUCTION_WAIT_TIMEOUT_MS,
  isAnyPromptShowing,
  rejectAndInstructKeystrokes,
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
  });
}

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
