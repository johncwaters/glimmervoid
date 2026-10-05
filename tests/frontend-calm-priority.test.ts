import test from 'node:test';
import assert from 'node:assert/strict';
import { ARMED_ADVANCE_LIFETIME_MS, canReplyToFinishedSession, countByTier, decideArmedAdvance, formatWaitTime, isSamePermissionPrompt, latestAgentMessageText, offersNextInstructionInput, offersReplyInput, orderCalmQueue, panelContextFor, pickComponent, pickNextQueueSessionId, pickNowPeek, pickSessionAfterSubmit, tierOf } from '../public/calm/calm-priority-core.ts';
import type { CalmRow, CalmTier, CalmComponent } from '../public/calm/calm-priority-core.ts';

const makeRow = (state: string, overrides: Partial<CalmRow> = {}): CalmRow => ({ id: state, name: state, state, ...overrides });

const tierCases: [string, CalmTier][] = [
  ['WAITING', 'now'], ['FAILED', 'next'], ['COMPLETE', 'later'],
  ['RUNNING', 'working'], ['IDLE', 'ready'], ['STARTING', 'working'],
  ['INITIALIZING', 'working'], ['DORMANT', 'resting'], ['DONE', 'resting'],
  ['UNKNOWN', 'resting'],
];

for (const [state, tier] of tierCases) {
  test(`tierOf maps ${state} to ${tier}`, () => {
    assert.equal(tierOf(makeRow(state)), tier);
  });
}

test('orderCalmQueue orders tiers before wait time, puts missing waits last and preserves ties', () => {
  const rows = [
    makeRow('COMPLETE', { stateSince: 0 }),
    makeRow('WAITING', { id: 'missing' }),
    makeRow('FAILED', { stateSince: 0 }),
    makeRow('WAITING', { id: 'newer', stateSince: 10 }),
    makeRow('WAITING', { id: 'oldest', stateSince: 0 }),
    makeRow('WAITING', { id: 'tie', stateSince: 10 }),
    makeRow('WAITING', { id: 'null', stateSince: null }),
    makeRow('RUNNING'), makeRow('IDLE', { id: 'dismissed', hasEndedTurn: true }), makeRow('IDLE'), makeRow('DONE'),
  ];
  const originalRows = [...rows];
  assert.deepEqual(orderCalmQueue(rows).map((row) => row.id),
    ['oldest', 'newer', 'tie', 'missing', 'null', 'FAILED', 'COMPLETE', 'dismissed']);
  assert.deepEqual(rows, originalRows);
  assert.deepEqual(orderCalmQueue([]), []);
});

test('tierOf puts every ended turn on the later ring, dismissed or not', () => {
  assert.equal(tierOf(makeRow('IDLE', { hasEndedTurn: true })), 'later');
  assert.equal(tierOf(makeRow('IDLE', { hasEndedTurn: false })), 'ready');
  for (const hasEndedTurn of [true, false, undefined]) {
    assert.equal(tierOf(makeRow('COMPLETE', { hasEndedTurn })), 'later', String(hasEndedTurn));
  }
  for (const [state, tier] of tierCases) {
    if (state === 'IDLE') continue;
    assert.equal(tierOf(makeRow(state, { hasEndedTurn: true })), tier, state);
  }
});

test('countByTier counts each active tier and excludes resting sessions', () => {
  const rows = [...tierCases.map(([state]) => makeRow(state)), makeRow('IDLE', { id: 'dismissed', hasEndedTurn: true })];
  assert.deepEqual(countByTier(rows), { now: 1, next: 1, later: 2, ready: 1, working: 3 });
  assert.deepEqual(countByTier([]), { now: 0, next: 0, later: 0, ready: 0, working: 0 });
});

for (const state of ['WAITING', 'FAILED', 'COMPLETE']) {
  test(`orderCalmQueue sorts ${state} by wait and preserves missing and equal wait order`, () => {
    const rows = [
      makeRow(state, { id: 'missing' }),
      makeRow(state, { id: 'newer', stateSince: 20 }),
      makeRow(state, { id: 'older', stateSince: 10 }),
      makeRow(state, { id: 'equal', stateSince: 20 }),
      makeRow(state, { id: 'null', stateSince: null }),
    ];
    assert.deepEqual(orderCalmQueue(rows).map((row) => row.id), ['older', 'newer', 'equal', 'missing', 'null']);
  });
}

