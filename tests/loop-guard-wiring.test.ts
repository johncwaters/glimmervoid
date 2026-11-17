import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLoopGuardWiring } from '../server/session/loop-guard-wiring.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { plainSession } from './helpers/fake-session.ts';
import { waitFor } from './helpers/wait-for.ts';

test('a message typed into a session by another session counts as input, so an orchestrator that delegates edits is never flagged as stuck', async () => {
  const session = plainSession('orchestrator');
  const raised: string[] = [];
  session.raiseAttention = (_origin, note) => {
    raised.push(note);
    return { ok: true, pending: false };
  };
  session.worktreeLifecycle.hasOwnWorktree = () => true;
  session.worktreeLifecycle.computeWorktreeSignature = async () => ({ sig: 'unchanged', dirty: false, ahead: '0', behind: '0', rebaseBehind: '0', rebaseInProgress: false, headSha: 'head', targetSha: null, baseRef: null });
  createLoopGuardWiring({ getLoopGuardConfig: () => ({ maxTurnsWithoutProgress: 2, onStuck: 'flag' }), logger: { warn: () => {} } }).attachSession(session);
  session.transition('user_start');
  session.transition('spawn_success', { spawnCwdExists: true });
  session.transition('first_output');
  session.ptyProcess = fakePty();
  session._ptyAlive = true;
  const endTurn = async () => {
    session.emit('post-turn-check');
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    for (let turn = 0; turn < 3; turn += 1) {
      await endTurn();
      let isSubmitted = false;
      const delivery = session.deliver('[from child] done', { when: 'now', submit: true, onSettled: (settlement) => { isSubmitted = settlement === 'submitted'; } });
      assert.deepEqual(delivery, { ok: true, kind: 'pasted' });
      await waitFor(() => isSubmitted);
    }
    await endTurn();
    assert.deepEqual(raised, []);
  } finally {
    session.destroy();
  }
});
