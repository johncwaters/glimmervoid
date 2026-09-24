import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createRepoCache } from '../server/repo-cache.ts';
import type { CommandRunner } from '../server/repo-cache.ts';

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

test('repo cache clones once and fetches a PR head from a local bare origin', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-repo-cache-'));
  try {
    const originDir = path.join(tempDir, 'origin.git');
    const sourceDir = path.join(tempDir, 'source');
    const cacheRoot = path.join(tempDir, 'cache');
    await git(['init', '--bare', originDir], tempDir);
    await git(['init', sourceDir], tempDir);
    await git(['config', 'user.name', 'Test'], sourceDir);
    await git(['config', 'user.email', 'test@example.com'], sourceDir);
    await writeFile(path.join(sourceDir, 'README.md'), 'base\n');
    await git(['add', 'README.md'], sourceDir);
    await git(['commit', '-m', 'base'], sourceDir);
    await git(['remote', 'add', 'origin', originDir], sourceDir);
    await git(['push', 'origin', 'HEAD:refs/heads/main'], sourceDir);
    await writeFile(path.join(sourceDir, 'README.md'), 'base\nchange\n');
    await git(['commit', '-am', 'change'], sourceDir);
    const expectedHead = await git(['rev-parse', 'HEAD'], sourceDir);
    await git(['push', 'origin', 'HEAD:refs/pull/1/head'], sourceDir);
    const calls: string[][] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const commandRunner: CommandRunner = async (args, cwd, env) => {
      calls.push(args);
      envs.push(env);
      try {
        return { ok: true, out: await git(args, cwd), err: '' };
      } catch (error) {
        return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
      }
    };
    const cache = createRepoCache({ rootDir: cacheRoot, commandRunner, remoteUrlFor: () => originDir });
    const repoDir = path.join(cacheRoot, 'Acme', 'repo');
    assert.equal(await cache.ensureRepo('Acme/repo'), repoDir);
    assert.equal(await cache.ensureRepo('Acme/repo'), repoDir);
    assert.deepEqual(await cache.fetchPr('Acme/repo', 1, 'main'), { ok: true, headSha: expectedHead });
    assert.deepEqual(calls, [
      ['clone', '--filter=blob:none', '--no-checkout', originDir, repoDir],
      ['fetch', '--filter=blob:none', 'origin', '+refs/pull/1/head:refs/glimmervoid-pr/1', '+refs/heads/main:refs/glimmervoid-base/1'],
      ['rev-parse', 'refs/glimmervoid-pr/1'],
    ]);
    assert.deepEqual(envs, [{ GIT_TERMINAL_PROMPT: '0' }, { GIT_TERMINAL_PROMPT: '0' }, undefined]);
    assert.equal(await cache.ensureRepo('../repo'), null);
    assert.deepEqual(await cache.fetchPr('Acme/repo/other', 1, 'main'), { ok: false, headSha: null });
    assert.deepEqual(await cache.fetchPr('Acme/repo', 1, '../main'), { ok: false, headSha: null });
    assert.equal(calls.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
