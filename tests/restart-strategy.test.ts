import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRestartStrategy } from '../server/core/restart-strategy.ts';

test('a server launchd supervises exits for the supervisor on restart', () => {
  assert.equal(decideRestartStrategy({ GLIMMERVOID_SUPERVISOR: 'launchd' }), 'exit-for-supervisor');
});

test('a hand-run server respawns itself on restart', () => {
  assert.equal(decideRestartStrategy({}), 'respawn');
});
