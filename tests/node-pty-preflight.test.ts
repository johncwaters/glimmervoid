import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  nativeBindingCandidates,
  spawnHelperCandidates,
  nodePtyRebuildHint,
  formatNodePtyBootRefusal,
} from '../server/core/node-pty-preflight-core.ts';
import { probeNodePty, requireExecutableSpawnHelper, scanNativeBinding } from '../server/node-pty-preflight.ts';

test('nativeBindingCandidates: each of Release, Debug and prebuilds is checked package-relative then lib-relative', () => {
  const candidates = nativeBindingCandidates({ packageDir: '/pkg/node-pty', platform: 'linux', arch: 'x64' });
  assert.deepEqual(candidates, [
    path.join('/pkg/node-pty', 'build', 'Release', 'pty.node'),
    path.join('/pkg/node-pty', 'lib', 'build', 'Release', 'pty.node'),
    path.join('/pkg/node-pty', 'build', 'Debug', 'pty.node'),
    path.join('/pkg/node-pty', 'lib', 'build', 'Debug', 'pty.node'),
    path.join('/pkg/node-pty', 'prebuilds', 'linux-x64', 'pty.node'),
    path.join('/pkg/node-pty', 'lib', 'prebuilds', 'linux-x64', 'pty.node'),
  ]);
});

test('nativeBindingCandidates: the prebuilds directory carries platform and arch', () => {
  const win = nativeBindingCandidates({ packageDir: 'C:\\pkg', platform: 'win32', arch: 'x64' });
  assert.equal(win[4], path.join('C:\\pkg', 'prebuilds', 'win32-x64', 'pty.node'));
  assert.equal(win[5], path.join('C:\\pkg', 'lib', 'prebuilds', 'win32-x64', 'pty.node'));
  const mac = nativeBindingCandidates({ packageDir: '/pkg', platform: 'darwin', arch: 'arm64' });
  assert.equal(mac[4], path.join('/pkg', 'prebuilds', 'darwin-arm64', 'pty.node'));
  assert.equal(mac[5], path.join('/pkg', 'lib', 'prebuilds', 'darwin-arm64', 'pty.node'));
});

test('nodePtyRebuildHint: linux names the apt toolchain, win32 names Visual Studio', () => {
  assert.match(nodePtyRebuildHint('linux'), /build-essential python3/);
  assert.match(nodePtyRebuildHint('win32'), /Visual Studio Build Tools/);
  assert.equal(/build-essential/.test(nodePtyRebuildHint('win32')), false);
});

test('nodePtyRebuildHint: darwin names the Xcode command line tools, the only toolchain a mac needs', () => {
  const hint = nodePtyRebuildHint('darwin');
  assert.match(hint, /install Xcode Command Line Tools: xcode-select --install/);
  assert.doesNotMatch(hint, /build-essential|Visual Studio/, 'no other platform toolchain leaks in');
  assert.doesNotMatch(hint, /native build tools for this platform/, 'no generic fallback on a platform we name');
});

test('formatNodePtyBootRefusal: darwin carries the Xcode toolchain hint', () => {
  const message = formatNodePtyBootRefusal({ platform: 'darwin', packageDir: '/pkg/node-pty', reason: 'boom' });
  assert.match(message, /xcode-select --install/);
});

test('nodePtyRebuildHint: every platform names the global rebuild and the checkout rebuild, each labelled', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
    const hint = nodePtyRebuildHint(platform);
    assert.ok(hint.includes('global install: npm rebuild -g node-pty --allow-scripts=node-pty'), hint);
    assert.ok(hint.includes('clone or source checkout, from the checkout root: npm rebuild node-pty --dangerously-allow-all-scripts'), hint);
  }
});

test('formatNodePtyBootRefusal: states the refusal, the reason, the repair and the doctor', () => {
  const message = formatNodePtyBootRefusal({
    platform: 'linux',
    packageDir: '/pkg/node-pty',
    reason: 'no pty.node found',
  });
  assert.match(message, /node-pty native binding did not load/);
  assert.match(message, /no pty\.node found/);
  assert.ok(message.includes('/pkg/node-pty'));
  assert.ok(message.includes('repair (global install): npm rebuild -g node-pty --allow-scripts=node-pty'));
  assert.ok(message.includes('fallback (global install): cd "$(npm root -g)/glimmervoid" && npm rebuild node-pty --dangerously-allow-all-scripts'));
  assert.ok(message.includes('repair (clone or source checkout): npm rebuild node-pty --dangerously-allow-all-scripts'));
  assert.match(message, /npm 12 blocks dependency install scripts/);
  assert.match(message, /glimmervoid doctor/);
  assert.match(message, /build-essential python3/);
});

