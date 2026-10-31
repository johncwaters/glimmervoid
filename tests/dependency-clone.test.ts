import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedWorktreeDependencies } from '../server/git/dependency-clone.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const CAN_CLONE = process.platform === 'darwin' && hasGit();

function lockfileWith(leftPadVersion: string): string {
  return `${JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture' },
      'node_modules/left-pad': { version: leftPadVersion, resolved: `https://registry.npmjs.org/left-pad/-/left-pad-${leftPadVersion}.tgz`, integrity: 'sha512-fixture' },
      'node_modules/@esbuild/linux-x64': { version: '0.25.0', optional: true },
    },
  }, null, 2)}\n`;
}

function installedStateWith(leftPadVersion: string): string {
  const installed = JSON.parse(lockfileWith(leftPadVersion));
  delete installed.packages[''];
  delete installed.packages['node_modules/@esbuild/linux-x64'];
  return JSON.stringify(installed, null, 2);
}

function makeRepoWithWorktree(): { mainCheckout: string; worktreeDir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-dependency-clone-')));
  const mainCheckout = path.join(root, 'main');
  fs.mkdirSync(mainCheckout);
  git(['init', '-b', 'main'], mainCheckout);
  git(['config', 'user.email', 'test@example.com'], mainCheckout);
  git(['config', 'user.name', 'Glimmervoid Test'], mainCheckout);
  git(['config', 'commit.gpgsign', 'false'], mainCheckout);
  fs.writeFileSync(path.join(mainCheckout, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(mainCheckout, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(mainCheckout, 'package-lock.json'), lockfileWith('1.3.0'));
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'init'], mainCheckout);
  const nodeModules = path.join(mainCheckout, 'node_modules');
  fs.mkdirSync(path.join(nodeModules, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(nodeModules, 'left-pad', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(nodeModules, '.bin'));
  fs.symlinkSync('../left-pad/index.js', path.join(nodeModules, '.bin', 'left-pad'));
  fs.mkdirSync(path.join(nodeModules, '.vite'));
  fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), installedStateWith('1.3.0'));
  const worktreeDir = path.join(root, 'session-worktree');
  git(['worktree', 'add', '-b', 'session', worktreeDir], mainCheckout);
  return { mainCheckout, worktreeDir };
}

test('a session worktree gets an isolated clone of a matching main checkout install', { skip: !CAN_CLONE }, async () => {
  const { mainCheckout, worktreeDir } = makeRepoWithWorktree();

  const outcome = await seedWorktreeDependencies({ mainCheckout, worktreeDir });

  assert.equal(outcome.action, 'cloned');
  const clonedFile = path.join(worktreeDir, 'node_modules', 'left-pad', 'index.js');
  assert.equal(fs.readlinkSync(path.join(worktreeDir, 'node_modules', '.bin', 'left-pad')), '../left-pad/index.js');
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', '.vite')), false);
  fs.writeFileSync(clonedFile, 'module.exports = 2;\n');
  assert.equal(fs.readFileSync(path.join(mainCheckout, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.deepEqual(fs.readdirSync(path.dirname(worktreeDir)).sort(), ['main', 'session-worktree']);
  assert.equal(git(['status', '--porcelain'], worktreeDir).trim(), '');
});

test('a main checkout install that no longer matches the worktree lockfile is not cloned', { skip: !CAN_CLONE }, async () => {
  const { mainCheckout, worktreeDir } = makeRepoWithWorktree();
  fs.writeFileSync(path.join(mainCheckout, 'node_modules', '.package-lock.json'), installedStateWith('1.1.0'));

  const outcome = await seedWorktreeDependencies({ mainCheckout, worktreeDir });

  assert.deepEqual(outcome, { action: 'skip', reason: 'install-stale', notify: true });
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
});

test('a nested package whose own install no longer matches its lockfile is left out of the clone', { skip: !CAN_CLONE }, async () => {
  const { mainCheckout, worktreeDir } = makeRepoWithWorktree();
  const mainSite = path.join(mainCheckout, 'site');
  fs.mkdirSync(path.join(mainSite, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(mainSite, 'package.json'), '{"name":"site"}\n');
  fs.writeFileSync(path.join(mainSite, 'package-lock.json'), lockfileWith('1.3.0'));
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'site'], mainCheckout);
  fs.writeFileSync(path.join(mainSite, 'node_modules', '.package-lock.json'), installedStateWith('1.1.0'));
  git(['merge', '--ff-only', 'main'], worktreeDir);

  const outcome = await seedWorktreeDependencies({ mainCheckout, worktreeDir });

  assert.equal(outcome.action, 'cloned');
  assert.deepEqual(outcome.action === 'cloned' ? outcome.staleDirs : null, ['site']);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'left-pad')), true);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'site', 'node_modules')), false);
});

test('a main checkout install holding an npm link to an absolute path is not cloned', { skip: !CAN_CLONE }, async () => {
  const { mainCheckout, worktreeDir } = makeRepoWithWorktree();
  fs.symlinkSync(path.join(mainCheckout, 'package.json'), path.join(mainCheckout, 'node_modules', 'linked'));

  const outcome = await seedWorktreeDependencies({ mainCheckout, worktreeDir });

  assert.deepEqual(outcome, { action: 'skip', reason: 'absolute-link', notify: true });
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
  assert.deepEqual(fs.readdirSync(path.dirname(worktreeDir)).sort(), ['main', 'session-worktree']);
});
