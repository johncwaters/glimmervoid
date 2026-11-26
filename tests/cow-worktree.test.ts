import './helpers/isolate-home.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COW_TEMPLATE_DIR_NAME,
  filterIgnoredBuildDirs,
  isWarmStale,
  planCowWorktreeAdd,
  templatePathsFor,
  trackedAncestorDirsFrom,
} from '../server/git/core/cow-worktree-core.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

async function copyEntryForTest(sourcePath: string, destinationPath: string): Promise<boolean> {
  await fsp.cp(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true, force: true });
  return true;
}

function createTestRepo(rootDir: string, name = 'demo-repo'): string {
  const repoDir = path.join(rootDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitSync(repoDir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'target/\n.next/\n.claude/\n.env\nnode_modules/\ntracked-dir/ignored-sub/\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello cow\n');
  fs.mkdirSync(path.join(repoDir, 'tracked-dir'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'tracked-dir', 'kept.txt'), 'tracked\n');
  gitSync(repoDir, ['add', '.']);
  gitSync(repoDir, ['commit', '-m', 'initial']);
  return repoDir;
}

test('filterIgnoredBuildDirs keeps build caches and excludes secrets, tool config, node_modules, and tracked ancestors', () => {
  const trackedAncestors = trackedAncestorDirsFrom('tracked-dir/kept.txt\0nested/pkg/file.ts\0');
  const lsFilesOutput = [
    'target/',
    '.next/',
    '.uv-cache/',
    '.claude/',
    '.codex/',
    'node_modules/',
    'apps/web/node_modules/',
    '.env',
    'tracked-dir/',
    'tracked-dir/ignored-sub/',
    '',
  ].join('\0');

  assert.deepEqual(filterIgnoredBuildDirs(lsFilesOutput, undefined, trackedAncestors), [
    '.next',
    '.uv-cache',
    'target',
    'tracked-dir/ignored-sub',
  ]);
});

test('templatePathsFor isolates two repositories that share a directory basename', () => {
  const worktreeParent = '/tmp/worktrees';
  const firstPaths = templatePathsFor(worktreeParent, '/work/alpha/app/.git');
  const secondPaths = templatePathsFor(worktreeParent, '/work/beta/app/.git');
  assert.notEqual(firstPaths.templateDir, secondPaths.templateDir);
  assert.equal(path.dirname(firstPaths.templateDir), path.join(worktreeParent, COW_TEMPLATE_DIR_NAME));
});

test('isWarmStale and planCowWorktreeAdd enforce interval and fallback rules', () => {
  assert.equal(isWarmStale(null, 5000, 3600_000), true);
  assert.equal(isWarmStale(4000, 5000, 3600_000), false);
  assert.equal(isWarmStale(1000, 3601_000, 3600_000), true);
  assert.equal(isWarmStale(1000, 5000, 0), true);
  assert.equal(isWarmStale(null, 5000, Number.POSITIVE_INFINITY), false);

  assert.deepEqual(
    planCowWorktreeAdd({ platform: 'darwin', cowDisabled: true, hasSubmodules: false, canCloneCopyOnWrite: true }),
    { action: 'fallback', reason: 'disabled' },
  );
  assert.deepEqual(
    planCowWorktreeAdd({ platform: 'win32', cowDisabled: false, hasSubmodules: false, canCloneCopyOnWrite: true }),
    { action: 'fallback', reason: 'platform' },
  );
  assert.deepEqual(
    planCowWorktreeAdd({ platform: 'linux', cowDisabled: false, hasSubmodules: true, canCloneCopyOnWrite: true }),
    { action: 'fallback', reason: 'submodules' },
  );
  assert.deepEqual(
    planCowWorktreeAdd({ platform: 'linux', cowDisabled: false, hasSubmodules: false, canCloneCopyOnWrite: false }),
    { action: 'fallback', reason: 'no-copy-on-write' },
  );
});

test('createGitWorkspace clones tracked files and build caches via template, skips secrets and escaping symlinks, and warms template on merge teardown', async (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-cow-e2e-'));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const repoDir = createTestRepo(sandbox);
  const worktreeBase = path.join(sandbox, 'worktrees');

  fs.mkdirSync(path.join(repoDir, 'target', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'target', 'debug', 'artifact.bin'), 'v1-build');
  fs.mkdirSync(path.join(repoDir, '.next'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.next', 'cache.json'), '{"v":1}');
  fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), 'secret-agent-config');
  fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');

  fs.mkdirSync(path.join(repoDir, 'bad-cache'), { recursive: true });
  fs.appendFileSync(path.join(repoDir, '.gitignore'), 'bad-cache/\n');
  gitSync(repoDir, ['add', '.gitignore']);
  gitSync(repoDir, ['commit', '-m', 'ignore bad-cache']);
  fs.symlinkSync('/etc/hosts', path.join(repoDir, 'bad-cache', 'escape'));

  const clonedTargets: string[] = [];
  const gitWorkspace = createGitWorkspace({
    cow: {
      canClone: async () => true,
      cloneDir: async (src, dst) => {
        clonedTargets.push(dst);
        return copyEntryForTest(src, dst);
      },
      warmIntervalMs: 3600_000,
    },
  });

  const firstWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:first',
    teamId: 'session',
    label: 'first',
    worktreeBase,
  });
  assert.equal(firstWorkspace.isGit, true);
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, 'README.md'), 'utf8'), 'hello cow\n');
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, 'target', 'debug', 'artifact.bin'), 'utf8'), 'v1-build');
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, '.next', 'cache.json'), 'utf8'), '{"v":1}');
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, '.claude')), false);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, '.env')), false);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'bad-cache')), false);
  assert.equal(gitSync(firstWorkspace.cwd, ['status', '--porcelain']), '');
  assert.ok(clonedTargets.length > 0);

  fs.writeFileSync(path.join(firstWorkspace.cwd, 'feature.txt'), 'merged feature\n');
  fs.writeFileSync(path.join(firstWorkspace.cwd, 'target', 'debug', 'artifact.bin'), 'v2-merged-build');
  gitSync(firstWorkspace.cwd, ['add', 'feature.txt']);
  gitSync(firstWorkspace.cwd, ['commit', '-m', 'add feature']);

  const mergeOutcome = await gitWorkspace.mergeBack({
    projectPath: repoDir,
    workspace: firstWorkspace,
  });
  assert.equal(mergeOutcome.merged, true);

  const secondWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:second',
    teamId: 'session',
    label: 'second',
    worktreeBase,
  });
  assert.equal(secondWorkspace.isGit, true);
  assert.equal(fs.readFileSync(path.join(secondWorkspace.cwd, 'feature.txt'), 'utf8'), 'merged feature\n');
  assert.equal(fs.readFileSync(path.join(secondWorkspace.cwd, 'target', 'debug', 'artifact.bin'), 'utf8'), 'v2-merged-build');
});

