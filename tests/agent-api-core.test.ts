import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAgentRequest, decideSpawnAllowance, deriveChildSessionName, describeRoleRefusal, tokensMatch,
  MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS,
} from '../server/core/agent-api-core.ts';

const GOOD = {
  sessionId: 'session-1',
  presentedToken: 'tok-abc',
  expectedToken: 'tok-abc',
  isLoopback: true,
};

test('a matching token on the loopback listener is admitted', () => {
  assert.deepEqual(decideAgentRequest(GOOD), { ok: true });
});

test('every way to fail authentication yields one byte-identical refusal', () => {
  const refusals = [
    decideAgentRequest({ ...GOOD, isLoopback: false }),
    decideAgentRequest({ ...GOOD, sessionId: 'no-such-session', expectedToken: null }),
    decideAgentRequest({ ...GOOD, sessionId: '' }),
    decideAgentRequest({ ...GOOD, presentedToken: null }),
    decideAgentRequest({ ...GOOD, presentedToken: '' }),
    decideAgentRequest({ ...GOOD, presentedToken: 'tok-abd' }),
    decideAgentRequest({ ...GOOD, presentedToken: 'tok-abc-longer' }),
  ];
  for (const refusal of refusals) {
    assert.deepEqual(refusal, { ok: false, status: REFUSAL_STATUS, reason: REFUSAL_REASON });
  }
});

test('the token comparison refuses a wrong token and any wrong length', () => {
  assert.equal(tokensMatch('abcd', 'abcd'), true);
  assert.equal(tokensMatch('abcd', 'abce'), false);
  assert.equal(tokensMatch('abcd', 'abcdefgh'), false);
  assert.equal(tokensMatch('abcdefgh', 'abcd'), false);
  assert.equal(tokensMatch('', ''), true);
  assert.equal(tokensMatch('abcd', ''), false);
});

const EMPTY_BUDGET = { liveChildren: 0, lifetimeSpawns: 0, inFlight: 0 };
const OPERATOR_SESSION = { isEphemeral: false, isSpawnedChild: false, hasOwnWorktree: true };

test('a fresh top-level session may spawn', () => {
  assert.equal(describeRoleRefusal('spawn', OPERATOR_SESSION), null);
  assert.deepEqual(decideSpawnAllowance(EMPTY_BUDGET), { ok: true });
});

test('a spawned session may never spawn again', () => {
  const refusal = describeRoleRefusal('spawn', { ...OPERATOR_SESSION, isEphemeral: true, isSpawnedChild: true });
  assert.equal(refusal?.status, 403);
});

test('a lane session may never spawn', () => {
  const refusal = describeRoleRefusal('spawn', { ...OPERATOR_SESSION, isEphemeral: true });
  assert.equal(refusal?.status, 403);
});

test('only one spawn may be in flight at a time', () => {
  const verdict = decideSpawnAllowance({ ...EMPTY_BUDGET, inFlight: 1 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 429);
});

test('the live-child cap admits three and refuses the fourth', () => {
  assert.deepEqual(decideSpawnAllowance({ ...EMPTY_BUDGET, liveChildren: MAX_LIVE_CHILDREN - 1 }), { ok: true });
  assert.equal(decideSpawnAllowance({ ...EMPTY_BUDGET, liveChildren: MAX_LIVE_CHILDREN }).ok, false);
});

test('the lifetime cap survives children exiting', () => {
  assert.deepEqual(decideSpawnAllowance({ ...EMPTY_BUDGET, lifetimeSpawns: MAX_LIFETIME_SPAWNS - 1 }), { ok: true });
  assert.equal(decideSpawnAllowance({ ...EMPTY_BUDGET, lifetimeSpawns: MAX_LIFETIME_SPAWNS }).ok, false);
});


test('a child is named from its brief, else its requested or parent name, and never collides', () => {
  const fromBrief = { brief: 'build the title screen', parentName: 'Hog TCG Slack' };
  assert.equal(deriveChildSessionName(fromBrief, []), 'build the title screen');
  assert.equal(deriveChildSessionName(fromBrief, ['build the title screen']), 'build the title screen 2');
  assert.equal(deriveChildSessionName({ ...fromBrief, requestedName: 'titles' }, []), 'titles agent');

  const fromParent = { brief: '/compact', parentName: 'glimmervoid' };
  assert.equal(deriveChildSessionName(fromParent, []), 'glimmervoid agent');
  assert.equal(
    deriveChildSessionName(fromParent, ['glimmervoid agent', 'glimmervoid agent 2', 'glimmervoid agent 3']),
    'glimmervoid agent 4',
  );
  assert.equal(deriveChildSessionName({ brief: '', parentName: '  ' }, ['session agent']), 'session agent 2');
});
