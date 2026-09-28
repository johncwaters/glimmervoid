import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawn, execFileAsync } from '../server/child-process-safe.ts';
import { isContainedReviewDirectory, parseCwdTable, parseProcessTable, protectedProcessIds, selectTeamReviewProcessIds } from '../server/core/team-review-reaper-core.ts';
import type { ProcessRow } from '../server/core/team-review-reaper-core.ts';
import { listTeamReviewProcesses, reapTeamReviewProcesses } from '../server/team-review-reaper.ts';

const SIGNED_BASH_ARGS = 'bash -c source /home/op/.claude/shell-snapshots/snapshot-bash-1.sh && eval npm test';

function processRow(pid: number, ppid: number, args = 'bash', cwd: string | null = null): ProcessRow {
  return { pid, ppid, args, cwd };
}

test('process table parsing reads pid, parent pid and full arguments', () => {
  assert.deepEqual(parseProcessTable(' 12  1 /usr/lib/systemd/systemd --user\n 15 12 /Applications/Some App/bin -c x\n 16 15\nnoise\n'), [
    processRow(12, 1, '/usr/lib/systemd/systemd --user'),
    processRow(15, 12, '/Applications/Some App/bin -c x'),
    processRow(16, 15, ''),
  ]);
});

test('lsof cwd parsing associates cwd records with process ids', () => {
  assert.deepEqual(parseCwdTable('p12\nfcwd\nn/a/work-1\np13\nfcwd\nn/a/work-10\n'), new Map([[12, '/a/work-1'], [13, '/a/work-10']]));
});

test('an orphaned signed Bash leader is reaped with its descendants', () => {
  const rows = [
    processRow(10, 1, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(11, 10, 'node codex', '/a/work-1'),
    processRow(12, 11, 'codex-code-mode-host', '/a/work-1'),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], new Set()), [10, 11, 12]);
});

test('an orphaned daemon inside a review directory is spared with its children', () => {
  const rows = [
    processRow(30, 1, 'tmux new -d', '/a/work-1'),
    processRow(31, 30, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(32, 31, 'sleep 30', '/a/work-1'),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], new Set()), []);
});

test('a live session Bash leader is spared even with the signature and owned cwd', () => {
  const rows = [
    processRow(20, 1, 'claude -p', '/a/work-1'),
    processRow(21, 20, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(22, 21, 'node codex', '/a/work-1'),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], new Set()), []);
});

test('systemd subreaper children qualify as orphans', () => {
  const rows = [
    processRow(5, 1, '/usr/lib/systemd/systemd --user'),
    processRow(10, 5, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(11, 10, 'codex', '/a/work-1'),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], new Set()), [10, 11]);
});

test('owned cwd matching respects directory boundaries and includes descendants', () => {
  const rows = [
    processRow(10, 1, SIGNED_BASH_ARGS, '/a/work-10'),
    processRow(11, 1, SIGNED_BASH_ARGS, '/a/work-1/checkout/src'),
    processRow(12, 1, SIGNED_BASH_ARGS, '/a/elsewhere'),
    processRow(13, 1, SIGNED_BASH_ARGS),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], new Set()), [11]);
});

test('sweep roots include both work directories and checkouts', () => {
  const rows = [
    processRow(10, 1, SIGNED_BASH_ARGS, '/a/work/review-1'),
    processRow(11, 1, SIGNED_BASH_ARGS, '/a/trees/checkout-1/src'),
    processRow(12, 1, SIGNED_BASH_ARGS, '/a/work-evil/review-1'),
  ];
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work', '/a/trees'], new Set()), [10, 11]);
});

test('the caller and its ancestors are excluded from roots and propagation', () => {
  const rows = [
    processRow(1, 0, 'launchd'),
    processRow(20, 1, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(30, 20, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(40, 1, SIGNED_BASH_ARGS, '/a/work-1'),
    processRow(50, 30, 'sleep 30', '/a/work-1'),
  ];
  const protectedPids = protectedProcessIds(rows, 30);
  assert.deepEqual([...protectedPids], [30, 20, 1]);
  assert.deepEqual(selectTeamReviewProcessIds(rows, ['/a/work-1'], protectedPids), [40]);
});

test('empty process lists and empty directory lists select nothing', () => {
  assert.deepEqual(parseProcessTable(''), []);
  assert.deepEqual(selectTeamReviewProcessIds([], ['/a/work'], new Set()), []);
  assert.deepEqual(selectTeamReviewProcessIds([processRow(10, 1, SIGNED_BASH_ARGS, '/a/work')], [], new Set()), []);
});

test('per-run containment accepts only a direct child of a review root', () => {
  const reviewRoots = ['/home/op/team-review-work', '/home/op/team-review-worktrees'];
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work/review-1', reviewRoots, 'run'), true);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-worktrees/tree-1', reviewRoots, 'run'), true);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work/review-1/nested', reviewRoots, 'run'), false);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work', reviewRoots, 'run'), false);
  assert.equal(isContainedReviewDirectory('/home/op', reviewRoots, 'run'), false);
  assert.equal(isContainedReviewDirectory('/', reviewRoots, 'run'), false);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work-evil/review-1', reviewRoots, 'run'), false);
});