test('createGitWorkspace falls back cleanly to plain git worktree add on GIT_COW=0, .gitmodules, and clone failure', async (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-cow-fallback-'));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const repoDir = createTestRepo(sandbox);
  const worktreeBase = path.join(sandbox, 'worktrees');

  const disabledWorkspace = createGitWorkspace({
    cow: {
      canClone: async () => true,
      cloneDir: copyEntryForTest,
      env: { GIT_COW: '0' },
    },
  });
  const disabledResult = await disabledWorkspace.create({
    projectPath: repoDir,
    owner: 'session:disabled',
    teamId: 'session',
    label: 'disabled',
    worktreeBase,
  });
  assert.equal(disabledResult.isGit, true);
  assert.equal(fs.existsSync(path.join(worktreeBase, COW_TEMPLATE_DIR_NAME)), false);

  const failingCloneWorkspace = createGitWorkspace({
    cow: {
      canClone: async () => true,
      cloneDir: async (_src, dst) => {
        if (!dst.includes(COW_TEMPLATE_DIR_NAME)) return false;
        return copyEntryForTest(_src, dst);
      },
    },
  });
  const recoveredResult = await failingCloneWorkspace.create({
    projectPath: repoDir,
    owner: 'session:recover',
    teamId: 'session',
    label: 'recover',
    worktreeBase,
  });
  assert.equal(recoveredResult.isGit, true);
  assert.equal(fs.readFileSync(path.join(recoveredResult.cwd, 'README.md'), 'utf8'), 'hello cow\n');

  fs.writeFileSync(path.join(repoDir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/sub.git\n');
  const submoduleWorkspace = createGitWorkspace({
    cow: {
      canClone: async () => true,
      cloneDir: async () => {
        throw new Error('clone should not run when .gitmodules exists');
      },
    },
  });
  const submoduleResult = await submoduleWorkspace.create({
    projectPath: repoDir,
    owner: 'session:sub',
    teamId: 'session',
    label: 'sub',
    worktreeBase,
  });
  assert.equal(submoduleResult.isGit, true);
});

test('createGitWorkspace blocks chained symlink escapes, symlink template ancestors, nested disallowed entries, blocking .git-cow file, older startSha dirtiness, and locked template recreation', async (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-cow-hardening-'));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const repoDir = createTestRepo(sandbox);
  const shaBeforeIgnore = gitSync(repoDir, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(repoDir, '.gitignore'), 'dist/\n');
  gitSync(repoDir, ['add', '.gitignore']);
  gitSync(repoDir, ['commit', '-m', 'ignore dist']);

  const glimmervoidHome = path.join(sandbox, 'gv-home');
  const worktreeBase = path.join(glimmervoidHome, 'worktrees');
  fs.mkdirSync(worktreeBase, { recursive: true });

  const outsideSecret = path.join(sandbox, 'outside-secret.txt');
  fs.writeFileSync(outsideSecret, 'TOP_SECRET');
  fs.mkdirSync(path.join(repoDir, 'target', 'a', 'b'), { recursive: true });
  fs.symlinkSync('../../..', path.join(repoDir, 'target', 'a', 'b', 'up'));
  fs.symlinkSync('up/../../outside-secret.txt', path.join(repoDir, 'target', 'a', 'b', 'escape'));

  fs.mkdirSync(path.join(repoDir, 'dist', 'standalone', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'dist', 'standalone', 'node_modules', 'pkg', 'index.js'), 'nested');
  fs.mkdirSync(path.join(repoDir, 'dist', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'dist', '.claude', 'settings.json'), 'hidden');
  fs.writeFileSync(path.join(repoDir, 'dist', '.env.local'), 'KEY=1');
  fs.writeFileSync(path.join(repoDir, 'dist', 'bundle.js'), 'ok');

  const warnings: string[] = [];
  const gitWorkspace = createGitWorkspace({
    glimmervoidHome,
    log: { warn: (message: string) => warnings.push(message) },
    cow: {
      canClone: async () => true,
      cloneDir: copyEntryForTest,
      warmIntervalMs: 3600_000,
    },
  });

  const firstWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:hard1',
    teamId: 'session',
    label: 'hard1',
    worktreeBase,
  });
  assert.equal(firstWorkspace.isGit, true);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'target')), false);
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, 'dist', 'bundle.js'), 'utf8'), 'ok');
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'dist', 'standalone', 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'dist', '.claude')), false);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'dist', '.env.local')), false);

  const olderWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:hard2',
    teamId: 'session',
    label: 'hard2',
    startSha: shaBeforeIgnore,
    worktreeBase,
  });
  assert.equal(olderWorkspace.isGit, true);
  assert.equal(gitSync(olderWorkspace.cwd, ['status', '--porcelain']), '');
  assert.equal(warnings.filter((warning) => warning.includes('already locked')).length, 0);

  const templateRoot = path.join(worktreeBase, COW_TEMPLATE_DIR_NAME);
  const [templateName] = fs.readdirSync(templateRoot).filter((entry) => !entry.startsWith('.'));
  fs.rmSync(path.join(templateRoot, templateName, '.git'), { force: true });
  const recreatedWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:hard3',
    teamId: 'session',
    label: 'hard3',
    worktreeBase,
  });
  assert.equal(recreatedWorkspace.isGit, true);
  assert.equal(fs.existsSync(path.join(templateRoot, templateName, '.git')), true);

  const blockedWorktreeBase = path.join(sandbox, 'blocked-worktrees');
  fs.mkdirSync(blockedWorktreeBase, { recursive: true });
  fs.writeFileSync(path.join(blockedWorktreeBase, COW_TEMPLATE_DIR_NAME), 'blocking-file');
  const blockedFallbackWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:blocked',
    teamId: 'session',
    label: 'blocked',
    worktreeBase: blockedWorktreeBase,
  });
  assert.equal(blockedFallbackWorkspace.isGit, true);
});

