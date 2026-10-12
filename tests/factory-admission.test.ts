import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkerPrompt, decideAdmission, exceedsRiskCeiling, isTransientAdmissionRefusal } from '../server/core/factory-core.ts';
import type { FactoryAdmissionInput, FactoryWorkOrder } from '../server/core/factory-core.ts';

function makeOrder(work: string, parent: string | null, writeScopes = ['src']): FactoryWorkOrder {
  return { work, state: 'open', readiness: 'ready', owner: { session: 'factory', agent: 'claude-code' }, last: null,
    opened: { at: '2026-10-08T12:00:00.000Z', objective: 'Add retries', criteria: ['Retries pass'], authority: { boundary: 'This repo' },
      risk: 'medium', parent, dependsOn: [], readScopes: [], writeScopes } };
}

const intent = makeOrder('wrk-0000000000000001', null);
const order = makeOrder('wrk-0000000000000002', intent.work, ['src/retry.ts']);
const baseline: FactoryAdmissionInput = { intent, order, trustedIntentIds: new Set([intent.work]), liveWorkers: [], todaySpend: { status: 'known', amountUsd: 10 }, dailyBudgetUsd: 10, filterDriverNames: [] };

const refusals: [string, Partial<FactoryAdmissionInput>, string][] = [
  ['missing ticket', { order: null }, 'does not exist'],
  ['active ticket', { order: { ...order, state: 'active' } }, 'not open'],
  ['blocked ticket', { order: { ...order, state: 'blocked' } }, 'not open'],
  ['waiting ticket', { order: { ...order, readiness: 'waiting' } }, 'not ready'],
  ['missing intent', { intent: null }, 'active intent'],
  ['wrong intent', { intent: { ...intent, work: 'other' } }, 'active intent'],
  ['intent not queued by the operator', { trustedIntentIds: new Set() }, 'active intent'],
  ['nested intent', { intent: { ...intent, opened: { ...intent.opened, parent: 'root' } } }, 'active intent'],
  ['completed intent', { intent: { ...intent, state: 'completed' } }, 'active intent'],
  ['cancelled intent', { intent: { ...intent, state: 'cancelled' } }, 'active intent'],
  ['no intent scopes', { intent: makeOrder(intent.work, null, []) }, 'non-empty'],
  ['no ticket scopes', { order: makeOrder(order.work, intent.work, []) }, 'non-empty'],
  ['high risk', { order: { ...order, opened: { ...order.opened, risk: 'high' } } }, 'risk ceiling'],
  ['critical risk', { order: { ...order, opened: { ...order.opened, risk: 'critical' } } }, 'risk ceiling'],
  ['lower ceiling', { maxRisk: 'low' }, 'risk ceiling'],
  ['low ticket under a critical intent', { intent: { ...intent, opened: { ...intent.opened, risk: 'critical' } }, order: { ...order, opened: { ...order.opened, risk: 'low' } } }, 'intent exceeds the risk ceiling'],
  ['medium ticket under a high intent', { intent: { ...intent, opened: { ...intent.opened, risk: 'high' } } }, 'intent exceeds the risk ceiling'],
  ['default cap', { liveWorkers: [{ writeScopes: ['test'] }, { writeScopes: ['docs'] }] }, 'cap'],
  ['configured cap', { maxLiveWorkers: 1, liveWorkers: [{ writeScopes: ['test'] }] }, 'cap'],
  ['over budget', { todaySpend: { status: 'known', amountUsd: 10.01 } }, 'over budget'],
];
for (const [name, overrides, reason] of refusals) {
  test(`admission refuses ${name}`, () => {
    const decision = decideAdmission({ ...baseline, ...overrides });
    assert.equal(decision.admit, false);
    if (decision.admit) throw new Error('Expected refusal');
    assert.match(decision.reason, new RegExp(reason));
    assert.equal(decision.exception, name === 'over budget');
  });
}

for (const scope of ['src', 'src/retry.ts', './src/retry.ts', 'src//retry.ts/', 'src\\retry.ts']) {
  test(`admission normalizes contained scope ${scope}`, () => {
    assert.deepEqual(decideAdmission({ ...baseline, intent: makeOrder(intent.work, null, ['./src/']), order: makeOrder(order.work, intent.work, [scope]) }), { admit: true });
  });
}
for (const scope of ['src2', 'src2/retry.ts', '../src', 'src/../src/retry.ts', '/src', 'C:\\src', '', '   ']) {
  test(`admission rejects scope ${JSON.stringify(scope)}`, () => {
    assert.equal(decideAdmission({ ...baseline, order: makeOrder(order.work, intent.work, [scope]) }).admit, false);
    assert.equal(decideAdmission({ ...baseline, intent: makeOrder(intent.work, null, [scope]) }).admit, false);
  });
}
for (const scope of ['src', './src/', 'src/retry.ts', 'src/retry.ts/nested', '.', '..']) {
  test(`admission refuses overlap with live scope ${scope}`, () => {
    const decision = decideAdmission({ ...baseline, liveWorkers: [{ writeScopes: [scope] }] });
    assert.equal(decision.admit, false);
    if (decision.admit) throw new Error('Expected refusal');
    assert.match(decision.reason, /overlap/);
    assert.equal(decision.exception, false);
  });
}

test('admission with a daily budget and unknown spend refuses and raises the factory exception', () => {
  assert.deepEqual(decideAdmission({ ...baseline, todaySpend: { status: 'tracking-off' } }), { admit: false, reason: 'daily budget set but usage tracking is off', exception: true });
  assert.deepEqual(decideAdmission({ ...baseline, todaySpend: { status: 'tracking-off' }, dailyBudgetUsd: null }), { admit: true });
});

