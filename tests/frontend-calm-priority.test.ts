import test from 'node:test';
import assert from 'node:assert/strict';
import { countByTier, isSamePermissionPrompt, orderCalmQueue, pickComponent, tierOf } from '../public/calm/calm-priority-core.ts';
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
