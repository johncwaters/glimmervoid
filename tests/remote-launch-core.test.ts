import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from '../server/child-process-safe.ts';
import {
  CLAUDE_TOKEN_ALIAS_ENV, CLAUDE_TOKEN_ALIASES, remoteLaunchScript,
} from '../session/core/remote-launch-core.ts';

const HOSTILE_ARGUMENTS = ["it's", 'two words', '$HOME', '"quoted"', '`id`', '; rm -rf nowhere', 'back\\slash', ''];

test('a remote launch script run by a real shell exports the aliased token, drops the alias and execs the exact argv in the working directory', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "gv remote 'launch' "));
  try {
    const script = remoteLaunchScript({
      workingDirectory,
      argv: ['sh', '-c', 'pwd -P; printf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN" "${GV_CLAUDE_TOKEN-unset}"; printf "[%s]\\n" "$@"', 'sh', ...HOSTILE_ARGUMENTS],
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
