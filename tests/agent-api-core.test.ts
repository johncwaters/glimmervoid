import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAgentRequest, decideSpawnAllowance, deriveChildSessionName, tokensMatch,
  MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS,
} from '../server/core/agent-api-core.ts';

const GOOD = {
  sessionId: 'session-1',
  presentedToken: 'tok-abc',
  expectedToken: 'tok-abc',
  isLoopback: true,
  enabled: true,
};

test('a matching token on the loopback listener is admitted', () => {
  assert.deepEqual(decideAgentRequest(GOOD), { ok: true });
});

test('every way to fail authentication yields one byte-identical refusal', () => {
  const refusals = [
    decideAgentRequest({ ...GOOD, enabled: false }),
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

const EMPTY_BUDGET = { liveChildren: 0, lifetimeSpawns: 0, inFlight: 0, depth: 0 };

test('a fresh top-level session may spawn', () => {
  assert.deepEqual(decideSpawnAllowance(EMPTY_BUDGET), { ok: true });
});

test('a spawned session may never spawn again', () => {
  const verdict = decideSpawnAllowance({ ...EMPTY_BUDGET, depth: 1 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 403);
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

test('depth is checked before every count, so a child is refused even with an empty budget', () => {
  const verdict = decideSpawnAllowance({ liveChildren: 9, lifetimeSpawns: 99, inFlight: 5, depth: 2 });
  assert.equal(verdict.ok === false && verdict.status, 403);
});

test('a child name is derived from the parent and never collides', () => {
  assert.equal(deriveChildSessionName('glimmervoid', []), 'glimmervoid agent');
  assert.equal(deriveChildSessionName('glimmervoid', ['glimmervoid agent']), 'glimmervoid agent 2');
  assert.equal(
    deriveChildSessionName('glimmervoid', ['glimmervoid agent', 'glimmervoid agent 2', 'glimmervoid agent 3']),
    'glimmervoid agent 4',
  );
  assert.equal(deriveChildSessionName('  ', ['session agent']), 'session agent 2');
});
