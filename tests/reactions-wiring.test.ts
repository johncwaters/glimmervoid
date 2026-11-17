import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createReactionsWiring } from '../server/reactions-wiring.ts';
import type { DeliverOptions, DeliveryOutcome } from '../session/core/input-delivery-core.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';
import type { SessionState } from '../shared/states.ts';

function reactingSession() {
  const typed: string[] = [];
  let state: SessionState = STATES.RUNNING;
  const session = plainSession('reacting');
  session.deliver = (text: string, options: DeliverOptions): DeliveryOutcome => {
    if (state !== STATES.IDLE && state !== STATES.COMPLETE) return { ok: false, kind: 'refused', reason: 'not-idle' };
    typed.push(text);
    options.onSettled?.('submitted');
    return { ok: true, kind: 'pasted' };
  };
  const moveTo = (to: SessionState) => {
    state = to;
    session.emit('state-change', { to });
  };
  return { session, typed, moveTo };
}

test('a wake reaction raised while the session waits lands once the session next goes idle, and only once', () => {
  const reactions = { cooldownMinutes: 30, reactions: [{ id: 'nudge', on: 'needs-attention', action: 'wake', text: 'Carry on' }] };
  const { session, typed, moveTo } = reactingSession();
  createReactionsWiring({ readReactions: () => reactions, logger: { warn: () => {} } }).attachSession(session);

  moveTo(STATES.WAITING);
  assert.deepEqual(typed, []);
  moveTo(STATES.RUNNING);
  moveTo(STATES.IDLE);
  assert.deepEqual(typed, ['Carry on']);

  session.emit('user-prompt');
  moveTo(STATES.WAITING);
  moveTo(STATES.IDLE);
  assert.deepEqual(typed, ['Carry on'], 'the turn the wake started never wakes it again');
});