test('createGitWorkspace blocks symlinks targeting hidden/secret paths inside build dirs and re-warms read-only 0555 build caches', async (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-cow-gaps-'));
  context.after(() => {
    try { execFileSync('chmod', ['-R', 'u+w', sandbox]); } catch {}
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const repoDir = createTestRepo(sandbox);
  fs.appendFileSync(path.join(repoDir, '.gitignore'), 'dist/\ngocache/\nro-root/\n');
  gitSync(repoDir, ['add', '.gitignore']);
  gitSync(repoDir, ['commit', '-m', 'ignore dist, gocache, and ro-root']);

  fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude', 'creds.json'), 'SECRET_AGENT_CRED');
  fs.mkdirSync(path.join(repoDir, 'dist'), { recursive: true });
  fs.symlinkSync('../.claude/creds.json', path.join(repoDir, 'dist', 'alias.json'));

  const readOnlyCacheDir = path.join(repoDir, 'gocache', 'mod');
  fs.mkdirSync(path.join(readOnlyCacheDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(readOnlyCacheDir, '.claude', 'creds.json'), 'NESTED_SECRET');
  fs.writeFileSync(path.join(readOnlyCacheDir, 'file.go'), 'v1');
  fs.chmodSync(path.join(readOnlyCacheDir, 'file.go'), 0o444);
  fs.chmodSync(readOnlyCacheDir, 0o555);

  const readOnlyRootDir = path.join(repoDir, 'ro-root');
  fs.mkdirSync(readOnlyRootDir, { recursive: true });
  fs.writeFileSync(path.join(readOnlyRootDir, 'data.bin'), 'ro-ok');
  fs.chmodSync(path.join(readOnlyRootDir, 'data.bin'), 0o444);
  fs.chmodSync(readOnlyRootDir, 0o555);

  const worktreeBase = path.join(sandbox, 'worktrees');
  const gitWorkspace = createGitWorkspace({
    cow: {
      canClone: async () => true,
      cloneDir: copyEntryForTest,
      warmIntervalMs: 0,
    },
  });

  const firstWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:gap1',
    teamId: 'session',
    label: 'gap1',
    worktreeBase,
  });
  assert.equal(firstWorkspace.isGit, true);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'dist')), false);
  assert.equal(fs.existsSync(path.join(firstWorkspace.cwd, 'gocache', 'mod', '.claude')), false);
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, 'gocache', 'mod', 'file.go'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(firstWorkspace.cwd, 'ro-root', 'data.bin'), 'utf8'), 'ro-ok');

  fs.chmodSync(readOnlyCacheDir, 0o755);
  fs.chmodSync(path.join(readOnlyCacheDir, 'file.go'), 0o644);
  fs.writeFileSync(path.join(readOnlyCacheDir, 'file.go'), 'v2');
  fs.chmodSync(path.join(readOnlyCacheDir, 'file.go'), 0o444);
  fs.chmodSync(readOnlyCacheDir, 0o555);

  const secondWorkspace = await gitWorkspace.create({
    projectPath: repoDir,
    owner: 'session:gap2',
    teamId: 'session',
    label: 'gap2',
    worktreeBase,
  });
  assert.equal(secondWorkspace.isGit, true);
  assert.equal(fs.readFileSync(path.join(secondWorkspace.cwd, 'gocache', 'mod', 'file.go'), 'utf8'), 'v2');
});
