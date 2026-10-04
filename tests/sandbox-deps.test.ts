import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SANDBOX_INSTALL_HINT, requiredSandboxBinaries, sandboxBootWarning, sandboxDependencyReport, sandboxDoctorRows, sandboxInstallNotice, sandboxSpawnRefusal,
} from '../server/core/sandbox-deps-core.ts';
import { checkSandboxDependencies, probeSandboxDependencies } from '../server/sandbox-deps.ts';

const ROOT = path.join(import.meta.dirname, '..');
const isLinuxWithWhich = process.platform === 'linux' && fs.existsSync('/usr/bin/which');

function linuxReport(binariesOnPath: string[]) {
  return sandboxDependencyReport({ platform: 'linux', binariesOnPath: new Set(binariesOnPath) });
}

function runWithPath(scriptArgs: string[], pathEnv: string) {
  return spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: pathEnv, npm_config_global: '', npm_config_prefix: os.tmpdir() },
  });
}

function pathDirWithStubs(binaryNames: string[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-sandbox-path-'));
  fs.symlinkSync('/usr/bin/which', path.join(directory, 'which'));
  for (const binaryName of binaryNames) fs.writeFileSync(path.join(directory, binaryName), '#!/bin/sh\n', { mode: 0o755 });
  return directory;
}

test('linux needs bwrap and socat, and other platforms check nothing', () => {
  assert.deepEqual(requiredSandboxBinaries('linux'), ['bwrap', 'socat']);
  assert.deepEqual(requiredSandboxBinaries('darwin'), []);
  assert.deepEqual(requiredSandboxBinaries('win32'), []);
});

test('linux with both binaries reports nothing missing, no hint, no refusal and no warning', () => {
  const report = linuxReport(['bwrap', 'socat']);
  assert.deepEqual(report.missingBinaries, []);
  assert.equal(report.installHint, null);
  assert.equal(sandboxSpawnRefusal(report), null);
  assert.equal(sandboxBootWarning(report), null);
  assert.equal(sandboxInstallNotice(report), null);
  assert.deepEqual(sandboxDoctorRows(report), [['bwrap', 'found'], ['socat', 'found']]);
});

test('linux missing socat names it with one install hint naming both packages', () => {
  const report = linuxReport(['bwrap']);
  assert.deepEqual(report.missingBinaries, ['socat']);
  assert.equal(report.installHint, 'Install bubblewrap and socat, for example: sudo apt install bubblewrap socat');
  assert.equal(sandboxSpawnRefusal(report), `not started: the Claude Code sandbox needs bwrap and socat, and socat is not on PATH. ${SANDBOX_INSTALL_HINT}`);
  assert.deepEqual(sandboxDoctorRows(report), [['bwrap', 'found'], ['socat', 'MISSING'], ['hint', SANDBOX_INSTALL_HINT]]);
});

test('linux missing both names the four sandboxed lanes in the boot warning', () => {
  const report = linuxReport([]);
  assert.deepEqual(report.missingBinaries, ['bwrap', 'socat']);
  assert.equal(
    sandboxBootWarning(report),
    `[sandbox] bwrap and socat are not on PATH, so team review, Keep mergeable repairs, workflow sessions, benchmark runs will refuse to start sandboxed sessions. ${SANDBOX_INSTALL_HINT}`,
  );
  assert.match(String(sandboxInstallNotice(report)), /bwrap and socat are not on PATH.*sudo apt install bubblewrap socat$/);
});

test('a non-linux platform is never refused and the doctor says nothing was checked', () => {
  const report = sandboxDependencyReport({ platform: 'darwin', binariesOnPath: new Set() });
  assert.deepEqual(report.missingBinaries, []);
  assert.equal(sandboxSpawnRefusal(report), null);
  assert.equal(sandboxInstallNotice(report), null);
  assert.deepEqual(sandboxDoctorRows(report), [['sandbox', 'nothing to check on darwin']]);
});

test('the probe reuses the shared PATH lookup and treats a failed lookup as missing', () => {
  const lookups: string[] = [];
  const report = probeSandboxDependencies({
    platform: 'linux',
    exec: (command: string) => {
      lookups.push(command);
      if (command.includes('bwrap')) return '/usr/bin/bwrap\n';
      throw new Error('not found');
    },
  });
  assert.deepEqual(report.missingBinaries, ['socat']);
  assert.ok(lookups.some((command) => command.startsWith('which -a bwrap')));
  assert.equal(probeSandboxDependencies({ platform: 'darwin', exec: () => { throw new Error('never probed'); } }).missingBinaries.length, 0);
});

test('the boot check probes once, warns once, and every spawn reads the cached refusal', () => {
  const warnings: string[] = [];
  let probes = 0;
  const refusal = checkSandboxDependencies({ probe: () => { probes += 1; return linuxReport(['socat']); }, log: { warn: (message) => { warnings.push(message); } } });
  assert.match(String(refusal()), /^not started: .*bwrap is not on PATH/);
  assert.equal(refusal(), refusal());
  assert.equal(probes, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /team review, Keep mergeable repairs, workflow sessions, benchmark runs/);
});

test('a boot check that finds everything warns nothing and refuses nothing', () => {
  const warnings: string[] = [];
  const refusal = checkSandboxDependencies({ probe: () => linuxReport(['bwrap', 'socat']), log: { warn: (message) => { warnings.push(message); } } });
  assert.equal(refusal(), null);
  assert.deepEqual(warnings, []);
});

test('doctor prints a Sandbox section with MISSING rows and the install hint when neither binary is on PATH', { skip: !isLinuxWithWhich }, () => {
  const emptyPathDir = pathDirWithStubs([]);
  try {
    const result = runWithPath(['bin/glimmervoid.ts', 'doctor'], emptyPathDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[ SANDBOX \]/);
    assert.match(result.stdout, /bwrap\s+.*MISSING/);
    assert.match(result.stdout, /socat\s+.*MISSING/);
    assert.match(result.stdout, /sudo apt install bubblewrap socat/);
  } finally {
    fs.rmSync(emptyPathDir, { recursive: true, force: true });
  }
});

test('doctor reports both sandbox binaries found when they are on PATH', { skip: !isLinuxWithWhich }, () => {
  const stubPathDir = pathDirWithStubs(['bwrap', 'socat']);
  try {
    const result = runWithPath(['bin/glimmervoid.ts', 'doctor'], stubPathDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bwrap\s+.*found/);
    assert.match(result.stdout, /socat\s+.*found/);
    assert.doesNotMatch(result.stdout, /sudo apt install bubblewrap socat/);
  } finally {
    fs.rmSync(stubPathDir, { recursive: true, force: true });
  }
});

test('postinstall prints one sandbox hint line when a binary is missing and stays silent when both are found', { skip: !isLinuxWithWhich }, () => {
  const missingPathDir = pathDirWithStubs(['bwrap']);
  const foundPathDir = pathDirWithStubs(['bwrap', 'socat']);
  try {
    const missing = runWithPath(['scripts/postinstall-path-check.ts'], missingPathDir);
    assert.equal(missing.status, 0, missing.stderr);
    const hintLines = missing.stdout.split('\n').filter((outputLine) => outputLine.includes('sudo apt install bubblewrap socat'));
    assert.deepEqual(hintLines, [`glimmervoid: socat is not on PATH; team review, Keep mergeable, workflow sessions and benchmark runs need bwrap and socat. ${SANDBOX_INSTALL_HINT}`]);
    const found = runWithPath(['scripts/postinstall-path-check.ts'], foundPathDir);
    assert.equal(found.status, 0, found.stderr);
    assert.doesNotMatch(found.stdout, /bubblewrap/);
  } finally {
    fs.rmSync(missingPathDir, { recursive: true, force: true });
    fs.rmSync(foundPathDir, { recursive: true, force: true });
  }
});
