import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WAKE_LIMITS, WAKE_RECHECK_MS, decideDueWake } from '../server/core/wake-core.ts';
import { STATES } from '../shared/states.ts';
import type { Wake } from '../shared/contracts/wakes.ts';

const DUE_AT_MS = 1_000_000;
const CONTINUE_WAKE: Wake = { id: 'w1', sessionId: 's1', text: 'continue', status: 'pending', schedule: { kind: 'at', fireAt: DUE_AT_MS }, setAt: 0, nextFireAt: DUE_AT_MS, origin: 'limit-reset' };
const OPERATOR_AWAY = { isOperatorFlagged: false, wakesSinceOperatorInput: 0, msSinceOperatorInput: 3_600_000 };

test('a due wake types into a session waiting on a rate limit, and waits on any other prompt', () => {
  const dueFacts = { nowMs: DUE_AT_MS, sessionState: STATES.WAITING, rateLimitResetsAtMs: null, hasConversationId: true, isDelivering: false, ...OPERATOR_AWAY };
  assert.deepEqual(decideDueWake(CONTINUE_WAKE, { ...dueFacts, isWaitingOnRateLimit: true }, DEFAULT_WAKE_LIMITS), { kind: 'type-line' });
  assert.equal(decideDueWake(CONTINUE_WAKE, { ...dueFacts, isWaitingOnRateLimit: false }, DEFAULT_WAKE_LIMITS).kind, 'wait');
});

test('a wake due during a rate limit waits for the reset, and an operator wake skips the self-wake cap', () => {
  const resetsAtMs = DUE_AT_MS + 60_000;
  const limitedFacts = { nowMs: DUE_AT_MS, sessionState: STATES.WAITING, isWaitingOnRateLimit: true, rateLimitResetsAtMs: resetsAtMs, hasConversationId: true, isDelivering: false, ...OPERATOR_AWAY };
  const agentWake: Wake = { ...CONTINUE_WAKE, origin: 'agent' };
  assert.deepEqual(decideDueWake(agentWake, limitedFacts, DEFAULT_WAKE_LIMITS), { kind: 'wait', untilMs: DUE_AT_MS + WAKE_RECHECK_MS });
  const cappedAfterReset = { ...limitedFacts, nowMs: resetsAtMs, isOperatorFlagged: true, wakesSinceOperatorInput: 10 };
  assert.equal(decideDueWake(agentWake, cappedAfterReset, DEFAULT_WAKE_LIMITS).kind, 'wait');
  assert.deepEqual(decideDueWake(CONTINUE_WAKE, cappedAfterReset, DEFAULT_WAKE_LIMITS), { kind: 'type-line' });
});