const QUESTION = { text: 'Which database?', options: ['Postgres', 'SQLite'], multiSelect: false };
const questionDetail = (question: typeof QUESTION | null) => ({ toolName: 'AskUserQuestion', summary: '', isComplete: false, question });

const componentCases: [string, CalmRow, CalmComponent, boolean][] = [
  ['answerable question', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code', pendingPromptDetail: questionDetail(QUESTION) }), 'question', false],
  ['multiSelect question', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code',
    pendingPromptDetail: questionDetail({ ...QUESTION, multiSelect: true }) }), 'terminal', false],
  ['unanswerable question', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code', pendingPromptDetail: questionDetail(null) }), 'terminal', false],
  ['question without a question field', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code',
    pendingPromptDetail: { toolName: 'AskUserQuestion', summary: '', isComplete: true } }), 'terminal', false],
  ['other agent question', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'codex', pendingPromptDetail: questionDetail(QUESTION) }), 'terminal', false],
  ['question on a plan prompt', makeRow('WAITING', { pendingPromptKind: 'plan', agent: 'claude-code', pendingPromptDetail: questionDetail(QUESTION) }), 'plan', false],
  ['question on an elicitation', makeRow('WAITING', { pendingPromptKind: 'elicitation', agent: 'claude-code', pendingPromptDetail: questionDetail(QUESTION) }), 'terminal', false],
  ['plan', makeRow('WAITING', { pendingPromptKind: 'plan' }), 'plan', false],
  ['complete permission', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code',
    pendingPromptDetail: { toolName: 'Bash', summary: 'Run tests', isComplete: true } }), 'permission', true],
  ['incomplete permission', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code',
    pendingPromptDetail: { toolName: 'Bash', summary: 'Run tests', isComplete: false } }), 'permission', false],
  ['missing permission detail', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code' }), 'permission', false],
  ['null permission detail', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'claude-code', pendingPromptDetail: null }), 'permission', false],
  ['other agent permission', makeRow('WAITING', { pendingPromptKind: 'permission', agent: 'codex',
    pendingPromptDetail: { toolName: 'Bash', summary: 'Run tests', isComplete: true } }), 'terminal', false],
  ['missing agent permission', makeRow('WAITING', { pendingPromptKind: 'permission', agent: null }), 'terminal', false],
  ['other prompt', makeRow('WAITING', { pendingPromptKind: 'question', agent: 'claude-code' }), 'terminal', false],
  ['null prompt', makeRow('WAITING', { pendingPromptKind: null }), 'terminal', false],
  ['missing prompt', makeRow('WAITING'), 'terminal', false],
  ['failure', makeRow('FAILED', { pendingPromptKind: 'plan' }), 'failure', false],
  ['completion', makeRow('COMPLETE'), 'review', false],
  ['dismissed completion', makeRow('IDLE', { hasEndedTurn: true }), 'review', false],
  ['idle without a task', makeRow('IDLE'), 'terminal', false],
  ['running permission', makeRow('RUNNING', { pendingPromptKind: 'permission', agent: 'claude-code',
    pendingPromptDetail: { toolName: 'Bash', summary: 'Run tests', isComplete: true } }), 'terminal', false],
  ['unknown state', makeRow('UNKNOWN'), 'terminal', false],
];

for (const [description, row, component, canApprove] of componentCases) {
  test(`pickComponent selects the panel and approval capability for ${description}`, () => {
    assert.deepEqual(pickComponent(row), { component, canApprove });
  });
}

const componentsAllowedByTier: Record<CalmTier, readonly CalmComponent[]> = {
  now: ['plan', 'permission', 'question', 'terminal'],
  next: ['failure'],
  later: ['review'],
  ready: ['terminal'],
  working: ['terminal'],
  resting: ['terminal'],
};

