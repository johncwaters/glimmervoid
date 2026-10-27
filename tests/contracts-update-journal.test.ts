import test from 'node:test';
import assert from 'node:assert/strict';

import { UpdateJournal } from '../shared/contracts/index.ts';

const VALID_JOURNAL = {
  state: 'running',
  fromSha: '1111111111111111111111111111111111111111',
  toSha: '2222222222222222222222222222222222222222',
  toVersion: '0.25.0',
  channel: 'release',
  steps: [{
    id: 'fetch',
    status: 'running',
    startedAt: 1000,
    finishedAt: null,
    outputTail: ['fetching'],
  }],
  activeStep: 'fetch',
  reason: null,
  startedAt: 1000,
  finishedAt: null,
};

test('the update journal contract treats the handoff failure flag as optional', () => {
  assert.deepEqual(UpdateJournal.parse(VALID_JOURNAL), VALID_JOURNAL);
  const failedAtHandOff = { ...VALID_JOURNAL, state: 'failed', failedAtHandOff: true };
  assert.deepEqual(UpdateJournal.parse(failedAtHandOff), failedAtHandOff);
  assert.equal(UpdateJournal.safeParse({ ...VALID_JOURNAL, failedAtHandOff: 'yes' }).success, false);
});
