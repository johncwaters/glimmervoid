import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  nativeBindingCandidates,
  nodePtyRebuildHint,
  formatNodePtyBootRefusal,
} from '../server/core/node-pty-preflight-core.ts';
import { probeNodePty, scanNativeBinding } from '../server/node-pty-preflight.ts';

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
