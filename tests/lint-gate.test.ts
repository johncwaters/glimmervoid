import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const BIOME_BIN = path.join(REPO_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

test('biome check reports no errors, matching the CI lint step', () => {
  const lintRun = spawnSync(process.execPath, [BIOME_BIN, 'check', '.', '--diagnostic-level=error', '--colors=off'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(lintRun.status, 0, `npm run lint fails in CI on these errors:\n${lintRun.stdout}${lintRun.stderr}`);
});
