import test from 'node:test';
import assert from 'node:assert/strict';

import { decideReloadOnBuild } from '../public/server-build-core.ts';

test('the first snapshot records the build and never reloads', () => {
  assert.deepEqual(decideReloadOnBuild(null, '0.22.0+abcd'), { knownBuild: '0.22.0+abcd', reload: false });
});

test('the same build across a reconnect is a no-op', () => {
  assert.deepEqual(decideReloadOnBuild('0.22.0+abcd', '0.22.0+abcd'), { knownBuild: '0.22.0+abcd', reload: false });
});

test('a changed build reloads once and adopts the new value', () => {
  const first = decideReloadOnBuild('0.22.0+abcd', '0.23.0+ef01');
  assert.deepEqual(first, { knownBuild: '0.23.0+ef01', reload: true });

  assert.equal(decideReloadOnBuild(first.knownBuild, '0.23.0+ef01').reload, false);
});

test('a restart onto the same version still counts as a new build', () => {
  assert.equal(decideReloadOnBuild('0.22.0+abcd', '0.22.0+9999').reload, true);
});

test('a snapshot with no build changes nothing', () => {
  for (const missing of [undefined, null, '', 42, {}]) {
    assert.deepEqual(
      decideReloadOnBuild('0.22.0+abcd', missing),
      { knownBuild: '0.22.0+abcd', reload: false },
      String(missing)
    );
  }
});
