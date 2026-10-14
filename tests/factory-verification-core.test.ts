import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFence, decideAdmission, decideIntentClose, evidenceNamesOnlySha } from '../server/factory/core/factory-core.ts';
import type { FactoryWorkOrder } from '../server/factory/core/factory-core.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';

const mergedAt = '2026-10-08T12:00:00.000Z';
const intent: FactoryProjectState['orders'][number] = {
  id: 'intent', objective: 'Ship retries', openedAt: mergedAt, criteria: ['Retries work'], boundary: 'This repo', risk: 'medium',
  state: 'open', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src'], owner: null, lastEvent: null,
};
const child = { ...intent, id: 'child', parent: 'intent', state: 'completed' as const };

for (const rootScope of ['.', '**']) {
  test(`canonical root scope ${rootScope} contains nested admission and fence paths`, () => {
    const root: FactoryWorkOrder = { work: 'intent', state: 'open', readiness: 'ready', owner: { session: 'factory', agent: 'claude-code' }, last: null,
      opened: { at: mergedAt, objective: 'Ship retries', criteria: [], authority: { boundary: 'repo' }, risk: 'medium', parent: null,
        dependsOn: [], readScopes: [], writeScopes: [rootScope] } };
    const order = { ...root, work: 'child', opened: { ...root.opened, parent: 'intent', writeScopes: ['src/retry.ts'] } };
    assert.deepEqual(decideAdmission({ intent: root, order, trustedIntentIds: new Set([root.work]), liveWorkers: [], todaySpend: { status: 'known', amountUsd: 0 }, dailyBudgetUsd: null, filterDriverNames: [] }), { admit: true });
    assert.deepEqual(checkFence({ changedPaths: ['src/retry.ts'], writeScopes: [rootScope], protectedPaths: [] }), { ok: true });
    assert.equal(checkFence({ changedPaths: ['.coherence/work.jsonl'], writeScopes: [rootScope], protectedPaths: [] }).ok, false);
    assert.equal(decideAdmission({ intent: root, order, trustedIntentIds: new Set([root.work]), liveWorkers: [{ writeScopes: [rootScope] }], todaySpend: { status: 'known', amountUsd: 0 }, dailyBudgetUsd: null, filterDriverNames: [] }).admit, false);
  });
}

test('intent close requires ready signal, completed verified children, and independent root verification', () => {
  const input = { intent, children: [child], verifiedWorkIds: new Set(['child']), orchestratorSaidReady: true };
  assert.equal(decideIntentClose(input), 'verify');
  assert.equal(decideIntentClose({ ...input, orchestratorSaidReady: false }), 'wait');
  assert.equal(decideIntentClose({ ...input, children: [] }), 'verify');
  assert.equal(decideIntentClose({ ...input, children: [{ ...child, state: 'active' }] }), 'wait');
  assert.equal(decideIntentClose({ ...input, children: [{ ...child, parent: 'another' }] }), 'wait');
  assert.equal(decideIntentClose({ ...input, verifiedWorkIds: new Set() }), 'wait');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'cancelled' } }), 'wait');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'completed' } }), 'close-without-verifier');
  assert.equal(decideIntentClose({ ...input, intent: { ...intent, state: 'completed' }, verifiedWorkIds: new Set(['intent', 'child']) }), 'wait');
});

test('verification evidence counts only when every sha it names is the sha the trust was issued for', () => {
  const issuedSha = 'a'.repeat(40);
  const otherSha = 'b'.repeat(40);
  assert.equal(evidenceNamesOnlySha(`Independent verifier passed every intent criterion at ${issuedSha}`, issuedSha), true);
  assert.equal(evidenceNamesOnlySha(`Merged at ${issuedSha} after the fence, checks and independent review passed`, issuedSha), true);
  assert.equal(evidenceNamesOnlySha(`Independent verifier passed every intent criterion at ${otherSha}`, issuedSha), false);
  assert.equal(evidenceNamesOnlySha(`Passed at ${issuedSha} and ${otherSha}`, issuedSha), false);
  assert.equal(evidenceNamesOnlySha('Forged', issuedSha), false);
  assert.equal(evidenceNamesOnlySha(undefined, issuedSha), false);
});