test('formatNodePtyBootRefusal: names both rebuild traps so the narrow repair is run correctly', () => {
  const message = formatNodePtyBootRefusal({ platform: 'linux', packageDir: '/pkg', reason: 'boom' });
  assert.match(message, /outside the installed package/);
  assert.match(message, /EALLOWSCRIPTS/);
  assert.match(message, /name node-pty, not glimmervoid/);
});

test('formatNodePtyBootRefusal: states the global repair once and the checkout repair once', () => {
  for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
    const message = formatNodePtyBootRefusal({ platform, packageDir: '/pkg', reason: 'boom' });
    const globalRepairs = message.split('npm rebuild -g node-pty --allow-scripts=node-pty').length - 1;
    assert.equal(globalRepairs, 1, `${platform}: ${globalRepairs}`);
    const checkoutRepairs = message.split('repair (clone or source checkout): npm rebuild node-pty --dangerously-allow-all-scripts').length - 1;
    assert.equal(checkoutRepairs, 1, `${platform}: ${checkoutRepairs}`);
  }
});

test('formatNodePtyBootRefusal: the checkout repair says where to run it and why the global one will not do', () => {
  const message = formatNodePtyBootRefusal({ platform: 'linux', packageDir: '/pkg', reason: 'boom' });
  assert.match(message, /run it from the checkout root/);
  assert.match(message, /rebuilds nothing in a checkout and exits 0/);
});

test('formatNodePtyBootRefusal: win32 carries the Windows toolchain hint', () => {
  const message = formatNodePtyBootRefusal({ platform: 'win32', packageDir: 'C:\\pkg', reason: 'boom' });
  assert.ok(message.includes('C:\\pkg'));
  assert.match(message, /Visual Studio Build Tools/);
});

test('formatNodePtyBootRefusal: contains no em dash, en dash or ellipsis (repo style rule)', () => {
  const emDash = String.fromCharCode(8212);
  const enDash = String.fromCharCode(8211);
  const ellipsis = String.fromCharCode(8230);
  for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
    const message = formatNodePtyBootRefusal({ platform, packageDir: '/pkg', reason: 'boom' });
    assert.equal(message.includes(emDash), false);
    assert.equal(message.includes(enDash), false);
    assert.equal(message.includes(ellipsis), false);
  }
});

test('probeNodePty: reports ok when the binding is compiled in this checkout', async () => {
  const result = await probeNodePty();
  assert.equal(result.ok, true, 'ok' in result && result.ok ? '' : JSON.stringify(result));
  assert.ok(result.packageDir.endsWith(`${path.sep}node-pty`), result.packageDir);
});