test('pickComponent chooses a component consistent with the tier of every row', () => {
  const rows = [...tierCases.map(([state]) => makeRow(state)), ...componentCases.map(([, row]) => row)];
  const tiersSeen = new Set<CalmTier>();
  for (const row of rows) {
    const tier = tierOf(row);
    tiersSeen.add(tier);
    assert.ok(componentsAllowedByTier[tier].includes(pickComponent(row).component), `${row.state} in tier ${tier}`);
  }
  assert.deepEqual([...tiersSeen].sort(), Object.keys(componentsAllowedByTier).sort());
});

test('isSamePermissionPrompt only matches the identical pending permission while waiting', () => {
  const shown = { toolName: 'Bash', summary: 'npm test', isComplete: true };
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', { ...shown }, shown), true);
  assert.equal(isSamePermissionPrompt('RUNNING', 'permission', { ...shown }, shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'plan', { ...shown }, shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', { ...shown, summary: 'rm -rf dist' }, shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', { ...shown, isComplete: false }, shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', null, shown), false);
});

test('isSamePermissionPrompt treats a different, reordered or vanished question as a different prompt', () => {
  const shown = questionDetail(QUESTION);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail({ ...QUESTION, options: [...QUESTION.options] }), shown), true);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail({ ...QUESTION, text: 'Which cache?' }), shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail({ ...QUESTION, options: ['SQLite', 'Postgres'] }), shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail({ ...QUESTION, options: ['Postgres'] }), shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail({ ...QUESTION, multiSelect: true }), shown), false);
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', questionDetail(null), shown), false);
  assert.equal(isSamePermissionPrompt('RUNNING', 'permission', questionDetail(QUESTION), shown), false);
});

test('isSamePermissionPrompt treats a missing and a null question alike', () => {
  const withoutQuestion = { toolName: 'Bash', summary: 'npm test', isComplete: true };
  assert.equal(isSamePermissionPrompt('WAITING', 'permission', { ...withoutQuestion, question: null }, withoutQuestion), true);
});

test('canReplyToFinishedSession allows a reply only to a COMPLETE or IDLE session with no prompt pending', () => {
  assert.equal(canReplyToFinishedSession('COMPLETE', null), true);
  assert.equal(canReplyToFinishedSession('IDLE', null), true);
  assert.equal(canReplyToFinishedSession('COMPLETE', undefined), true);
  assert.equal(canReplyToFinishedSession('COMPLETE', 'permission'), false);
  assert.equal(canReplyToFinishedSession('IDLE', 'elicitation'), false);
  for (const busyState of ['RUNNING', 'WAITING', 'STARTING', 'INITIALIZING', 'FAILED', 'DONE', 'DORMANT']) {
    assert.equal(canReplyToFinishedSession(busyState, null), false, busyState);
  }
});

test('offersReplyInput is true only for an agent with permission keys', () => {
  assert.equal(offersReplyInput({ agent: 'claude-code' }), true);
  assert.equal(offersReplyInput({ agent: 'codex' }), false);
  assert.equal(offersReplyInput({ agent: undefined }), false);
});

test('offersNextInstructionInput is true for an idle session of a keyed agent that has no task yet', () => {
  assert.equal(offersNextInstructionInput(makeRow('IDLE', { agent: 'claude-code' })), true);
  assert.equal(offersNextInstructionInput(makeRow('IDLE', { agent: 'claude-code', hasEndedTurn: false })), true);
});

test('offersNextInstructionInput is false for busy, ended-turn or unkeyed agent sessions', () => {
  assert.equal(offersNextInstructionInput(makeRow('COMPLETE', { agent: 'claude-code' })), false);
  assert.equal(offersNextInstructionInput(makeRow('IDLE', { agent: 'claude-code', hasEndedTurn: true })), false);
  assert.equal(offersNextInstructionInput(makeRow('RUNNING', { agent: 'claude-code' })), false);
  assert.equal(offersNextInstructionInput(makeRow('STARTING', { agent: 'claude-code' })), false);
  assert.equal(offersNextInstructionInput(makeRow('IDLE', { agent: 'codex' })), false);
  assert.equal(offersNextInstructionInput(makeRow('IDLE', { agent: undefined })), false);
});

