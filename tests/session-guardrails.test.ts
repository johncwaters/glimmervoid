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
  const prepare = sessionGuardrails.prepareFor({ sessionId: 'main-checkout-proof', isWorkspace: false, vendor: 'claude' });
  assert.ok(prepare);
  const prepared = await prepare({ launchId: 'main-checkout-proof', cwd: sessionWorktree, hookPort: null, readablePaths: [], writablePaths: [sessionWorktree], agentSessionId: null });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  context.after(() => prepared.launch.dispose());
  const identity = 'git -c user.name=t -c user.email=t@t';
  const commandByProbe = {
    mainJournalAppend: `printf stray >> ${mainCheckout}/.coherence/journal.jsonl`,
    mainLedgerCreate: `printf stray > ${mainCheckout}/.coherence/defect.jsonl`,
    mainCommit: `git -C ${mainCheckout} rm --quiet --cached .gitignore && ${identity} -C ${mainCheckout} commit --quiet -m stray`,
    mainIgnoredWrite: `printf cache > ${mainCheckout}/node_modules/probe`,
    ownFileWrite: 'printf own > own.txt',
    ownCommitAndPush: `printf second >> .coherence/journal.jsonl && ${identity} commit --quiet -am own && git push --quiet origin session-branch:main`,
  };
  const probeScript = Object.entries(commandByProbe).map(([probe, command]) => `(${command}) >&2; echo "${probe}=$?"`).join('\n');
  const wrapped = await prepared.launch.wrap('/bin/sh', ['-c', probeScript], { hasTerminal: false });
  const ran = spawnSync(wrapped.file, wrapped.args, { cwd: sessionWorktree, env: { ...process.env, ...prepared.launch.env }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const exitStatusByProbe = Object.fromEntries([...ran.stdout.matchAll(/^(\w+)=(\d+)$/gm)].map(([, probe, status]) => [probe, Number(status)]));
  const isRefused = (status: number | undefined) => status !== undefined && status !== 0;
  assert.equal(isRefused(exitStatusByProbe.mainJournalAppend), true, ran.stderr);
  assert.equal(isRefused(exitStatusByProbe.mainLedgerCreate), true, ran.stderr);
  assert.equal(isRefused(exitStatusByProbe.mainCommit), true, ran.stderr);
  assert.deepEqual([exitStatusByProbe.mainIgnoredWrite, exitStatusByProbe.ownFileWrite, exitStatusByProbe.ownCommitAndPush], [0, 0, 0], ran.stderr);

  assert.equal(await readFile(path.join(mainCheckout, '.coherence', 'journal.jsonl'), 'utf8'), 'first\n');
  assert.equal(git(mainCheckout, ['status', '--porcelain', '--untracked-files=no']), '');
  assert.equal(git(origin, ['rev-parse', 'main']), git(sessionWorktree, ['rev-parse', 'HEAD']));
});
