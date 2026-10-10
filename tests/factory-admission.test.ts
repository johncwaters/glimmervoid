import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkerPrompt, decideAdmission } from '../server/core/factory-core.ts';
import type { FactoryAdmissionInput, FactoryWorkOrder } from '../server/core/factory-core.ts';

function makeOrder(work: string, parent: string | null, writeScopes = ['src']): FactoryWorkOrder {
  return { work, state: 'open', readiness: 'ready', owner: { session: 'factory', agent: 'claude-code' }, last: null,
    opened: { at: '2026-10-08T12:00:00.000Z', objective: 'Add retries', criteria: ['Retries pass'], authority: { boundary: 'This repo' },
      risk: 'medium', parent, dependsOn: [], readScopes: [], writeScopes } };
}

const intent = makeOrder('wrk-0000000000000001', null);
const order = makeOrder('wrk-0000000000000002', intent.work, ['src/retry.ts']);
const baseline: FactoryAdmissionInput = { intent, order, trustedIntentIds: new Set([intent.work]), liveWorkers: [], spentTodayUsd: 10, dailyBudgetUsd: 10 };

const refusals: [string, Partial<FactoryAdmissionInput>, string][] = [
  ['missing order', { order: null }, 'does not exist'],
  ['active order', { order: { ...order, state: 'active' } }, 'not open'],
  ['blocked order', { order: { ...order, state: 'blocked' } }, 'not open'],
  ['waiting order', { order: { ...order, readiness: 'waiting' } }, 'not ready'],
  ['missing intent', { intent: null }, 'active intent'],
  ['wrong intent', { intent: { ...intent, work: 'other' } }, 'active intent'],
  ['intent not queued by the operator', { trustedIntentIds: new Set() }, 'active intent'],
  ['nested intent', { intent: { ...intent, opened: { ...intent.opened, parent: 'root' } } }, 'active intent'],
  ['completed intent', { intent: { ...intent, state: 'completed' } }, 'active intent'],
  ['cancelled intent', { intent: { ...intent, state: 'cancelled' } }, 'active intent'],
  ['no intent scopes', { intent: makeOrder(intent.work, null, []) }, 'non-empty'],
  ['no order scopes', { order: makeOrder(order.work, intent.work, []) }, 'non-empty'],
  ['high risk', { order: { ...order, opened: { ...order.opened, risk: 'high' } } }, 'risk ceiling'],
  ['critical risk', { order: { ...order, opened: { ...order.opened, risk: 'critical' } } }, 'risk ceiling'],
  ['lower ceiling', { maxRisk: 'low' }, 'risk ceiling'],
  ['default cap', { liveWorkers: [{ writeScopes: ['test'] }, { writeScopes: ['docs'] }] }, 'cap'],
  ['configured cap', { maxLiveWorkers: 1, liveWorkers: [{ writeScopes: ['test'] }] }, 'cap'],
  ['over budget', { spentTodayUsd: 10.01 }, 'over budget'],
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
  assert.deepEqual(decideAdmission({ ...baseline, spentTodayUsd: null }), { admit: false, reason: 'daily budget set but usage tracking is off', exception: true });
  assert.deepEqual(decideAdmission({ ...baseline, spentTodayUsd: null, dailyBudgetUsd: null }), { admit: true });
});

test('admission admits root scope, equal budgets, configured limits and unlimited budgets', () => {
  assert.deepEqual(decideAdmission(baseline), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, intent: makeOrder(intent.work, null, ['./']), liveWorkers: [{ writeScopes: ['src2'] }] }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, dailyBudgetUsd: null, spentTodayUsd: 1000 }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, maxRisk: 'high', order: { ...order, opened: { ...order.opened, risk: 'high' } } }), { admit: true });
  assert.deepEqual(decideAdmission({ ...baseline, maxLiveWorkers: 3, liveWorkers: [{ writeScopes: ['tests'] }, { writeScopes: ['docs'] }] }), { admit: true });
});

test('worker prompt pins its order, scopes, checks and finish policy', () => {
  const prompt = buildWorkerPrompt({ projectName: 'Factory', intent, order, claudeSessionId: 'conversation' });
  for (const text of [order.work, intent.work, 'conversation', 'Add retries', 'Retries pass', 'Edit only inside',
    "coherence context 'src/retry.ts' --max-bytes 12000", 'current branch', 'conventional commit message', 'npm run typecheck',
    'npm run lint', 'npm test', 'Never push', 'never open PRs', 'never change coherence work state', 'Glimmervoid closes the order', 'Finish by stopping']) {
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