const queueRows = (): CalmRow[] => [
  makeRow('RUNNING', { id: 'working' }),
  makeRow('COMPLETE', { id: 'finished', stateSince: 0 }),
  makeRow('WAITING', { id: 'newer', stateSince: 30 }),
  makeRow('FAILED', { id: 'failed', stateSince: 5 }),
  makeRow('WAITING', { id: 'oldest', stateSince: 10 }),
];

test('pickNowPeek picks the longest waiting NOW session other than the focused one', () => {
  assert.equal(pickNowPeek(queueRows(), null)?.id, 'oldest');
  assert.equal(pickNowPeek(queueRows(), 'working')?.id, 'oldest');
  assert.equal(pickNowPeek(queueRows(), 'oldest')?.id, 'newer');
});

test('pickNowPeek shows nothing when the focused session is the only one waiting', () => {
  assert.equal(pickNowPeek([makeRow('WAITING', { id: 'only' }), makeRow('FAILED')], 'only'), null);
  assert.equal(pickNowPeek([makeRow('FAILED'), makeRow('COMPLETE')], null), null);
  assert.equal(pickNowPeek([], null), null);
});

test('pickNextQueueSessionId walks the calm queue in order and wraps around', () => {
  assert.equal(pickNextQueueSessionId(queueRows(), null), 'oldest');
  assert.equal(pickNextQueueSessionId(queueRows(), 'oldest'), 'newer');
  assert.equal(pickNextQueueSessionId(queueRows(), 'newer'), 'failed');
  assert.equal(pickNextQueueSessionId(queueRows(), 'failed'), 'finished');
  assert.equal(pickNextQueueSessionId(queueRows(), 'finished'), 'oldest');
});

test('pickNextQueueSessionId starts over from an id that left the queue and is empty without a queue', () => {
  assert.equal(pickNextQueueSessionId(queueRows(), 'working'), 'oldest');
  assert.equal(pickNextQueueSessionId(queueRows(), 'gone'), 'oldest');
  assert.equal(pickNextQueueSessionId([makeRow('RUNNING')], null), null);
});

test('pickSessionAfterSubmit advances to the next waiting session when the reply came from the queued terminal', () => {
  assert.equal(pickSessionAfterSubmit('oldest', 'oldest', queueRows()), 'newer');
  assert.equal(pickSessionAfterSubmit('newer', 'newer', queueRows()), 'oldest');
});

test('pickSessionAfterSubmit stays put when the terminal was not opened from the queue', () => {
  assert.equal(pickSessionAfterSubmit('oldest', null, queueRows()), null);
  assert.equal(pickSessionAfterSubmit('oldest', 'newer', queueRows()), null);
});

test('pickSessionAfterSubmit stays put when no other session is waiting', () => {
  const rows = [makeRow('WAITING', { id: 'only' }), makeRow('FAILED'), makeRow('COMPLETE')];
  assert.equal(pickSessionAfterSubmit('only', 'only', rows), null);
});

const armedAtWaitingPrompt = { sessionId: 'oldest', armedAtMs: 1000, armedStateSince: 500, armedPromptSummary: 'rm -rf build' };

function armedSession(state: string, stateSince: number, pendingPromptSummary?: string) {
  return { state, stateSince, pendingPromptSummary };
}

test('decideArmedAdvance fires once the armed session transitions to RUNNING', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('RUNNING', 1200), 1300, false), 'fire');
});

test('decideArmedAdvance keeps waiting while the armed session has not transitioned', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('WAITING', 500, 'rm -rf build'), 1300, false), 'keep');
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('WAITING', 500), 1300, false), 'keep');
});

test('decideArmedAdvance never fires on a session that was already RUNNING when armed', () => {
  assert.equal(decideArmedAdvance({ ...armedAtWaitingPrompt, armedStateSince: 900 }, armedSession('RUNNING', 900), 1300, false), 'keep');
});

test('decideArmedAdvance cancels when other input arrived after arming', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('RUNNING', 1200), 1300, true), 'cancel');
});

