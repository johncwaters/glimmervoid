import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedWorktreeDependencies } from '../server/git/dependency-clone.ts';
import type { DependencySeedOutcome } from '../server/git/dependency-clone.ts';
import { describeInstallNotice, describeInstallWarnings } from '../server/git/core/dependency-clone-core.ts';
import { runCommand } from '../server/git/git-exec.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const CAN_CLONE = process.platform === 'darwin' && hasGit();
const CAN_INSTALL = process.platform !== 'win32' && hasGit();

function hasPnpm(): boolean {
  return process.env.PATH?.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'pnpm'))) === true;
}

async function seedToCompletion(mainCheckout: string, worktreeDir: string): Promise<DependencySeedOutcome> {
  const outcome = await seedWorktreeDependencies({ mainCheckout, worktreeDir, signal: new AbortController().signal, hookConfigRelPaths: [] }).completion;
  assert.ok(outcome);
  return outcome;
}

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

function makeMainCheckout(tempPrefix: string): { root: string; mainCheckout: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix)));
  const mainCheckout = path.join(root, 'main');
  fs.mkdirSync(mainCheckout);
  git(['init', '-b', 'main'], mainCheckout);
  git(['config', 'user.email', 'test@example.com'], mainCheckout);
  git(['config', 'user.name', 'Glimmervoid Test'], mainCheckout);
  git(['config', 'commit.gpgsign', 'false'], mainCheckout);
  fs.writeFileSync(path.join(mainCheckout, '.gitignore'), 'node_modules\n');
  return { root, mainCheckout };
}

function makeRepoWithWorktree(): { mainCheckout: string; worktreeDir: string } {
  const { root, mainCheckout } = makeMainCheckout('gv-dependency-clone-');
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

  const outcome = await seedToCompletion(mainCheckout, worktreeDir);

  assert.equal(outcome.clone.action, 'cloned');
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

  const outcome = await seedToCompletion(mainCheckout, worktreeDir);

  assert.deepEqual(outcome.clone, { action: 'skip', reason: 'install-stale' });
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
});

test('a nested package whose own install cannot be shown to match its lockfile is left out of the clone', { skip: !CAN_CLONE }, async (t) => {
  const staleInstalls: [string, string, string | null][] = [
    ['npm install behind its lockfile', 'package-lock.json', installedStateWith('1.1.0')],
    ['yarn lockfile', 'yarn.lock', null],
  ];
  for (const [installKind, lockfileName, installedState] of staleInstalls) {
    await t.test(installKind, async () => {
      const { mainCheckout, worktreeDir } = makeRepoWithWorktree();
      const mainSite = path.join(mainCheckout, 'site');
      fs.mkdirSync(path.join(mainSite, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(mainSite, 'package.json'), '{"name":"site"}\n');
      fs.writeFileSync(path.join(mainSite, lockfileName), lockfileWith('1.3.0'));
      git(['add', '-A'], mainCheckout);
      git(['commit', '-m', 'site'], mainCheckout);
      if (installedState) fs.writeFileSync(path.join(mainSite, 'node_modules', '.package-lock.json'), installedState);
      git(['merge', '--ff-only', 'main'], worktreeDir);

      const outcome = await seedToCompletion(mainCheckout, worktreeDir);

      assert.deepEqual(outcome.clone.action === 'cloned' ? outcome.clone.dirs : null, ['.']);
      assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'left-pad')), true);
      assert.equal(fs.existsSync(path.join(worktreeDir, 'site', 'node_modules')), false);
    });
  }
});