test('sweep containment accepts only a review root itself', () => {
  const reviewRoots = ['/home/op/team-review-work', '/home/op/team-review-worktrees'];
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work', reviewRoots, 'sweep'), true);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-worktrees', reviewRoots, 'sweep'), true);
  assert.equal(isContainedReviewDirectory('/home/op/team-review-work/review-1', reviewRoots, 'sweep'), false);
  assert.equal(isContainedReviewDirectory('/home/op', reviewRoots, 'sweep'), false);
});

test('the platform process list includes this process', { skip: process.platform === 'win32' }, async () => {
  const rows = await listTeamReviewProcesses();
  assert.ok(rows.some((row) => row.pid === process.pid && row.cwd === process.cwd()));
});

async function waitFor<T>(readValue: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for process state');
}

function isOrphanParent(rows: readonly { pid: number; args: string }[], parentPid: number): boolean {
  if (parentPid === 1) return true;
  const parentCommand = rows.find((row) => row.pid === parentPid)?.args.split(' ')[0] ?? '';
  return path.basename(parentCommand) === 'systemd';
}

async function isProcessActive(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).catch(() => ({ stdout: '' }));
  const state = stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

async function spawnDetachedShell(cwd: string, script: string): Promise<{ leaderPid: number; groupPid: number }> {
  const launcher = spawn('bash', ['-c', 'bash -c "$0" </dev/null >/dev/null 2>&1 & echo $!', script], { cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const groupPid = launcher.pid;
  assert.ok(groupPid);
  let launcherOutput = '';
  launcher.stdout?.on('data', (chunk: Buffer) => { launcherOutput += chunk.toString('utf8'); });
  await new Promise<void>((resolve) => launcher.on('close', () => resolve()));
  const leaderPid = Number(launcherOutput.trim());
  assert.ok(leaderPid > 0);
  return { leaderPid, groupPid };
}

function killProcessGroup(groupPid: number): void {
  try {
    process.kill(-groupPid, 'SIGKILL');
  } catch (error) {
    assert.equal(typeof error === 'object' && error !== null && 'code' in error ? error.code : null, 'ESRCH');
  }
}

test('reaper kills only an orphaned signed tree and spares an unsigned survivor in the same review dir', { skip: process.platform === 'win32' }, async () => {
  const reviewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-review-reap-root-'));
  const ownedDirectory = path.join(reviewRoot, 'owned');
  await fs.mkdir(ownedDirectory);
  const signed = await spawnDetachedShell(ownedDirectory, ': /.claude/shell-snapshots/snapshot-probe; sleep 30 & wait');
  const unsigned = await spawnDetachedShell(ownedDirectory, 'sleep 30 & wait');
  try {
    const childPid = await waitFor(async () => {
      const rows = await listTeamReviewProcesses();
      const leader = rows.find((row) => row.pid === signed.leaderPid);
      if (!leader || !isOrphanParent(rows, leader.ppid)) return null;
      return rows.find((row) => row.ppid === signed.leaderPid)?.pid ?? null;
    });
    const warnings: string[] = [];
    await reapTeamReviewProcesses({ ownedDirectories: [ownedDirectory], reviewRoots: [reviewRoot], scope: 'run', log: { warn: (message) => warnings.push(message) } });
    await waitFor(async () => !(await isProcessActive(signed.leaderPid)) && !(await isProcessActive(childPid)) ? true : null);
    assert.equal(await isProcessActive(unsigned.leaderPid), true);
    assert.deepEqual(warnings, ['[team-review] reaped 2 review processes']);
  } finally {
    killProcessGroup(signed.groupPid);
    killProcessGroup(unsigned.groupPid);
    await fs.rm(reviewRoot, { recursive: true, force: true });
  }
});

test('reaper rejects a per-run directory symlink outside the review roots', { skip: process.platform === 'win32' }, async () => {
  const reviewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-review-reap-root-'));
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'team-review-reap-outside-'));
  const linkedDirectory = path.join(reviewRoot, 'linked');
  await fs.symlink(outsideDirectory, linkedDirectory);
  try {
    const warnings: string[] = [];
    await reapTeamReviewProcesses({ ownedDirectories: [linkedDirectory], reviewRoots: [reviewRoot], scope: 'run', log: { warn: (message) => warnings.push(message) } });
    assert.deepEqual(warnings, [`[team-review] skipped reaping ${await fs.realpath(outsideDirectory)}: it resolves outside the review roots`]);
  } finally {
    await Promise.all([fs.rm(reviewRoot, { recursive: true, force: true }), fs.rm(outsideDirectory, { recursive: true, force: true })]);
  }
});
