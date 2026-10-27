import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { execFileAsync } from '../server/child-process-safe.ts';
import { getRtkPath, resetRtkPathCache } from '../server/rtk-resolver.ts';
import { installRtk } from '../server/rtk-installer.ts';
import type { InstallResult } from '../server/rtk-installer.ts';

const IS_WINDOWS = process.platform === 'win32';
const SILENT = { log() {}, warn() {} };

function refusal(result: InstallResult): string {
  if (result.ok) throw new Error('expected a refusal, the install succeeded');
  return result.reason;
}

async function makeTempHome(t: TestContext): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-rtk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function buildFixture(
  t: TestContext,
  { nested = true, symlink = false }: { nested?: boolean; symlink?: boolean } = {},
): Promise<{ bytes: Buffer; sha256: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-rtk-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payloadRoot = path.join(dir, 'payload');
  const binaryDir = nested ? path.join(payloadRoot, 'rtk-0.45.0') : payloadRoot;
  await fsp.mkdir(binaryDir, { recursive: true });
  if (symlink) await fsp.symlink('/etc/passwd', path.join(binaryDir, 'rtk'));
  if (!symlink) await fsp.writeFile(path.join(binaryDir, 'rtk'), '#!/bin/sh\necho "rtk 0.45.0"\n');
  const archivePath = path.join(dir, 'fixture.tar.gz');
  await execFileAsync('tar', ['-czf', archivePath, '-C', payloadRoot, '.']);
  const bytes = await fsp.readFile(archivePath);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function fakeFetch(
  bytes: Buffer,
  { status = 200, contentLength = null }: { status?: number; contentLength?: number | null } = {},
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    const headers = new Headers();
    if (contentLength != null) headers.set('content-length', String(contentLength));
    return new Response(status === 204 || status === 304 ? null : new Uint8Array(bytes), { status, headers });
  };
  return { impl, calls };
}

function assetFor(sha256: string) {
  return { file: 'fixture.tar.gz', sha256, version: '0.45.0', url: 'https://example.invalid/fixture.tar.gz' };
}

test('a digest mismatch lands nothing in bin and never extracts', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let extracted = false;

  const result = await installRtk({
    glimmervoidHome: path.join(homeDir, '.glimmervoid'),
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    execFileImpl: async () => {
      extracted = true;
      return { stdout: '', stderr: '' };
    },
    asset: assetFor('f'.repeat(64)),
    log: SILENT,
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /sha256 mismatch/);
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(path.join(homeDir, '.glimmervoid', 'bin', 'rtk')), false);
  assert.deepEqual(await fsp.readdir(path.join(homeDir, '.glimmervoid', 'tmp')), []);
});

test('installRtk refuses an archive listing a member outside the staging dir before extracting', async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let extracted = false;
  const execFileImpl = async (_file: string, ...rest: unknown[]) => {
    const args = rest[0];
    if (Array.isArray(args) && args[0] === '-tf') return { stdout: './rtk\n../escape\n', stderr: '' };
    extracted = true;
    return { stdout: '', stderr: '' };
  };

  const result = await installRtk({
    glimmervoidHome: path.join(homeDir, '.glimmervoid'),
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    execFileImpl,
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /escapes the staging dir: \.\.\/escape/);
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(path.join(homeDir, '.glimmervoid', 'bin', 'rtk')), false);
});

test('installRtk completes through the copy path when the cross-device rename is refused', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let refusedOnce = false;
  const renameImpl = async (source: PathLike, target: PathLike) => {
    if (!refusedOnce && !String(source).endsWith('.partial')) {
      refusedOnce = true;
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    }
    return fsp.rename(source, target);
  };

  const result = await installRtk({
    glimmervoidHome: path.join(homeDir, '.glimmervoid'),
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    renameImpl,
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, true);
  const target = path.join(homeDir, '.glimmervoid', 'bin', 'rtk');
  assert.equal(refusedOnce, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(`${target}.partial`), false);
  assert.equal(await fsp.readFile(target, 'utf8'), '#!/bin/sh\necho "rtk 0.45.0"\n');
});

test('the installer target and the resolver probe agree under a relocated Glimmervoid home', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const relocatedGlimmervoidHome = await makeTempHome(t);
  const fixture = await buildFixture(t);
  const previousGlimmervoidHome = process.env.GLIMMERVOID_HOME;
  process.env.GLIMMERVOID_HOME = relocatedGlimmervoidHome;
  resetRtkPathCache();
  t.after(() => {
    process.env.GLIMMERVOID_HOME = previousGlimmervoidHome;
    resetRtkPathCache();
  });

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    asset: assetFor(fixture.sha256),
    log: SILENT,
  });

  assert.ok(result.ok, 'the install succeeded');
  assert.equal(result.path, path.join(relocatedGlimmervoidHome, 'bin', 'rtk'));
  assert.equal(fs.existsSync(path.join(homeDir, '.glimmervoid')), false);
  assert.equal(getRtkPath(), result.path);
});