test('a main checkout install linking outside the repository is not cloned', { skip: !CAN_CLONE }, async (t) => {
  for (const [linkKind, linkTarget] of [['absolute', '/usr/bin'], ['relative', '../../../linked-src']]) {
    await t.test(linkKind, async () => {
      const { mainCheckout, worktreeDir } = makeRepoWithWorktree();
      fs.symlinkSync(linkTarget, path.join(mainCheckout, 'node_modules', 'linked'));

      const outcome = await seedToCompletion(mainCheckout, worktreeDir);

      assert.deepEqual(outcome.clone, { action: 'skip', reason: 'outside-link' });
      assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
      assert.deepEqual(fs.readdirSync(path.dirname(worktreeDir)).sort(), ['main', 'session-worktree']);
    });
  }
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeLockfileFor(packageDir: string): Promise<void> {
  const locked = await runCommand('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: packageDir, timeoutMs: 120_000 });
  assert.ok(locked.ok, locked.err);
}

async function makeInstallableRepoWithWorktree(): Promise<{ mainCheckout: string; worktreeDir: string }> {
  const { root, mainCheckout } = makeMainCheckout('gv-dependency-install-');
  writeJson(path.join(mainCheckout, 'vendor', 'left-pad', 'package.json'), { name: 'left-pad', version: '1.3.0' });
  fs.writeFileSync(path.join(mainCheckout, 'vendor', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  writeJson(path.join(mainCheckout, 'package.json'), {
    name: 'fixture',
    version: '1.0.0',
    dependencies: { 'left-pad': 'file:vendor/left-pad' },
    scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-ran\', \'\')"' },
  });
  writeJson(path.join(mainCheckout, 'site', 'package.json'), { name: 'site', version: '1.0.0', dependencies: { 'left-pad': 'file:../vendor/left-pad' } });
  await writeLockfileFor(mainCheckout);
  await writeLockfileFor(path.join(mainCheckout, 'site'));
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'init'], mainCheckout);
  const worktreeDir = path.join(root, 'session-worktree');
  git(['worktree', 'add', '-b', 'session', worktreeDir], mainCheckout);
  return { mainCheckout, worktreeDir };
}

test('each lockfile dir of a session worktree gets its own install without running package scripts', { skip: !CAN_INSTALL }, async () => {
  const { mainCheckout, worktreeDir } = await makeInstallableRepoWithWorktree();

  const { install } = await seedToCompletion(mainCheckout, worktreeDir);

  assert.deepEqual(install.results.map((result) => [result.dir, result.ok]), [['.', true], ['site', true]]);
  assert.deepEqual(install.unsupportedDirs, []);
  assert.equal(fs.readFileSync(path.join(worktreeDir, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.existsSync(path.join(worktreeDir, 'site', 'node_modules', 'left-pad')), true);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'postinstall-ran')), false);
  assert.equal(fs.existsSync(path.join(mainCheckout, 'node_modules')), false);
  assert.equal(git(['status', '--porcelain'], worktreeDir).trim(), '');

  const rerun = await seedToCompletion(mainCheckout, worktreeDir);

  assert.deepEqual(rerun.install.results, []);
});

async function packInstallScriptPackage(mainCheckout: string, name: string): Promise<string> {
  const sourceDir = path.join(mainCheckout, 'vendor-src', name);
  writeJson(path.join(sourceDir, 'package.json'), { name, version: '1.0.0', scripts: { install: 'node -e "require(\'fs\').writeFileSync(\'install-ran\', \'\')"' } });
  fs.mkdirSync(path.join(mainCheckout, 'vendor'), { recursive: true });
  const packed = await runCommand('npm', ['pack', sourceDir, '--pack-destination', path.join(mainCheckout, 'vendor')], { cwd: mainCheckout, timeoutMs: 120_000 });
  assert.ok(packed.ok, packed.err);
  fs.rmSync(path.join(mainCheckout, 'vendor-src'), { recursive: true });
  return `file:vendor/${name}-1.0.0.tgz`;
}

test('an install-script package arrives built from a matching main checkout install, one whose own or nested install differs is rebuilt in the worktree, and a banner-only one is not', { skip: !CAN_INSTALL || CAN_CLONE }, async () => {
  const { root, mainCheckout } = makeMainCheckout('gv-dependency-install-script-');
  const dependencies = {
    'built-pkg': await packInstallScriptPackage(mainCheckout, 'built-pkg'),
    'drifted-pkg': await packInstallScriptPackage(mainCheckout, 'drifted-pkg'),
    'nested-drift-pkg': await packInstallScriptPackage(mainCheckout, 'nested-drift-pkg'),
    'core-js': await packInstallScriptPackage(mainCheckout, 'core-js'),
  };
  writeJson(path.join(mainCheckout, 'package.json'), { name: 'fixture', version: '1.0.0', dependencies });
  await writeLockfileFor(mainCheckout);
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'init'], mainCheckout);
  const mainInstall = await runCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: mainCheckout, timeoutMs: 120_000 });
  assert.ok(mainInstall.ok, mainInstall.err);
  fs.writeFileSync(path.join(mainCheckout, 'node_modules', 'built-pkg', 'built.node'), 'native\n');
  fs.writeFileSync(path.join(mainCheckout, 'node_modules', 'drifted-pkg', 'built.node'), 'native\n');
  fs.writeFileSync(path.join(mainCheckout, 'node_modules', 'nested-drift-pkg', 'built.node'), 'native\n');
  const mainInstalledLockPath = path.join(mainCheckout, 'node_modules', '.package-lock.json');
  const mainInstalled = JSON.parse(fs.readFileSync(mainInstalledLockPath, 'utf8'));
  mainInstalled.packages['node_modules/drifted-pkg'].integrity = 'sha512-drifted';
  mainInstalled.packages['node_modules/core-js'].integrity = 'sha512-drifted';
  mainInstalled.packages['node_modules/nested-drift-pkg/node_modules/left-pad'] = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-nested' };
  writeJson(mainInstalledLockPath, mainInstalled);
  const worktreeDir = path.join(root, 'session-worktree');
  git(['worktree', 'add', '-b', 'session', worktreeDir], mainCheckout);

  const { install } = await seedToCompletion(mainCheckout, worktreeDir);

  assert.deepEqual(install.results.map((result) => [result.dir, result.ok]), [['.', true]]);
  assert.equal(fs.readFileSync(path.join(worktreeDir, 'node_modules', 'built-pkg', 'built.node'), 'utf8'), 'native\n');
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'drifted-pkg', 'built.node')), false);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'drifted-pkg', 'install-ran')), true);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'nested-drift-pkg', 'install-ran')), true);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'built-pkg', 'install-ran')), false);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules', 'core-js', 'install-ran')), false);
  assert.deepEqual(describeInstallWarnings(install), []);
});

