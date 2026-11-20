import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';

const HOUR_MS = 3_600_000;

function makeSession(): Session {
  return new Session({
    id: 'usage-limit',
    name: 'usage-limit',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
}

test('a replayed usage limit whose reset has passed never reaches the session', (context) => {
  const session = makeSession();
  context.after(() => session.destroy());
  session.noteUsageLimit({ resetsAtMs: Date.now() - HOUR_MS, window: 'weekly' });
  assert.equal(session.toSnapshot().usageLimit, null);
});

test('a usage limit is cleared once the operator sends the next prompt', (context) => {
  const session = makeSession();
  context.after(() => session.destroy());
  session.noteUsageLimit({ resetsAtMs: Date.now() + HOUR_MS, window: 'weekly' });
  assert.notEqual(session.toSnapshot().usageLimit, null);
  session.ingestHookSignal({ signal: 'running', source: 'hook', ts: Date.now(), event: 'UserPromptSubmit', payload: { prompt: 'continue' } });
  assert.equal(session.toSnapshot().usageLimit, null);
});
