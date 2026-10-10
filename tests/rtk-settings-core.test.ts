import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRtkHookTools } from '../session/core/rtk-settings-core.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';

test('refreshing RTK adds, removes and updates compression without changing the original guard', () => {
  const guard: ResolvedHookTool = { id: 'saneYolo', binPath: '/original/guard.js' };
  const oldRtk: ResolvedHookTool = { id: 'rtk', binPath: '/original/rtk' };
  const newRtk: ResolvedHookTool = { id: 'rtk', binPath: '/current/rtk' };
  const changedGuard: ResolvedHookTool = { id: 'saneYolo', binPath: '/current/guard.js' };
  const originalTools = [oldRtk, guard];
  assert.deepEqual(refreshRtkHookTools(originalTools, [changedGuard]), [guard]);
  assert.deepEqual(refreshRtkHookTools(originalTools, [newRtk, changedGuard]), [newRtk, guard]);
  assert.deepEqual(refreshRtkHookTools([guard], [newRtk, changedGuard]), [newRtk, guard]);
  assert.deepEqual(originalTools, [oldRtk, guard]);
});
