import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { scopedLaunch } from '../session/core/session-scope-core.ts';

test('a scoped launch hands the agent its detached desktop bus through systemd-run instead of systemd-run itself', () => {
  const launch = scopedLaunch({
    unitName: 'glimmervoid-session-s1-00000000.scope',
    serverUnit: null,
    file: '/usr/bin/codex',
    args: ['--yolo'],
    env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  });

  const commandStart = launch.args.indexOf('--');
  const setEnvAt = launch.args.indexOf('-E');
  assert.ok(setEnvAt > -1 && setEnvAt < commandStart);
  assert.equal(launch.args[setEnvAt + 1], 'DBUS_SESSION_BUS_ADDRESS=disabled:');
  assert.deepEqual(launch.args.slice(commandStart + 1), ['/usr/bin/codex', '--yolo']);
  assert.equal('DBUS_SESSION_BUS_ADDRESS' in launch.env, false);
  assert.equal(launch.env.PATH, '/usr/bin');
});
