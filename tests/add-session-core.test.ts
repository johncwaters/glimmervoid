import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderWorkspaceRows } from '../public/add-session-core.ts';
import { decidePermissions } from '../shared/session-permissions.ts';

const protectable = { isSaneYoloInstalled: true, isSaneYoloSettingOn: true, isShell: false };

test('Add Session skips permission prompts only where Sane YOLO can guard the session', () => {
  assert.deepEqual(decidePermissions(protectable), { fields: { dangerouslySkipPermissions: true, saneYolo: true }, isUnprotectedHintShown: false });
  for (const unguarded of [
    { ...protectable, isSaneYoloInstalled: false },
    { ...protectable, isSaneYoloSettingOn: false },
  ]) {
    assert.deepEqual(decidePermissions(unguarded), { fields: {}, isUnprotectedHintShown: true });
  }
  assert.deepEqual(decidePermissions({ ...protectable, isShell: true }), { fields: {}, isUnprotectedHintShown: false });
});

test('Several repos keeps picked repos on top and visible while the search hides the rest', () => {
  const repos = [{ name: 'api', path: '/api' }, { name: 'web', path: '/web' }, { name: 'docs', path: '/docs' }];
  const { picked, others } = orderWorkspaceRows(repos, ['/docs', '/api'], 'we');
  assert.deepEqual(picked.map((repo) => repo.name), ['docs', 'api']);
  assert.deepEqual(others.map((repo) => repo.name), ['web']);
});