test('scanNativeBinding: a package directory with no binding is refused and names what was checked', () => {
  const emptyPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-node-pty-'));
  try {
    const result = scanNativeBinding(emptyPackageDir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const expected = nativeBindingCandidates({
      packageDir: emptyPackageDir,
      platform: process.platform,
      arch: process.arch,
    });
    for (const candidate of expected) assert.ok(result.reason.includes(candidate), candidate);
    assert.equal(result.packageDir, emptyPackageDir);
  } finally {
    fs.rmSync(emptyPackageDir, { recursive: true, force: true });
  }
});

function writeBindingBeside({
  packageDir,
  searchDir,
  helperMode,
}: { packageDir: string; searchDir: string[]; helperMode: number | null }): string {
  const bindingDir = path.join(packageDir, ...searchDir);
  fs.mkdirSync(bindingDir, { recursive: true });
  fs.writeFileSync(path.join(bindingDir, 'pty.node'), '');
  const helperPath = path.join(bindingDir, 'spawn-helper');
  if (helperMode == null) return helperPath;
  fs.writeFileSync(helperPath, '');
  fs.chmodSync(helperPath, helperMode);
  return helperPath;
}

const darwinScope = { platform: 'darwin' as NodeJS.Platform, arch: process.arch };

function writeBindingFixture({
  helperMode,
  scope,
}: { helperMode: number | null; scope: { platform: NodeJS.Platform; arch: string } }): {
  packageDir: string;
  helperPath: string;
} {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-node-pty-'));
  const searchDir = ['prebuilds', `${scope.platform}-${scope.arch}`];
  return { packageDir, helperPath: writeBindingBeside({ packageDir, searchDir, helperMode }) };
}

test('scanNativeBinding: a spawn-helper stripped of its execute bit is repaired rather than refused', () => {
  const { packageDir, helperPath } = writeBindingFixture({ helperMode: 0o644, scope: darwinScope });
  try {
    const result = scanNativeBinding(packageDir, darwinScope);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.notEqual(fs.statSync(helperPath).mode & 0o111, 0);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('scanNativeBinding: an executable spawn-helper keeps the mode it already has', () => {
  const { packageDir, helperPath } = writeBindingFixture({ helperMode: 0o700, scope: darwinScope });
  try {
    assert.equal(scanNativeBinding(packageDir, darwinScope).ok, true);
    assert.equal(fs.statSync(helperPath).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('scanNativeBinding: on darwin a binding with no spawn-helper anywhere is refused and names the paths checked', () => {
  const { packageDir, helperPath } = writeBindingFixture({ helperMode: null, scope: darwinScope });
  try {
    const result = scanNativeBinding(packageDir, darwinScope);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /no executable spawn-helper found/);
    assert.ok(result.reason.includes(helperPath), result.reason);
    assert.equal(result.packageDir, packageDir);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('scanNativeBinding: every spawn-helper that exists is repaired, not only the first executable one', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-node-pty-'));
  try {
    writeBindingBeside({ packageDir, searchDir: ['build', 'Release'], helperMode: 0o755 });
    const prebuiltHelperPath = writeBindingBeside({
      packageDir,
      searchDir: ['prebuilds', `${darwinScope.platform}-${darwinScope.arch}`],
      helperMode: 0o644,
    });
    const result = scanNativeBinding(packageDir, darwinScope);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.notEqual(fs.statSync(prebuiltHelperPath).mode & 0o111, 0, prebuiltHelperPath);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('scanNativeBinding: off darwin the host default accepts a binding with no spawn-helper anywhere, since node-pty only spawns through a helper on macOS', { skip: process.platform === 'darwin' }, () => {
  const hostScope = { platform: process.platform, arch: process.arch };
  const { packageDir } = writeBindingFixture({ helperMode: null, scope: hostScope });
  try {
    const result = scanNativeBinding(packageDir);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('scanNativeBinding: the host platform and arch are the default scope', () => {
  const { packageDir } = writeBindingFixture({ helperMode: null, scope: { platform: process.platform, arch: process.arch } });
  try {
    assert.deepEqual(scanNativeBinding(packageDir), scanNativeBinding(packageDir, { platform: process.platform, arch: process.arch }));
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('spawnHelperCandidates: off darwin there are none, on darwin each binding candidate has a sibling helper', () => {
  assert.deepEqual(spawnHelperCandidates({ packageDir: '/pkg', platform: 'linux', arch: 'x64' }), []);
  assert.deepEqual(spawnHelperCandidates({ packageDir: '/pkg', platform: 'win32', arch: 'x64' }), []);
  const mac = spawnHelperCandidates({ packageDir: '/pkg', platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(
    mac,
    nativeBindingCandidates({ packageDir: '/pkg', platform: 'darwin', arch: 'arm64' }).map((bindingPath) =>
      path.join(path.dirname(bindingPath), 'spawn-helper'),
    ),
  );
  assert.ok(mac.includes(path.join('/pkg', 'prebuilds', 'darwin-arm64', 'spawn-helper')), mac.join(', '));
});

test('requireExecutableSpawnHelper: a helper stripped after boot is repaired before the next spawn', () => {
  const { packageDir, helperPath } = writeBindingFixture({ helperMode: 0o644, scope: darwinScope });
  try {
    requireExecutableSpawnHelper(packageDir, darwinScope);
    assert.notEqual(fs.statSync(helperPath).mode & 0o111, 0);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('requireExecutableSpawnHelper: a missing helper throws the checked paths instead of an opaque posix_spawnp failure', () => {
  const { packageDir, helperPath } = writeBindingFixture({ helperMode: null, scope: darwinScope });
  try {
    assert.throws(
      () => requireExecutableSpawnHelper(packageDir, darwinScope),
      (error: unknown) => error instanceof Error && error.message.includes(helperPath),
    );
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('requireExecutableSpawnHelper: the installed node-pty passes on the host', () => {
  assert.doesNotThrow(() => requireExecutableSpawnHelper());
});
