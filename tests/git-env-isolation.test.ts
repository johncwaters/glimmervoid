import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FALLBACK_GIT_LOCAL_ENV_VARS } from '../harness/support/git-local-env.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const COMMITTING_TEST_PATH = 'tests/session-workspace-members.test.ts';

function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createScratchRepo(): { repoDir: string; gitDir: string; indexFile: string; refsBefore: string; configBefore: Buffer } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-git-env-scratch-'));
  gitIn(repoDir, ['init', '-b', 'main']);
  gitIn(repoDir, ['config', 'user.name', 'Scratch Owner']);
  gitIn(repoDir, ['config', 'user.email', 'scratch@example.invalid']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'scratch\n', 'utf8');
  gitIn(repoDir, ['add', 'README.md']);
  gitIn(repoDir, ['commit', '-m', 'scratch initial']);
  const gitDir = path.join(repoDir, '.git');
  const indexFile = path.join(gitDir, 'index');
  const refsBefore = gitIn(repoDir, ['for-each-ref']);
  const configBefore = fs.readFileSync(path.join(gitDir, 'config'));
  return { repoDir, gitDir, indexFile, refsBefore, configBefore };
}

test('test-covering and isolate-home ignore inherited GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE', () => {
  const scratch = createScratchRepo();
  try {
    const poisonedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: scratch.gitDir,
      GIT_WORK_TREE: scratch.repoDir,
      GIT_INDEX_FILE: scratch.indexFile,
    };

    const coveringRun = spawnSync(
      process.execPath,
      ['scripts/test-covering.ts', '--changed', COMMITTING_TEST_PATH, '--no-gates'],
      { cwd: REPO_ROOT, env: poisonedEnv, encoding: 'utf8' },
    );
    assert.equal(coveringRun.status, 0, `test-covering exited ${coveringRun.status}:\n${coveringRun.stdout}\n${coveringRun.stderr}`);
    assert.match(coveringRun.stdout, /ran [1-9]\d* test file\(s\)/, `test-covering must actually run the selected test:\n${coveringRun.stdout}`);
    assert.equal(gitIn(scratch.repoDir, ['for-each-ref']), scratch.refsBefore, 'test-covering must not mutate scratch repo refs');
    assert.deepEqual(fs.readFileSync(path.join(scratch.gitDir, 'config')), scratch.configBefore, 'test-covering must not mutate scratch repo config');

    const directRun = spawnSync(
      process.execPath,
      ['--import', './tests/helpers/isolate-home.ts', '--test', COMMITTING_TEST_PATH],
      { cwd: REPO_ROOT, env: poisonedEnv, encoding: 'utf8' },
    );
    assert.equal(directRun.status, 0, `direct isolate-home run exited ${directRun.status}:\n${directRun.stdout}\n${directRun.stderr}`);
    assert.equal(gitIn(scratch.repoDir, ['for-each-ref']), scratch.refsBefore, 'direct isolate-home run must not mutate scratch repo refs');
    assert.deepEqual(fs.readFileSync(path.join(scratch.gitDir, 'config')), scratch.configBefore, 'direct isolate-home run must not mutate scratch repo config');
  } finally {
    fs.rmSync(scratch.repoDir, { recursive: true, force: true });
  }
});

test('createProject ignores inherited GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE', () => {
  const scratch = createScratchRepo();
  const projectWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-create-project-scratch-'));
  try {
    const poisonedEnvs: Array<{ label: string; env: NodeJS.ProcessEnv }> = [
      {
        label: 'GIT_DIR + GIT_INDEX_FILE',
        env: { ...process.env, GIT_DIR: scratch.gitDir, GIT_INDEX_FILE: scratch.indexFile },
      },
      {
        label: 'GIT_DIR + GIT_WORK_TREE + GIT_INDEX_FILE',
        env: { ...process.env, GIT_DIR: scratch.gitDir, GIT_WORK_TREE: scratch.repoDir, GIT_INDEX_FILE: scratch.indexFile },
      },
    ];

    for (const [index, { label, env }] of poisonedEnvs.entries()) {
      const probeScript = [
        "const { createProject } = await import('./harness/site-capture/isolated-glimmervoid.ts');",
        `await createProject(${JSON.stringify(projectWorkDir)}, 'scratch-demo-${index}');`,
      ].join(' ');
      const createProjectRun = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', probeScript],
        { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(createProjectRun.status, 0, `createProject (${label}) exited ${createProjectRun.status}:\n${createProjectRun.stdout}\n${createProjectRun.stderr}`);
      assert.equal(gitIn(scratch.repoDir, ['for-each-ref']), scratch.refsBefore, `createProject (${label}) must not mutate scratch repo refs`);
      assert.deepEqual(fs.readFileSync(path.join(scratch.gitDir, 'config')), scratch.configBefore, `createProject (${label}) must not mutate scratch repo config`);
    }
  } finally {
    fs.rmSync(scratch.repoDir, { recursive: true, force: true });
    fs.rmSync(projectWorkDir, { recursive: true, force: true });
  }
});

test('fallback git local-env-vars list matches git rev-parse --local-env-vars', () => {
  const fromGit = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
  assert.deepEqual([...FALLBACK_GIT_LOCAL_ENV_VARS].sort(), fromGit);
});
