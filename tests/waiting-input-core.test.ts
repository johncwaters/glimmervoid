import test from 'node:test';
import assert from 'node:assert/strict';

import { decideWaitingInput, isTerminalReportOnly } from '../session/core/waiting-input-core.ts';
import type { WaitingInputContext } from '../session/core/waiting-input-core.ts';
import { STATES } from '../shared/states.ts';

const SGR_WHEEL_UP = '\x1b[<64;40;12M';
const SGR_RELEASE = '\x1b[<0;40;12m';
const X10_CLICK = '\x1b[M !!';
const URXVT_CLICK = '\x1b[32;40;12M';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const ARROW_DOWN = '\x1b[B';
const ESCAPE = '\x1b';

function claudeCodeAtQuestion(input: string, overrides: Partial<WaitingInputContext> = {}): WaitingInputContext {
  return { state: STATES.WAITING, hasHookAwaitingInput: true, pendingPromptKind: 'permission', isQuestionPrompt: true, input, ...overrides };
}

function claudeCodeAtToolPermission(input: string, overrides: Partial<WaitingInputContext> = {}): WaitingInputContext {
  return claudeCodeAtQuestion(input, { isQuestionPrompt: false, ...overrides });
}

function titleOnlyAgentWaiting(input: string): WaitingInputContext {
  return { state: STATES.WAITING, hasHookAwaitingInput: false, pendingPromptKind: null, isQuestionPrompt: false, input };
}

test('mouse and focus reports are terminal reports, keystrokes are not', () => {
  for (const report of [SGR_WHEEL_UP, SGR_RELEASE, X10_CLICK, URXVT_CLICK, FOCUS_IN, FOCUS_OUT, `${SGR_WHEEL_UP}${SGR_WHEEL_UP}${FOCUS_OUT}`]) {
    assert.equal(isTerminalReportOnly(report), true, JSON.stringify(report));
  }
  for (const keystroke of [ARROW_DOWN, ' ', '\r', 'y', `${SGR_WHEEL_UP}\r`]) {
    assert.equal(isTerminalReportOnly(keystroke), false, JSON.stringify(keystroke));
  }
});

test('a touch scroll mouse report never ends WAITING or counts as an answer, for any adapter', () => {
  assert.equal(decideWaitingInput(claudeCodeAtQuestion(SGR_WHEEL_UP)), 'ignore');
  assert.equal(decideWaitingInput(titleOnlyAgentWaiting(SGR_WHEEL_UP)), 'ignore');
  assert.equal(decideWaitingInput(titleOnlyAgentWaiting(X10_CLICK)), 'ignore');
});

test('a focus report never ends WAITING or counts as an answer, for any adapter', () => {
  assert.equal(decideWaitingInput(claudeCodeAtQuestion(FOCUS_IN)), 'ignore');
  assert.equal(decideWaitingInput(titleOnlyAgentWaiting(FOCUS_OUT)), 'ignore');
});

test('arrow, space and Enter at an AskUserQuestion prompt acknowledge without ending WAITING', () => {
  for (const keystroke of [ARROW_DOWN, ' ', '\r']) {
    assert.equal(decideWaitingInput(claudeCodeAtQuestion(keystroke)), 'acknowledge', JSON.stringify(keystroke));
  }
});

test('arrow keys at any hook-raised prompt acknowledge without ending WAITING', () => {
  for (const pendingPromptKind of ['permission', 'plan', 'elicitation']) {
    assert.equal(decideWaitingInput(claudeCodeAtToolPermission(ARROW_DOWN, { pendingPromptKind })), 'acknowledge', pendingPromptKind);
    assert.equal(decideWaitingInput(claudeCodeAtQuestion(ARROW_DOWN, { pendingPromptKind })), 'acknowledge', pendingPromptKind);
  }
});

test('a lone Escape ends WAITING at a tool permission and at an AskUserQuestion prompt', () => {
  assert.equal(decideWaitingInput(claudeCodeAtToolPermission(ESCAPE)), 'end-waiting');
  assert.equal(decideWaitingInput(claudeCodeAtQuestion(ESCAPE)), 'end-waiting');
  assert.equal(decideWaitingInput(claudeCodeAtToolPermission(ESCAPE, { pendingPromptKind: 'plan' })), 'end-waiting');
});

test('Enter ends WAITING at a tool permission, plan or elicitation prompt', () => {
  for (const pendingPromptKind of ['permission', 'plan', 'elicitation']) {
    assert.equal(decideWaitingInput(claudeCodeAtToolPermission('\r', { pendingPromptKind })), 'end-waiting', pendingPromptKind);
    assert.equal(decideWaitingInput(claudeCodeAtToolPermission(`${ARROW_DOWN}\r`, { pendingPromptKind })), 'end-waiting', pendingPromptKind);
  }
});

test('an option digit shortcut ends WAITING at a tool permission or plan prompt', () => {
  for (const pendingPromptKind of ['permission', 'plan']) {
    for (const digit of ['1', '3', '9']) {
      assert.equal(decideWaitingInput(claudeCodeAtToolPermission(digit, { pendingPromptKind })), 'end-waiting', `${pendingPromptKind} ${digit}`);
    }
  }
});

test('an option digit at an AskUserQuestion prompt acknowledges without ending WAITING', () => {
  for (const digit of ['1', '3', '9']) {
    assert.equal(decideWaitingInput(claudeCodeAtQuestion(digit)), 'acknowledge', digit);
  }
});

test('zero and multi-character text at a tool permission prompt acknowledge without ending WAITING', () => {
  for (const keystroke of ['0', '12', 'no', 'y']) {
    assert.equal(decideWaitingInput(claudeCodeAtToolPermission(keystroke)), 'acknowledge', JSON.stringify(keystroke));
  }
});

test('a keystroke on a title-only agent ends WAITING as before', () => {
  for (const keystroke of [ARROW_DOWN, ' ', '\r']) {
    assert.equal(decideWaitingInput(titleOnlyAgentWaiting(keystroke)), 'end-waiting', JSON.stringify(keystroke));
  }
});

test('a hook adapter WAITING on something no hook raised keeps ending WAITING on a keystroke', () => {
  assert.equal(decideWaitingInput(claudeCodeAtQuestion('\r', { pendingPromptKind: null })), 'end-waiting');
  assert.equal(decideWaitingInput(claudeCodeAtQuestion('\r', { pendingPromptKind: 'agent' })), 'end-waiting');
});

test('input outside WAITING is never a waiting decision', () => {
  for (const state of [STATES.RUNNING, STATES.IDLE, STATES.COMPLETE]) {
    assert.equal(decideWaitingInput(claudeCodeAtQuestion('\r', { state })), 'ignore');
    assert.equal(decideWaitingInput({ ...titleOnlyAgentWaiting('\r'), state }), 'ignore');
  }
});
