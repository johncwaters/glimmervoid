import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideAgentRequest, decideSpawnAllowance, deriveChildSessionName, formatFactoryStatus, tokensMatch,
  MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS,
} from '../server/core/agent-api-core.ts';
import { buildFactoryIntentDigest, buildFactoryProjectState } from '../server/factory/core/factory-core.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';

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

const EMPTY_BUDGET = { liveChildren: 0, lifetimeSpawns: 0, inFlight: 0, depth: 0, isFactoryWorker: false, isEphemeral: false };

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
  const verdict = decideSpawnAllowance({ liveChildren: 9, lifetimeSpawns: 99, inFlight: 5, depth: 2, isFactoryWorker: false, isEphemeral: true });
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

test('factory status formats the digest, ticket blocks and next actions, project spend and an unavailable ledger', () => {
  const intent: FactoryProjectState['orders'][number] = {
    id: 'intent', objective: 'Ship overnight', openedAt: '2026-10-15T00:00:00Z', criteria: [], boundary: 'src/',
    risk: 'low', state: 'open', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src/'], owner: null, lastEvent: null,
  };
  const cases: { state: typeof intent.state; isParked?: boolean; isPartial?: boolean; blockCount?: number; outcome: string; summary: string; action: string; reason?: string }[] = [
    { state: 'completed', outcome: 'completed', summary: 'merged: 1; parked: 0', action: 'none' },
    { state: 'cancelled', outcome: 'in progress', summary: 'merged: 0; parked: 0', action: 'none' },
    { state: 'blocked', isParked: true, isPartial: true, blockCount: 3, outcome: 'partial', summary: 'merged: 0; parked: 1', action: 'glimmervoid factory retry intent', reason: 'Needs write scope: src/entry.ts' },
    { state: 'blocked', outcome: 'in progress', summary: 'merged: 0; parked: 0', action: 'orchestrator reopens', reason: 'Check failed' },
    { state: 'open', outcome: 'in progress', summary: 'merged: 0; parked: 0', action: 'in progress' },
    { state: 'active', outcome: 'in progress', summary: 'merged: 0; parked: 0', action: 'in progress' },
  ];
  for (const scenario of cases) {
    const project: FactoryProjectState = {
      projectId: 'repo', projectName: 'Repository', headSha: null, paused: false, orchestrator: null, error: null,
      heading: { action: 'steady', reasons: [] }, conflicts: [], unverifiedCompletedWork: [], spentTodayUsd: 2.5, dailyBudgetUsd: 10,
      partialIntentIds: scenario.isPartial ? ['intent'] : [], confirmedFlakesByIntent: { intent: ['tests/check.test.ts: intermittent timeout'] },
      orders: [
        { ...intent, state: scenario.outcome === 'completed' ? 'completed' : 'open' },
        { ...intent, id: 'ticket', parent: 'intent', state: scenario.state, parked: scenario.isParked, blockCount: scenario.blockCount, blockReason: scenario.reason },
        { ...intent, id: 'cancelled-intent', state: 'cancelled' },
        { ...intent, id: 'hidden-ticket', parent: 'cancelled-intent' },
      ],
    };
    assert.equal(formatFactoryStatus([project], buildFactoryIntentDigest), [
      'Project repo: Repository',
      'Project spend today: $2.50 of $10.00 budget',
      'Intent intent: Ship overnight',
      `Outcome: ${scenario.outcome}; ${scenario.summary}`,
      `  ticket | state: ${scenario.isParked ? 'parked' : scenario.state} | blocks: ${scenario.blockCount ?? 0} | last reason: ${scenario.reason ?? 'none'} | next action: ${scenario.action}`,
      'Confirmed flakes:',
      '  tests/check.test.ts: intermittent timeout',
    ].join('\n'), scenario.state);
  }
  assert.equal(formatFactoryStatus([], buildFactoryIntentDigest), 'No factory projects.');
  const unreadableLedger = buildFactoryProjectState({ projectId: 'repo', projectName: 'Repository', headSha: null, orient: null, work: null, error: 'ledger read failed' });
  assert.equal(formatFactoryStatus([{ ...unreadableLedger, dailyBudgetUsd: null }], buildFactoryIntentDigest), [
    'Project repo: Repository', 'Project spend today: unknown of unlimited budget', 'Factory state unavailable: ledger read failed',
  ].join('\n'));
});