test('a failed install leaves no node_modules and a yarn lockfile dir is named, not installed', { skip: !CAN_INSTALL }, async () => {
  const { mainCheckout, worktreeDir } = await makeInstallableRepoWithWorktree();
  writeJson(path.join(worktreeDir, 'package.json'), { name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': 'file:vendor/left-pad', 'not-in-lockfile': 'file:missing' } });
  fs.rmSync(path.join(worktreeDir, 'site', 'package-lock.json'));
  fs.writeFileSync(path.join(worktreeDir, 'site', 'yarn.lock'), '');

  const { install } = await seedToCompletion(mainCheckout, worktreeDir);

  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'site', 'node_modules')), false);
  const [failureWarning, unsupportedWarning, ...otherWarnings] = describeInstallWarnings(install);
  assert.match(failureWarning ?? '', /^Installing dependencies in the worktree root failed: .+\. To see the full output, run `npm ci --ignore-scripts --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1` in the worktree root\.$/);
  assert.match(unsupportedWarning ?? '', /^node_modules in site was not installed because/);
  assert.deepEqual(otherWarnings, []);
  const { notice, failureKind } = describeInstallNotice(install);
  assert.match(notice ?? '', /^Dependencies did not install in the worktree root \(.+\)\. The session works; Details has the full output\. Dependencies in site were not installed because there is no package-lock\.json or pnpm-lock\.yaml there\.$/);
  assert.equal(failureKind, 'failed');
});

