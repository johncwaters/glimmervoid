import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePermissions } from '../public/add-session-core.ts';

const protectable = { isSaneYoloInstalled: true, isSaneYoloSettingOn: true, hasEnvironment: false, isShell: false };

test('Add Session skips permission prompts only where Sane YOLO can guard the session', () => {
  assert.deepEqual(decidePermissions(protectable), { fields: { dangerouslySkipPermissions: true, saneYolo: true }, isUnprotectedHintShown: false });
  for (const unguarded of [
    { ...protectable, isSaneYoloInstalled: false },
    { ...protectable, isSaneYoloSettingOn: false },
    { ...protectable, hasEnvironment: true },
  ]) {
    assert.deepEqual(decidePermissions(unguarded), { fields: {}, isUnprotectedHintShown: true });
  }
  assert.deepEqual(decidePermissions({ ...protectable, isShell: true }), { fields: {}, isUnprotectedHintShown: false });
});
