import test from 'node:test';
import assert from 'node:assert/strict';
import { MyPrMergeabilityFixResult, MyPrsState } from '../shared/contracts/my-prs.ts';

test('keep mergeable attempts migrate old state and reject malformed persisted outcomes and commit shas', () => {
  const legacyState = { keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: [`Acme/app#7@${'a'.repeat(40)}`] };
  const attempt = { key: 'Acme/app#7', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), outcome: 'failed', reason: 'Could not fetch the base', at: 1234 };
  const migrated = MyPrsState.parse(legacyState);
  assert.deepEqual(migrated.keepMergeableAttempts, []);
  const state = { ...migrated, keepMergeableAttempts: [attempt] };
  assert.deepEqual(MyPrsState.parse(state), state);
  for (const overrides of [{ key: 'bad' }, { headRefOid: 'bad' }, { baseRefOid: undefined }, { baseRefOid: 'bad' }, { outcome: 'finished' }, { at: Infinity }, { at: '1234' }, { reason: '' }, { extra: true }]) {
    assert.equal(MyPrsState.safeParse({ ...state, keepMergeableAttempts: [{ ...attempt, ...overrides }] }).success, false);
  }
  assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome: 'pushed' }).success, true);
  for (const outcome of ['failed', 'no-change', 'stopped', 'timed-out']) {
    assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome, reason: 'Repair did not finish' }).success, true);
    assert.equal(MyPrMergeabilityFixResult.safeParse({ outcome }).success, false);
  }
});
