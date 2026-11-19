import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVerificationWiring } from '../server/verification/verification-wiring.ts';

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repoPath }).toString().trim();
}

function writeFiles(repoPath: string, contentByPath: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(contentByPath)) {
    fs.mkdirSync(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(repoPath, relativePath), content);
  }
}

test('Keeps every test reports only net removals and skips, at their real path and line, whatever the diff prefix config', async (context) => {
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
  });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(repoPath, ['rev-parse', 'HEAD']);
  writeFiles(repoPath, {
    'tests/edited.test.ts': "test('adds two', () => {\n  assert.equal(total, 3);\n});\n",
    'tests/test_units.py': 'def test_units(self):\n    self.assertTrue(ok)\n',
    'tests/named.test.ts': "test('named', () => {\n});\n",
    'tests/b.sql.test': 'x: 1\n',
    'tests/skipped.test.ts': "test.skip('later', () => {});\n",
  });

  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'node', command: 'node --version' }] } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    logger: console,
  });
  verification.attachSession({
    id: 'test-keeping',
    path: repoPath,
    ephemeral: false,
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event, listener) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: 'turn-1', dirty: true, headSha: baseSha }),
      snapshot: () => ({ baseSha }),
      setMergeGate: () => {},
    },
  });
  onTurnEnd();
  const deadline = Date.now() + 20_000;
  while (verification.latestRun('test-keeping') === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

  const reported = (verification.latestRun('test-keeping')?.removedTestLines ?? []).map((removed) => `${removed.kind} ${removed.path}:${removed.line} ${removed.text}`);
  assert.deepEqual(reported.sort(), [
    'added-skip tests/skipped.test.ts:1 test.skip(\'later\', () => {});',
    'removed-assertion tests/b.sql.test:3 assert(ok)',
    'removed-assertion tests/named.test.ts:2 strictEqual(a, 1);',
    'removed-assertion tests/test_units.py:2 self.assertEqual(units, 3)',
  ]);
});
