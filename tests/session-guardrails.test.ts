import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createSessionGuardrails } from '../server/guardrails/session-guardrails.ts';

function linuxSandboxSkipReason(): string | false {
  if (process.platform !== 'linux') return 'this proof runs the bubblewrap launch';
  const { errors } = SandboxManager.checkDependencies();
  return errors.length === 0 ? false : errors.join('; ');
}

function git(cwd: string, args: string[]): string {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, `git ${args.join(' ')}: ${ran.stderr}`);
  return ran.stdout;
}

test('a guarded session in a linked worktree cannot edit or commit in the main checkout, yet commits and pushes its own branch', { skip: linuxSandboxSkipReason() }, async (context) => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'main-checkout-')));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const origin = path.join(fixture, 'origin.git');
  const mainCheckout = path.join(fixture, 'main');
  const sessionWorktree = path.join(fixture, 'session');
  git(fixture, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(fixture, ['clone', '--quiet', origin, mainCheckout]);
  await mkdir(path.join(mainCheckout, '.coherence'));
  await writeFile(path.join(mainCheckout, '.coherence', 'journal.jsonl'), 'first\n');
  await writeFile(path.join(mainCheckout, '.gitignore'), 'node_modules\n');
  await symlink(sessionWorktree, path.join(mainCheckout, 'session-link'));
  git(mainCheckout, ['add', '.']);
  git(mainCheckout, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed']);
  git(mainCheckout, ['push', '--quiet', 'origin', 'main']);
  await mkdir(path.join(mainCheckout, 'node_modules'));
  git(mainCheckout, ['worktree', 'add', '--quiet', '-b', 'session-branch', sessionWorktree]);

  const sessionGuardrails = createSessionGuardrails({
    getSettings: () => ({ blockedPaths: [], unreadablePaths: [] }), uploadsRoot: path.join(fixture, 'uploads'), readGithubToken: async () => null,
  });
  const prepare = sessionGuardrails.prepareFor({ sessionId: 'main-checkout-proof', isWorkspace: false });
  assert.ok(prepare);
  const prepared = await prepare({ launchId: 'main-checkout-proof', cwd: sessionWorktree, hookPort: null, readablePaths: [], writablePaths: [sessionWorktree], agentSessionId: null });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  context.after(() => prepared.launch.dispose());
  const runGuarded = async (script: string) => {
    const wrapped = await prepared.launch.wrap('/bin/sh', ['-c', script], { hasTerminal: false });
    return spawnSync(wrapped.file, wrapped.args, { cwd: sessionWorktree, env: { ...process.env, ...prepared.launch.env }, encoding: 'utf8' });
  };
  const identity = 'git -c user.name=t -c user.email=t@t';

  assert.notEqual((await runGuarded(`printf stray >> ${mainCheckout}/.coherence/journal.jsonl`)).status, 0);
  assert.notEqual((await runGuarded(`printf stray > ${mainCheckout}/.coherence/defect.jsonl`)).status, 0);
  assert.notEqual((await runGuarded(`git -C ${mainCheckout} rm --quiet --cached .gitignore && ${identity} -C ${mainCheckout} commit --quiet -m stray`)).status, 0);
  const ignoredWrite = await runGuarded(`printf cache > ${mainCheckout}/node_modules/probe`);
  assert.equal(ignoredWrite.status, 0, ignoredWrite.stderr);
  const ownFileWrite = await runGuarded('printf own > own.txt');
  assert.equal(ownFileWrite.status, 0, ownFileWrite.stderr);
  const ownWork = await runGuarded(`printf second >> .coherence/journal.jsonl && ${identity} commit --quiet -am own && git push --quiet origin session-branch:main`);
  assert.equal(ownWork.status, 0, ownWork.stderr);

  assert.equal(await readFile(path.join(mainCheckout, '.coherence', 'journal.jsonl'), 'utf8'), 'first\n');
  assert.equal(git(mainCheckout, ['status', '--porcelain', '--untracked-files=no']), '');
  assert.equal(git(origin, ['rev-parse', 'main']), git(sessionWorktree, ['rev-parse', 'HEAD']));
});
