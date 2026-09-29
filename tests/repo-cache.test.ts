import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createRepoCache } from '../server/repo-cache.ts';
import type { CommandRunner } from '../server/repo-cache.ts';

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
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
    assert.deepEqual(await cache.fetchPr('Acme/repo', 1, 'main'), { ok: true, headSha: expectedHead, err: '' });
    assert.deepEqual(await cache.hydrateRange('Acme/repo', 1, expectedHead), { ok: true, err: '' });
    assert.deepEqual(calls, [
      ['clone', '--filter=blob:none', '--no-checkout', originDir, repoDir],
      ['fetch', '--filter=blob:none', 'origin', '+refs/pull/1/head:refs/glimmervoid-pr/1', '+refs/heads/main:refs/glimmervoid-base/1'],
      ['rev-parse', 'refs/glimmervoid-pr/1'],
      ['diff', '--shortstat', `refs/glimmervoid-base/1...${expectedHead}`],
    ]);
    assert.deepEqual(envs, [{ GIT_TERMINAL_PROMPT: '0' }, { GIT_TERMINAL_PROMPT: '0' }, undefined, { GIT_TERMINAL_PROMPT: '0' }]);
    assert.equal(await cache.ensureRepo('../repo'), null);
    assert.deepEqual(await cache.fetchPr('Acme/repo/other', 1, 'main'), { ok: false, headSha: null, err: '' });
    assert.deepEqual(await cache.fetchPr('Acme/repo', 1, '../main'), { ok: false, headSha: null, err: '' });
    assert.deepEqual(await cache.hydrateRange('Acme/repo', 1, '--output=/tmp/x'), { ok: false, err: '' });
    assert.deepEqual(await cache.hydrateRange('Acme/repo', 0, expectedHead), { ok: false, err: '' });
    const missingBase = await cache.hydrateRange('Acme/repo', 2, expectedHead);
    assert.equal(missingBase.ok, false);
    assert.match(missingBase.err, /unknown revision or path/);
    assert.equal(calls.length, 5);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('repo cache returns git fetch and hydration errors', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-repo-cache-errors-'));
  try {
    await mkdir(path.join(tempDir, 'Acme', 'repo', '.git'), { recursive: true });
    const cache = createRepoCache({
      rootDir: tempDir,
      commandRunner: async (args) => ({ ok: false, out: '', err: args[0] === 'fetch' ? 'fatal: fetch denied' : 'fatal: blob missing' }),
    });
    const head = 'a'.repeat(40);
    assert.deepEqual(await cache.fetchPr('Acme/repo', 1, 'main'), { ok: false, headSha: null, err: 'fatal: fetch denied' });
    assert.deepEqual(await cache.hydrateRange('Acme/repo', 1, head), { ok: false, err: 'fatal: blob missing' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('repo cache lists only the owner/name directories that hold a git clone', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-repo-cache-list-'));
  try {
    const cacheRoot = path.join(tempDir, 'cache');
    const cache = createRepoCache({ rootDir: cacheRoot });
    assert.deepEqual(await cache.listRepos(), []);
    await mkdir(path.join(cacheRoot, 'Acme', 'app', '.git'), { recursive: true });
    await mkdir(path.join(cacheRoot, 'Acme', 'half-cloned'), { recursive: true });
    await mkdir(path.join(cacheRoot, 'Other', 'lib', '.git'), { recursive: true });
    await writeFile(path.join(cacheRoot, 'Acme', 'stray-file'), 'x');
    await mkdir(path.join(tempDir, 'elsewhere', '.git'), { recursive: true });
    await symlink(path.join(tempDir, 'elsewhere'), path.join(cacheRoot, 'Acme', 'linked'));
    const listed = (await cache.listRepos()).sort();
    assert.deepEqual(listed, [path.join(cacheRoot, 'Acme', 'app'), path.join(cacheRoot, 'Other', 'lib')]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('repo cache hydrates the range since an earlier head only for two commit SHAs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-repo-cache-since-'));
  try {
    await mkdir(path.join(tempDir, 'Acme', 'repo', '.git'), { recursive: true });
    const calls: string[][] = [];
    let isDiffOk = true;
    const isSinceAncestor = true;
    const cache = createRepoCache({
      rootDir: tempDir,
      commandRunner: async (args) => {
        calls.push(args);
        const ok = args[0] === 'merge-base' ? isSinceAncestor : isDiffOk;
        return { ok, out: '', err: '' };
      },
    });
    const since = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    assert.equal(await cache.hydrateSince('Acme/repo', since, head), true);
    assert.deepEqual(calls, [['diff', '--shortstat', since, head], ['merge-base', '--is-ancestor', since, head]]);
    assert.equal(await cache.hydrateSince('Acme/repo', '--output=/tmp/x', head), false);
    assert.equal(await cache.hydrateSince('../repo', since, head), false);
    assert.equal(calls.length, 2);
    isDiffOk = false;
    assert.equal(await cache.hydrateSince('Acme/repo', since, head), false);
    assert.equal(calls.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('repo cache refuses the range since an earlier head that a force-push left off the new history', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-repo-cache-rebased-'));
  try {
    const repoDir = path.join(tempDir, 'Acme', 'repo');
    await mkdir(repoDir, { recursive: true });
    await git(['init'], repoDir);
    await git(['config', 'user.name', 'Test'], repoDir);
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await writeFile(path.join(repoDir, 'README.md'), 'base\n');
    await git(['add', 'README.md'], repoDir);
    await git(['commit', '-m', 'base'], repoDir);
    const baseSha = await git(['rev-parse', 'HEAD'], repoDir);
    await writeFile(path.join(repoDir, 'README.md'), 'base\nfirst push\n');
    await git(['commit', '-am', 'first push'], repoDir);
    const firstPushSha = await git(['rev-parse', 'HEAD'], repoDir);
    await writeFile(path.join(repoDir, 'README.md'), 'base\nsecond push\n');
    await git(['commit', '-am', 'second push'], repoDir);
    const fastForwardSha = await git(['rev-parse', 'HEAD'], repoDir);
    await git(['reset', '--hard', baseSha], repoDir);
    await writeFile(path.join(repoDir, 'README.md'), 'base\nrebased\n');
    await git(['commit', '-am', 'rebased'], repoDir);
    const rebasedSha = await git(['rev-parse', 'HEAD'], repoDir);
    const commandRunner: CommandRunner = async (args, cwd) => {
      try {
        return { ok: true, out: await git(args, cwd), err: '' };
      } catch (error) {
        return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
      }
    };
    const cache = createRepoCache({ rootDir: tempDir, commandRunner });
    assert.equal(await cache.hydrateSince('Acme/repo', firstPushSha, fastForwardSha), true);
    assert.equal(await cache.hydrateSince('Acme/repo', firstPushSha, rebasedSha), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