test('decideArmedAdvance cancels once the armed window has elapsed', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('WAITING', 500, 'rm -rf build'), 1000 + ARMED_ADVANCE_LIFETIME_MS, false), 'cancel');
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('RUNNING', 1200), 1000 + ARMED_ADVANCE_LIFETIME_MS, false), 'cancel');
});

test('decideArmedAdvance cancels when the session waits on a different prompt', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('WAITING', 500, 'npm publish'), 1300, false), 'cancel');
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('WAITING', 1200, 'npm publish'), 1300, false), 'cancel');
});

test('decideArmedAdvance cancels when the session transitions anywhere but RUNNING', () => {
  assert.equal(decideArmedAdvance({ ...armedAtWaitingPrompt, armedPromptSummary: undefined }, armedSession('WAITING', 1200), 1300, false), 'cancel');
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, armedSession('FAILED', 1200), 1300, false), 'cancel');
});

test('decideArmedAdvance cancels when the armed session is gone', () => {
  assert.equal(decideArmedAdvance(armedAtWaitingPrompt, null, 1300, false), 'cancel');
});

test('formatWaitTime rounds down to whole minutes and hours', () => {
  const minute = 60000;
  assert.equal(formatWaitTime(-5), '<1m');
  assert.equal(formatWaitTime(59999), '<1m');
  assert.equal(formatWaitTime(minute), '1m');
  assert.equal(formatWaitTime(59 * minute + 59999), '59m');
  assert.equal(formatWaitTime(60 * minute), '1h');
  assert.equal(formatWaitTime(125 * minute), '2h 5m');
});

const terminalContextCases: [string, string][] = [
  ['RUNNING', 'is working'], ['STARTING', 'is working'], ['INITIALIZING', 'is working'],
  ['IDLE', 'has no task'], ['DONE', 'has exited'], ['DORMANT', 'is asleep'],
  ['COMPLETE', 'is quiet'], ['WAITING', 'needs you'], ['UNKNOWN', 'is quiet'],
];

for (const [state, context] of terminalContextCases) {
  test(`panelContextFor describes a ${state} terminal panel as ${context}`, () => {
    assert.equal(panelContextFor(makeRow(state), 'terminal'), context);
  });
}

test('panelContextFor names the prompt, failure or review for non-terminal panels', () => {
  assert.equal(panelContextFor(makeRow('WAITING'), 'permission'), 'wants to run');
  assert.equal(panelContextFor(makeRow('WAITING'), 'question'), 'asks');
  assert.equal(panelContextFor(makeRow('WAITING'), 'plan'), 'has a plan ready');
  assert.equal(panelContextFor(makeRow('FAILED'), 'failure'), 'failed');
  assert.equal(panelContextFor(makeRow('COMPLETE'), 'review'), 'waits for you');
  assert.equal(panelContextFor(makeRow('IDLE', { hasEndedTurn: true }), 'review'), 'waits for you');
});

test('latestAgentMessageText returns the newest top-level assistant message in full', () => {
  const base = { ts: 0, uuid: null, parentUuid: null, vendorSessionId: 'vendor' };
  const longText = `First line of the reply.\n${'Pick option A or B. '.repeat(20)}`;
  assert.equal(latestAgentMessageText([
    { ...base, kind: 'assistant', text: 'older reply' },
    { ...base, kind: 'assistant', text: `  ${longText}  ` },
    { ...base, kind: 'assistant', text: 'subagent chatter', agentType: 'Explore' },
    { ...base, kind: 'assistant', text: 'untyped subagent chatter', agentId: 'agent-1' },
    { ...base, kind: 'assistant', text: '   ' },
    { ...base, kind: 'tool_call', toolUseId: 'tool', name: 'Bash', input: {} },
  ]), longText.trim());
  assert.equal(latestAgentMessageText([{ ...base, kind: 'prompt', text: 'hello' }]), null);
  assert.equal(latestAgentMessageText([{ ...base, kind: 'assistant', text: 'subagent only', agentId: 'agent-1' }]), null);
  assert.equal(latestAgentMessageText([]), null);
});
