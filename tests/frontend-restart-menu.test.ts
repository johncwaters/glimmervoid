import assert from 'node:assert/strict';
import test from 'node:test';
import { STATES } from '../shared/states.ts';
import { decidePlanHeaderAction } from '../public/session-card/face-core.ts';
import { restartConfirmation, runRestartChoice } from '../public/session-card/restart-menu-core.ts';
import type { RestartChoice, RestartChoiceDeps } from '../public/session-card/restart-menu-core.ts';

test('every restart choice confirms only while the agent is mid-turn', () => {
  for (const state of Object.values(STATES)) {
    for (const action of ['restart', 'restart-fresh', 'restart-into'] as const) {
      const confirmation = restartConfirmation(action, state);
      if (state !== STATES.RUNNING) {
        assert.equal(confirmation, null);
        continue;
      }
      assert.ok(confirmation);
      assert.equal(confirmation.danger, action !== 'restart');
      assert.equal(confirmation.title, action === 'restart-fresh' ? 'Restart fresh' : 'Restart');
      assert.equal(confirmation.confirmLabel, confirmation.title);
      assert.match(confirmation.message, /mid-turn/);
      assert.equal(/keeps this conversation/.test(confirmation.message), action === 'restart');
      assert.equal(/switches to the earlier conversation/.test(confirmation.message), action === 'restart-into');
    }
  }
});

test('the header Plan action uses the borrowed face and otherwise navigates', () => {
  for (const hasPlan of [false, true]) {
    for (const isBorrowed of [false, true]) {
      for (const face of ['terminal', 'plan'] as const) {
        const action = decidePlanHeaderAction({ hasPlan, isBorrowed, face });
        if (!hasPlan || face === 'plan') {
          assert.equal(action, 'hidden');
          continue;
        }
        assert.equal(action, isBorrowed ? 'face' : 'navigate');
      }
    }
  }
});

function recordRestartChoice(action: RestartChoice, state: string) {
  const sent: Parameters<RestartChoiceDeps['send']>[0][] = [];
  const confirmations: Parameters<RestartChoiceDeps['confirm']>[0][] = [];
  runRestartChoice(action, 'session-a', {
    readState: () => state,
    send: (message) => { sent.push(message); },
    confirm: (confirmation) => { confirmations.push(confirmation); },
  }, 'conversation-e');
  return { sent, confirmations };
}

test('Restart sends a plain restart, and force-restart only for a killable state', () => {
  assert.deepEqual(recordRestartChoice('restart', STATES.DONE).sent, [{ type: 'restart', id: 'session-a' }]);
  assert.deepEqual(recordRestartChoice('restart', STATES.WAITING).sent, [{ type: 'force-restart', id: 'session-a' }]);
});

test('Restart fresh sends the same restart type with fresh set', () => {
  assert.deepEqual(recordRestartChoice('restart-fresh', STATES.DONE).sent, [{ type: 'restart', id: 'session-a', fresh: true }]);
  assert.deepEqual(recordRestartChoice('restart-fresh', STATES.WAITING).sent, [{ type: 'force-restart', id: 'session-a', fresh: true }]);
});

test('a running session confirms first and sends only on confirm', () => {
  const expectedByAction = {
    'restart': { type: 'force-restart', id: 'session-a' },
    'restart-fresh': { type: 'force-restart', id: 'session-a', fresh: true },
    'restart-into': { type: 'force-restart', id: 'session-a', conversationId: 'conversation-e' },
  };
  for (const action of ['restart', 'restart-fresh', 'restart-into'] as const) {
    const { sent, confirmations } = recordRestartChoice(action, STATES.RUNNING);
    assert.equal(confirmations.length, 1);
    assert.deepEqual(sent, []);
    confirmations[0].onConfirm();
    assert.deepEqual(sent, [expectedByAction[action]]);
  }
});

test('a session that is not running sends immediately with no confirm', () => {
  for (const state of Object.values(STATES)) {
    if (state === STATES.RUNNING) continue;
    for (const action of ['restart', 'restart-fresh', 'restart-into'] as const) {
      const { sent, confirmations } = recordRestartChoice(action, state);
      assert.equal(confirmations.length, 0);
      assert.equal(sent.length, 1);
    }
  }
});

test('the confirmed send reads the state at confirm time, not at click time', () => {
  const session = { state: STATES.RUNNING as string };
  const sent: Parameters<RestartChoiceDeps['send']>[0][] = [];
  let confirmRestart = () => {};
  runRestartChoice('restart', 'session-a', {
    readState: () => session.state,
    send: (message) => { sent.push(message); },
    confirm: ({ onConfirm }) => { confirmRestart = onConfirm; },
  });
  session.state = STATES.DONE;
  confirmRestart();
  assert.deepEqual(sent, [{ type: 'restart', id: 'session-a' }]);
});
