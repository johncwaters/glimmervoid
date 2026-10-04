import test from 'node:test';
import assert from 'node:assert/strict';
import { ARMED_ADVANCE_LIFETIME_MS, countByTier, decideArmedAdvance, formatWaitTime, isSamePermissionPrompt, orderCalmQueue, panelContextFor, pickComponent, pickNextQueueSessionId, pickNowPeek, pickSessionAfterSubmit, tierOf } from '../public/calm/calm-priority-core.ts';
import type { CalmRow, CalmTier, CalmComponent } from '../public/calm/calm-priority-core.ts';

const makeRow = (state: string, overrides: Partial<CalmRow> = {}): CalmRow => ({ id: state, name: state, state, ...overrides });

const tierCases: [string, boolean | undefined, CalmTier][] = [
  ['WAITING', false, 'now'], ['FAILED', false, 'next'], ['COMPLETE', true, 'later'],
  ['COMPLETE', false, 'resting'], ['COMPLETE', undefined, 'resting'],
  ['RUNNING', true, 'working'], ['IDLE', false, 'working'], ['STARTING', false, 'working'],
  ['INITIALIZING', false, 'working'], ['DORMANT', true, 'resting'], ['DONE', true, 'resting'],
  ['UNKNOWN', true, 'resting'],
];

for (const [state, unseen, tier] of tierCases) {
  test(`tierOf maps ${state} with unseen ${unseen} to ${tier}`, () => {
    assert.equal(tierOf(makeRow(state, { unseen })), tier);
  });
}

test('orderCalmQueue orders tiers before wait time, puts missing waits last and preserves ties', () => {
  const rows = [
    makeRow('COMPLETE', { unseen: true, stateSince: 0 }),
    makeRow('WAITING', { id: 'missing' }),
    makeRow('FAILED', { stateSince: 0 }),
    makeRow('WAITING', { id: 'newer', stateSince: 10 }),
    makeRow('WAITING', { id: 'oldest', stateSince: 0 }),
    makeRow('WAITING', { id: 'tie', stateSince: 10 }),
    makeRow('WAITING', { id: 'null', stateSince: null }),
    makeRow('RUNNING'), makeRow('COMPLETE', { id: 'seen' }), makeRow('DONE'),
  ];
  const originalRows = [...rows];
  assert.deepEqual(orderCalmQueue(rows).map((row) => row.id),
    ['oldest', 'newer', 'tie', 'missing', 'null', 'FAILED', 'COMPLETE']);
  assert.deepEqual(rows, originalRows);
  assert.deepEqual(orderCalmQueue([]), []);
});

test('countByTier counts each active tier and excludes resting sessions', () => {
  assert.deepEqual(countByTier(tierCases.map(([state, unseen]) => makeRow(state, { unseen }))),
    { now: 1, next: 1, later: 1, working: 4 });
  assert.deepEqual(countByTier([]), { now: 0, next: 0, later: 0, working: 0 });
});

for (const state of ['WAITING', 'FAILED', 'COMPLETE']) {
  test(`orderCalmQueue sorts ${state} by wait and preserves missing and equal wait order`, () => {
    const rows = [
      makeRow(state, { id: 'missing', unseen: true }),
      makeRow(state, { id: 'newer', unseen: true, stateSince: 20 }),
      makeRow(state, { id: 'older', unseen: true, stateSince: 10 }),
      makeRow(state, { id: 'equal', unseen: true, stateSince: 20 }),
      makeRow(state, { id: 'null', unseen: true, stateSince: null }),
    ];
    assert.deepEqual(orderCalmQueue(rows).map((row) => row.id), ['older', 'newer', 'equal', 'missing', 'null']);
  });
}

const componentCases: [string, CalmRow, CalmComponent, boolean][] = [
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
  ['unseen completion', makeRow('COMPLETE', { unseen: true }), 'review', false],
  ['seen completion', makeRow('COMPLETE', { unseen: false }), 'terminal', false],
  ['completion without unseen', makeRow('COMPLETE'), 'terminal', false],
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
  now: ['plan', 'permission', 'terminal'],
  next: ['failure'],
  later: ['review'],
  working: ['terminal'],
  resting: ['terminal'],
};

test('pickComponent chooses a component consistent with the tier of every row', () => {
  const rows = [...tierCases.map(([state, unseen]) => makeRow(state, { unseen })), ...componentCases.map(([, row]) => row)];
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

const queueRows = (): CalmRow[] => [
  makeRow('RUNNING', { id: 'working' }),
  makeRow('COMPLETE', { id: 'finished', unseen: true, stateSince: 0 }),
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
  assert.equal(pickNowPeek([makeRow('FAILED'), makeRow('COMPLETE', { unseen: true })], null), null);
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
  const rows = [makeRow('WAITING', { id: 'only' }), makeRow('FAILED'), makeRow('COMPLETE', { unseen: true })];
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
  ['IDLE', 'is idle'], ['DONE', 'has exited'], ['DORMANT', 'is asleep'],
  ['COMPLETE', 'finished'], ['WAITING', 'needs you'], ['UNKNOWN', 'is quiet'],
];

for (const [state, context] of terminalContextCases) {
  test(`panelContextFor describes a ${state} terminal panel as ${context}`, () => {
    assert.equal(panelContextFor(makeRow(state), 'terminal'), context);
  });
}

test('panelContextFor names the prompt, failure or review for non-terminal panels', () => {
  assert.equal(panelContextFor(makeRow('WAITING'), 'permission'), 'wants to run');
  assert.equal(panelContextFor(makeRow('WAITING'), 'plan'), 'has a plan ready');
  assert.equal(panelContextFor(makeRow('FAILED'), 'failure'), 'failed');
  assert.equal(panelContextFor(makeRow('COMPLETE', { unseen: true }), 'review'), 'finished');
});
