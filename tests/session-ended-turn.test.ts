import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';

function withSession(state: SessionState, resumeSessionId: string | null, check: (session: Session) => void) {
  const session = new Session({ id: 'ended-turn-test', name: 'ended-turn', path: process.cwd(), resumeSessionId });
  session.state = state;
  try {
    check(session);
  } finally {
    session.destroy();
  }
}

test('a fresh session has not ended a turn', () => {
  withSession(STATES.DORMANT, null, (session) => {
    assert.equal(session.transition('user_start'), true);
    assert.equal(session.hasEndedTurn, false);
    assert.equal(session.toSnapshot().hasEndedTurn, false);
  });
});

test('finishing a turn sets the flag and dismissing back to IDLE keeps it', () => {
  withSession(STATES.RUNNING, null, (session) => {
    const endedTurnAtStateChange: boolean[] = [];
    session.on('state-change', () => endedTurnAtStateChange.push(session.hasEndedTurn));
    assert.equal(session.transition('task_complete'), true);
    assert.equal(session.hasEndedTurn, true);
    assert.equal(session.transition('user_dismiss'), true);
    assert.equal(session.state, STATES.IDLE);
    assert.equal(session.toSnapshot().hasEndedTurn, true);
    assert.deepEqual(endedTurnAtStateChange, [true, true]);
  });
});

test('entering INITIALIZING seeds the ended-turn flag from the configured resume id', () => {
  withSession(STATES.DORMANT, 'vendor-conversation', (session) => {
    assert.equal(session.transition('user_start'), true);
    assert.equal(session.hasEndedTurn, true);
  });
  withSession(STATES.RUNNING, null, (session) => {
    assert.equal(session.transition('task_complete'), true);
    assert.equal(session.transition('user_kill'), true);
    assert.equal(session.transition('user_restart'), true);
    assert.equal(session.hasEndedTurn, false);
  });
});
