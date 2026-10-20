import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from '../server/child-process-safe.ts';
import {
  CLAUDE_TOKEN_ALIAS_ENV, CLAUDE_TOKEN_ALIASES, coderCreateArgs, coderSshArgs, encodeCoderSshEnv, remoteLaunchScript, workspaceNameFromHex,
} from '../session/core/remote-launch-core.ts';

const HOSTILE_ARGUMENTS = ["it's", 'two words', '$HOME', '"quoted"', '`id`', '; rm -rf nowhere', 'back\\slash', ''];

test('a remote launch script run by a real shell exports the aliased token, drops the alias and execs the exact argv in the working directory', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gv remote 'launch' "));
  try {
    const script = remoteLaunchScript({
      workingDirectory,
      argv: ['sh', '-c', 'pwd; printf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN" "${GV_CLAUDE_TOKEN-unset}"; printf "[%s]\\n" "$@"', 'sh', ...HOSTILE_ARGUMENTS],
      tokenAliases: CLAUDE_TOKEN_ALIASES,
    });
    assert.ok(script);
    const output = execFileSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_OAUTH_TOKEN: '', [CLAUDE_TOKEN_ALIAS_ENV]: 'token-value' },
    });
    assert.deepEqual(output.split('\n').slice(0, -1), [
      await realpath(workingDirectory), 'token-value', 'unset', ...HOSTILE_ARGUMENTS.map((argument) => `[${argument}]`),
    ]);
    assert.equal(script.includes('token-value'), false);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test('CODER_SSH_ENV quotes each whole K=V field so a comma or quote in a value cannot split it', () => {
  assert.equal(encodeCoderSshEnv({ GV_CLAUDE_TOKEN: 'a,b', NOTE: 'say "hi"' }), '"GV_CLAUDE_TOKEN=a,b","NOTE=say ""hi"""');
  assert.equal(encodeCoderSshEnv({ 'BAD KEY': 'x' }), null);
  assert.equal(encodeCoderSshEnv({ TOKEN: 'line\nbreak' }), null);
});

test('coder argv refuses a workspace name outside gv-<12 hex> and never carries an env value', () => {
  const workspace = workspaceNameFromHex('0123456789AB');
  assert.equal(workspace, 'gv-0123456789ab');
  assert.equal(workspaceNameFromHex('xyz'), null);
  assert.equal(coderSshArgs({ workspace: 'devbox-main', remotePort: 7000, ingressPort: 7001, remoteCommand: 'true' }), null);
  assert.deepEqual(coderSshArgs({ workspace: 'gv-0123456789ab', remotePort: 7000, ingressPort: 7001, remoteCommand: 'true' }), [
    'ssh', 'gv-0123456789ab', '--tty', '--remote-forward', '7000:127.0.0.1:7001', '--wait', 'no', '--', 'true',
  ]);
  const createArgs = coderCreateArgs({ workspace: 'gv-0123456789ab', template: 'linux', stopAfter: '4h', parameters: { region: 'us,east' } });
  assert.deepEqual(createArgs, [
    'create', 'gv-0123456789ab', '--template', 'linux', '--preset', 'none', '--stop-after', '4h', '--parameter', '"region=us,east"', '--yes',
  ]);
});
