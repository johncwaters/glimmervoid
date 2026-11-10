import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRestartStrategy } from '../server/core/restart-strategy.ts';
import claudeCode from '../session/adapters/claude-code.ts';

test('a server launchd supervises exits for the supervisor on restart', () => {
  assert.equal(decideRestartStrategy({ GLIMMERVOID_SUPERVISOR: 'launchd' }), 'exit-for-supervisor');
});

test('a hand-run server respawns itself on restart', () => {
  assert.equal(decideRestartStrategy({}), 'respawn');
});

test('a server started inside a session of a systemd or launchd supervised server respawns itself on restart', () => {
  const supervisedServerEnv = { PATH: '/usr/bin', INVOCATION_ID: 'a1b2', SYSTEMD_EXEC_PID: '4242', GLIMMERVOID_SUPERVISOR: 'launchd' };
  const sessionEnv = claudeCode.buildEnv(supervisedServerEnv, null);
  assert.equal(decideRestartStrategy(sessionEnv), 'respawn');
});
