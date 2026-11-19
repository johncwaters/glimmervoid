import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVerificationWiring } from '../server/verification/verification-wiring.ts';
import { VerificationRun, VerificationSettings } from '../shared/contracts/verification.ts';

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repoPath }).toString().trim();
}

function writeFiles(repoPath: string, contentByPath: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(contentByPath)) {
    fs.mkdirSync(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(repoPath, relativePath), content);
  }
}

test('Keeps every test reports only net removals and skips, at their real path and line, whatever the diff config, attributes or base, in a spawned child whose repo has an invalid verification entry', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-test-keeping-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ['init', '--quiet']);
  git(repoPath, ['config', 'diff.mnemonicPrefix', 'true']);
  writeFiles(repoPath, {
    'tests/edited.test.ts': "test('adds', () => {\n  assert.equal(total, 2);\n});\n",
    'tests/test_units.py': 'def test_units(self):\n    self.assertEqual(units, 3)\n    self.assertTrue(ok)\n',
    'tests/named.test.ts': "test('named', () => {\n  strictEqual(a, 1);\n});\n",
    'tests/b.sql.test': 'x: 1\n-- note\nassert(ok)\n',
    'tests/skipped.test.ts': "test('later', () => {});\n",
    'tests/moved.test.ts': "test('moves', () => {\n  assert.ok(moved);\n});\n",
    'tests/hidden.test.ts': "test('hidden', () => {\n  assert.ok(seen);\n});\n",
  });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  git(repoPath, ['branch', 'integration']);
  fs.renameSync(path.join(repoPath, 'tests/moved.test.ts'), path.join(repoPath, 'tests/renamed.test.ts'));
  fs.writeFileSync(path.join(repoPath, '.gitattributes'), 'tests/hidden.test.ts -diff\n');
  writeFiles(repoPath, {
    'tests/edited.test.ts': "test('adds two', () => {\n  assert.equal(total, 3);\n});\n",
    'tests/test_units.py': 'def test_units(self):\n    self.assertTrue(ok)\n',
    'tests/named.test.ts': "test('named', () => {\n});\n",
    'tests/b.sql.test': 'x: 1\n',
    'tests/skipped.test.ts': "test.skip('later', () => {});\n",
    'tests/hidden.test.ts': "test('hidden', () => {\n});\n",
  });

  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'node', command: 'node --version' }], typo: true } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    logger: console,
  });
  verification.attachSession({
    id: 'test-keeping',
    path: repoPath,
    ephemeral: true,
    ownerId: 'parent',
    agentDoneLines: [],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event, listener) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: 'turn-1', dirty: true, headSha: 'unused' }),
      snapshot: () => ({ baseSha: null, effectiveBase: 'integration' }),
      setMergeGate: () => {},
    },
  });
  onTurnEnd();
  const deadline = Date.now() + 20_000;
  while ((verification.latestRun('test-keeping')?.status ?? 'running') === 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(verification.latestRun('test-keeping')?.checks.map((check) => `${check.id} ${check.status}`), ['verification-config fail']);
  const reported = (verification.latestRun('test-keeping')?.removedTestLines ?? []).map((removed) => `${removed.kind} ${removed.path}:${removed.line} ${removed.text}`);
  assert.deepEqual(reported.sort(), [
    'added-skip tests/skipped.test.ts:1 test.skip(\'later\', () => {});',
    'removed-assertion tests/b.sql.test:3 assert(ok)',
    'removed-assertion tests/hidden.test.ts:2 assert.ok(seen);',
    'removed-assertion tests/named.test.ts:2 strictEqual(a, 1);',
    'removed-assertion tests/test_units.py:2 self.assertEqual(units, 3)',
  ]);
});

test('the newest turn end decides the verdict: an unreadable tree shows skipped checks, a slower earlier run never overwrites it, and a readable turn shows its run again', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-test-keeping-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoPath, 'slow.js'), 'setTimeout(() => process.exit(1), 1500);\n');
  const broadcastRuns: VerificationRun[] = [];
  const gateTrees = [{ sig: 'turn-1', dirty: true, headSha: 'unused' }, null, { sig: 'turn-1', dirty: true, headSha: 'unused' }];
  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'slow', command: 'node slow.js' }] } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: (message) => { if (message.type === 'verification-run') broadcastRuns.push(VerificationRun.parse(message.run)); },
    logger: console,
  });
  verification.attachSession({
    id: 'unread-tree',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event, listener) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => gateTrees.shift() ?? null,
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownVerdict = () => broadcastRuns.at(-1)?.checks.map((check) => check.status);

  onTurnEnd();
  await sleep(200);
  onTurnEnd();
  await sleep(3000);
  assert.deepEqual(shownVerdict(), ['skipped'], 'the earlier turn run finishing late does not replace the newer skipped verdict');
  assert.deepEqual(verification.latestRun('unread-tree')?.checks.map((check) => check.status), ['skipped'], 'a reopened panel gets the verdict last shown');
  onTurnEnd();
  await sleep(500);
  assert.deepEqual(shownVerdict(), ['fail'], 'a readable turn end on the same tree shows its cached run again');
});

test('an agent command runs at turn end with no operator step, reruns when changed, refuses a risky command however it arrived, and never fails the repo checks or takes a repo check id', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agent-commands-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ['init', '--quiet']);
  writeFiles(repoPath, { 'README.md': 'base\n' });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const broadcastRuns: VerificationRun[] = [];
  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'node', command: 'node --version' }], gate: { enabled: true } } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: (message) => { if (message.type === 'verification-run') broadcastRuns.push(VerificationRun.parse(message.run)); },
    logger: console,
  });
  assert.throws(() => VerificationSettings.parse({ checks: [{ id: 'agent-done-1', command: 'node --version' }] }));
  const session = {
    id: 'agent-commands',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [{ text: 'node runs', command: 'node --version' }],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event: 'post-turn-check', listener: () => void) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: 'tree', dirty: false, headSha: 'unused' }),
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  };
  verification.attachSession(session);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownAgentChecks = () => broadcastRuns.at(-1)?.checks.map((check) => `${check.id} ${check.status}`);

  onTurnEnd();
  await sleep(1500);
  assert.deepEqual(shownAgentChecks(), ['node pass', 'agent-done-1 pass']);
  session.agentDoneLines = [{ text: 'node fails', command: 'node --check missing-entry.js' }];
  onTurnEnd();
  await sleep(1500);
  assert.deepEqual(shownAgentChecks(), ['node pass', 'agent-done-1 fail']);
  assert.equal(broadcastRuns.at(-1)?.status, 'passed', 'a failing agent command leaves the repo checks passed');
  session.agentDoneLines = [{ text: 'restored from a saved session', command: 'git reset --hard HEAD' }];
  onTurnEnd();
  await sleep(1500);
  const refusedCheck = broadcastRuns.at(-1)?.checks.find((check) => check.id === 'agent-done-1');
  assert.equal(refusedCheck?.status, 'fail');
  assert.match(refusedCheck?.outputTail ?? '', /Sane YOLO refused to run it/);
});
