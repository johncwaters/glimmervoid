import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCodexRemoteLaunch } from '../session/core/codex-remote-launch-core.ts';
import { supervisionLine } from '../session/core/session-routes.ts';

test('a Coder workspace Codex, which runs no Glimmervoid hooks, gets the start line through its app-server config', () => {
  const startLine = supervisionLine({ canSpawn: true });
  const launch = splitCodexRemoteLaunch(['-c', 'check_for_update_on_startup=false', 'hi'], startLine);
  assert.deepEqual(launch.appServerConfigArgs, ['-c', `developer_instructions='''${startLine}'''`, '-c', 'check_for_update_on_startup=false']);
  assert.deepEqual(launch.tuiArgs, ['hi']);
});