test('a pnpm lockfile the local pnpm cannot read is skipped quietly while another pnpm failure quotes its ERR_PNPM_ line', { skip: !CAN_INSTALL || !hasPnpm() }, async () => {
  const { root, mainCheckout } = makeMainCheckout('gv-dependency-pnpm-');
  writeJson(path.join(mainCheckout, 'legacy', 'package.json'), { name: 'legacy', version: '1.0.0' });
  fs.writeFileSync(path.join(mainCheckout, 'legacy', 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');
  writeJson(path.join(mainCheckout, 'outdated', 'package.json'), { name: 'outdated', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });
  fs.writeFileSync(path.join(mainCheckout, 'outdated', 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'init'], mainCheckout);
  const worktreeDir = path.join(root, 'session-worktree');
  git(['worktree', 'add', '-b', 'session', worktreeDir], mainCheckout);

  const { install } = await seedToCompletion(mainCheckout, worktreeDir);

  assert.equal(fs.existsSync(path.join(worktreeDir, 'legacy', 'node_modules')), false);
  assert.deepEqual(describeInstallWarnings(install), [
    'Installing dependencies in outdated failed: ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/package.json. To see the full output, run `pnpm install --frozen-lockfile --ignore-scripts --fetch-timeout=30000 --fetch-retries=1` in outdated.',
  ]);
});

test('a server started with a PATH that lacks npm still installs a worktree with npm found in a usual folder', { skip: !CAN_INSTALL }, async () => {
  const { root, mainCheckout } = makeMainCheckout('gv-dependency-minimal-path-');
  writeJson(path.join(mainCheckout, 'package.json'), { name: 'fixture', version: '1.0.0' });
  writeJson(path.join(mainCheckout, 'package-lock.json'), { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } });
  git(['add', '-A'], mainCheckout);
  git(['commit', '-m', 'init'], mainCheckout);
  const worktreeDir = path.join(root, 'session-worktree');
  git(['worktree', 'add', '-b', 'session', worktreeDir], mainCheckout);
  const launcherHome = path.join(root, 'home');
  const npmInUsualFolder = path.join(launcherHome, '.local', 'bin', 'npm');
  fs.mkdirSync(path.dirname(npmInUsualFolder), { recursive: true });
  fs.writeFileSync(npmInUsualFolder, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seedScript = [
    `const { seedWorktreeDependencies } = await import(${JSON.stringify(path.resolve('server/git/dependency-clone.ts'))});`,
    `const outcome = await seedWorktreeDependencies({ mainCheckout: ${JSON.stringify(mainCheckout)}, worktreeDir: ${JSON.stringify(worktreeDir)}, signal: new AbortController().signal, hookConfigRelPaths: [] }).completion;`,
    'console.log(JSON.stringify(outcome.install.results.map((result) => [result.dir, result.ok])));',
  ].join('\n');

  const seeded = await runCommand(process.execPath, ['--input-type=module', '-e', seedScript], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
    replaceEnv: { PATH: '/usr/bin:/bin', HOME: launcherHome, SHELL: '/usr/bin/false', GLIMMERVOID_HOME: process.env.GLIMMERVOID_HOME },
  });

  assert.ok(seeded.ok, seeded.err);
  assert.deepEqual(JSON.parse(seeded.out.trim().split('\n').at(-1) ?? ''), [['.', true]]);
});

test('a seed whose session closes before it starts installs nothing and frees the queue', { skip: !CAN_INSTALL }, async () => {
  const { mainCheckout, worktreeDir } = await makeInstallableRepoWithWorktree();
  const sessionClosed = new AbortController();

  const seeding = seedWorktreeDependencies({ mainCheckout, worktreeDir, signal: sessionClosed.signal, hookConfigRelPaths: [] }).completion;
  sessionClosed.abort();

  assert.equal(await seeding, null);
  assert.equal(fs.existsSync(path.join(worktreeDir, 'node_modules')), false);
  const nextSeed = await seedToCompletion(mainCheckout, worktreeDir);
  assert.deepEqual(nextSeed.install.results.map((result) => result.ok), [true, true]);
});

test('only a worktree whose agent hook files run from node_modules holds its agent for the install', { skip: !CAN_INSTALL }, async () => {
  const { mainCheckout, worktreeDir } = await makeInstallableRepoWithWorktree();
  const hookConfigRelPaths = ['.claude/settings.json', '.codex/hooks.json'];
  writeJson(path.join(worktreeDir, '.codex', 'hooks.json'), { hooks: { SessionStart: [{ command: 'node scripts/start.js' }] } });

  const plainSeed = seedWorktreeDependencies({ mainCheckout, worktreeDir, signal: new AbortController().signal, hookConfigRelPaths });

  assert.equal(await plainSeed.blocksSpawn, false);
  assert.deepEqual((await plainSeed.completion)?.install.results.map((result) => result.ok), [true, true]);

  fs.rmSync(path.join(worktreeDir, 'node_modules'), { recursive: true });
  writeJson(path.join(worktreeDir, '.claude', 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ command: 'node node_modules/tool/cli.js' }] }] } });

  const hookSeed = seedWorktreeDependencies({ mainCheckout, worktreeDir, signal: new AbortController().signal, hookConfigRelPaths });

  assert.equal(await hookSeed.blocksSpawn, true);
});
