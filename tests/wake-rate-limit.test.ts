import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WAKE_LIMITS, decideDueWake } from '../server/core/wake-core.ts';
import { STATES } from '../shared/states.ts';
import type { Wake } from '../shared/contracts/wakes.ts';

const DUE_AT_MS = 1_000_000;
const CONTINUE_WAKE: Wake = { id: 'w1', sessionId: 's1', text: 'continue', status: 'pending', schedule: { kind: 'in', fireAt: DUE_AT_MS }, setAt: 0, nextFireAt: DUE_AT_MS };
const OPERATOR_AWAY = { isOperatorFlagged: false, wakesSinceOperatorInput: 0, msSinceOperatorInput: 3_600_000 };

test('a due wake types into a session waiting on a rate limit, and waits on any other prompt', () => {
  const dueFacts = { nowMs: DUE_AT_MS, sessionState: STATES.WAITING, hasConversationId: true, isDelivering: false, ...OPERATOR_AWAY };
  assert.deepEqual(decideDueWake(CONTINUE_WAKE, { ...dueFacts, isWaitingOnRateLimit: true }, DEFAULT_WAKE_LIMITS), { kind: 'type-line' });
  assert.equal(decideDueWake(CONTINUE_WAKE, { ...dueFacts, isWaitingOnRateLimit: false }, DEFAULT_WAKE_LIMITS).kind, 'wait');
});