test('admission refuses a repository with git filter drivers as a factory exception before any other rule', () => {
  assert.deepEqual(decideAdmission({ ...baseline, order: null, filterDriverNames: ['git-crypt', 'lfs'] }), { admit: false,
    reason: 'repository uses git filter drivers (git-crypt, lfs), which factory workers cannot run safely', exception: true });
});

test('admission admits root scope, equal budgets, configured limits and unlimited budgets', () => {
  assert.deepEqual(decideAdmission(baseline), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, intent: makeOrder(intent.work, null, ['./']), liveWorkers: [{ writeScopes: ['src2'] }] }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, dailyBudgetUsd: null, todaySpend: { status: 'known', amountUsd: 1000 } }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, maxRisk: 'high', order: { ...order, opened: { ...order.opened, risk: 'high' } } }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, maxRisk: 'high', intent: { ...intent, opened: { ...intent.opened, risk: 'high' } } }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, maxLiveWorkers: 3, liveWorkers: [{ writeScopes: ['tests'] }, { writeScopes: ['docs'] }] }), { admit: true });
});

test('risk ceiling admits up to and including the ceiling and defaults to medium', () => {
  assert.equal(exceedsRiskCeiling('low'), false);
  assert.equal(exceedsRiskCeiling('medium'), false);
  assert.equal(exceedsRiskCeiling('high'), true);
  assert.equal(exceedsRiskCeiling('critical', 'high'), true);
  assert.equal(exceedsRiskCeiling('critical', 'critical'), false);
  assert.equal(exceedsRiskCeiling('medium', 'low'), true);
});

test('worker prompt pins its ticket, scopes, checks and finish policy', () => {
  const prompt = buildWorkerPrompt({ projectName: 'Factory', intent, order, claudeSessionId: 'conversation' });
  for (const text of [order.work, intent.work, 'conversation', 'Add retries', 'Retries pass', 'Edit only inside',
    "coherence context 'src/retry.ts' --max-bytes 12000", 'never run git add or git commit', 'Glimmervoid commits every change in this worktree', 'npm run typecheck',
    'npm run lint', 'npm test', 'Never push', 'never open PRs', 'never change coherence work state', 'Glimmervoid closes the ticket', 'Finish by stopping',
    'A denied command means "not allowed here". Do not retry it another way.',
    'can write only inside this worktree and the temp directory']) {
    assert.ok(prompt.includes(text), text);
  }
  const customPrompt = buildWorkerPrompt({ projectName: 'Factory', intent, order, claudeSessionId: 'conversation', checks: ['node verify.ts'] });
  assert.match(customPrompt, /node verify.ts/);
  assert.equal(customPrompt.includes('npm test'), false);
  const quotedPrompt = buildWorkerPrompt({ projectName: 'Factory', intent, order: makeOrder(order.work, intent.work, ["src/a'b"]), claudeSessionId: 'conversation' });
  assert.ok(quotedPrompt.includes(`'src/a'"'"'b'`));
});


test('worker prompt fences each ledger corpus with its own content marker', () => {
  const prompt = buildWorkerPrompt({ projectName: 'Factory', intent, order, claudeSessionId: 'conversation' });
  const markers = [...prompt.matchAll(/<<<(GLIMMERVOID-FACTORY-[^\n]+)/g)].map((match) => match[1]);
  assert.equal(markers.length, 4);
  assert.equal(new Set(markers).size, 4);
  assert.ok(markers.every((marker) => prompt.includes(`${marker}>>>`)));
});

const unknownSpendRefusals: [FactoryAdmissionInput['todaySpend'], string, boolean][] = [
  [{ status: 'catching-up' }, 'usage history is still being scanned; spend is not known yet', true],
  [{ status: 'tracking-off' }, 'daily budget set but usage tracking is off', false],
  [{ status: 'read-failing' }, 'daily budget set but usage history cannot be read, so spend is not known', false],
  [{ status: 'scanner-missing' }, 'daily budget set but usage tracking is not running, so spend is not known', false],
];
for (const [todaySpend, reason, isTransient] of unknownSpendRefusals) {
  test(`admission with ${todaySpend.status} spend refuses with its own reason and only catching up is transient`, () => {
    assert.deepEqual(decideAdmission({ ...baseline, todaySpend }), { admit: false, reason, exception: true });
    assert.equal(isTransientAdmissionRefusal(reason), isTransient);
  });
}

test('admission refuses a paused factory', () => {
  assert.deepEqual(decideAdmission({ ...baseline, paused: true }), { admit: false, reason: 'factory is paused', exception: false });
});

const transientReasons = [
  'usage history is still being scanned; spend is not known yet',
  'live worker cap reached', 'write scopes overlap a live worker', 'factory is paused', 'daily spend is over budget',
];
const permanentReasons = [
  'ticket does not exist', 'ticket is not open', 'ticket is not ready',
  'ticket is not a child of the active intent', 'ticket and intent require valid non-empty write scopes',
  'ticket write scopes exceed the intent write scopes', 'ticket exceeds the risk ceiling', 'intent exceeds the risk ceiling',
  'repository uses git filter drivers (lfs), which factory workers cannot run safely',
  'daily budget set but usage tracking is off', 'unknown refusal',
];
for (const reason of transientReasons) {
  test(`admission classification retains ${reason}`, () => {
    assert.equal(isTransientAdmissionRefusal(reason), true);
  });
}
for (const reason of permanentReasons) {
  test(`admission classification discards ${reason}`, () => {
    assert.equal(isTransientAdmissionRefusal(reason), false);
  });
}

test('worker prompt requires separate shell commands without chaining', () => {
  assert.ok(buildWorkerPrompt({ projectName: 'Factory', intent, order, claudeSessionId: 'conversation' })
    .includes('Run each shell command on its own with no pipes, &&, ; or subshells, because chained commands are denied.'));
});
