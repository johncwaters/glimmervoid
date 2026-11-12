import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveFnoxPath } from '../server/runtime-paths.ts';
import { createFnoxRunner } from '../server/secrets/fnox-runner.ts';

const pinnedFnoxPath = resolveFnoxPath();
const cannotRunFakeOp = process.platform === 'win32' || !fs.existsSync(pinnedFnoxPath);

const FAKE_OP_SCRIPT = `#!/bin/sh
log="$(dirname "$0")/op.log"
reference=""
for argument in "$@"; do reference="$argument"; done
echo "start $reference" >> "$log"
case "$reference" in
  *SLOW*) sleep 2 ;;
  *) sleep 0.3 ;;
esac
echo "end $reference" >> "$log"
case "$reference" in
  *MISSING*) echo "[ERROR] \\"MISSING\\" isn't an item in the \\"Shelf\\" vault" >&2; exit 1 ;;
  *NOVAULT*) echo "[ERROR] \\"Shelf\\" isn't a vault in this account" >&2; exit 1 ;;
esac
printf 'value-of-%s' "$reference"
`;

function makeFakeOpWorld(readTimeoutMs?: number) {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-fnox-runner-'));
  const fakeBin = path.join(world, 'bin');
  const glimmervoidHome = path.join(world, 'home', '.glimmervoid');
  const runsRoot = path.join(glimmervoidHome, 'fnox-runs');
  const plantedGlobal = path.join(world, 'planted-global');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(plantedGlobal);
  fs.writeFileSync(path.join(fakeBin, 'op'), FAKE_OP_SCRIPT, { mode: 0o755 });
  const plantedConfig = '[secrets]\nGH_TOKEN = { default = "planted" }\n';
  for (const folder of [runsRoot, glimmervoidHome, path.dirname(glimmervoidHome), plantedGlobal]) fs.writeFileSync(path.join(folder, 'fnox.toml'), plantedConfig);
  fs.writeFileSync(path.join(plantedGlobal, 'config.toml'), plantedConfig);
  const environment = { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: path.join(world, 'home'), FNOX_CONFIG_DIR: plantedGlobal, FNOX_PROFILE: 'planted' };
  const runner = createFnoxRunner({ fnoxPath: pinnedFnoxPath, runsRoot, environment, readTimeoutMs });
  const opCalls = () => fs.readFileSync(path.join(fakeBin, 'op.log'), 'utf8').trim().split('\n');
  const leftoverRunFolders = () => fs.readdirSync(runsRoot).filter((entry) => entry !== 'fnox.toml');
  return { world, runner, opCalls, leftoverRunFolders };
}

test('a read takes only the vault and name Glimmervoid wrote, whatever fnox.toml or FNOX_ setting sits around it, and leaves no run folder', { skip: cannotRunFakeOp }, async () => {
  const { world, runner, opCalls, leftoverRunFolders } = makeFakeOpWorld();
  try {
    const outcome = await runner.read({ manager: '1password', lookIn: 'Shelf' }, 'GH_TOKEN');

    assert.deepEqual(outcome, { value: 'value-of-op://Shelf/GH_TOKEN/password' });
    assert.deepEqual(opCalls(), ['start op://Shelf/GH_TOKEN/password', 'end op://Shelf/GH_TOKEN/password']);
    assert.deepEqual(leftoverRunFolders(), []);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});

test('reads from many sessions run one at a time, and a missing item or vault fails with its own message, the helper output as detail and no value', { skip: cannotRunFakeOp }, async () => {
  const { world, runner, opCalls, leftoverRunFolders } = makeFakeOpWorld();
  try {
    const source = { manager: '1password', lookIn: 'Shelf' } as const;
    const [found, missing, missingVault] = await Promise.all([runner.read(source, 'GH_TOKEN'), runner.read(source, 'MISSING'), runner.read(source, 'NOVAULT_TOKEN')]);

    assert.deepEqual(found, { value: 'value-of-op://Shelf/GH_TOKEN/password' });
    assert.ok('failure' in missing);
    assert.equal(missing.failure.kind, 'not-found');
    assert.match(missing.failure.detail, /isn't an item in the "Shelf"/);
    assert.match(missing.failure.message, /has no item MISSING in Shelf/);
    assert.ok('failure' in missingVault);
    assert.match(missingVault.failure.message, /has no vault Shelf/);
    assert.deepEqual(opCalls(), ['start op://Shelf/GH_TOKEN/password', 'end op://Shelf/GH_TOKEN/password', 'start op://Shelf/MISSING/password', 'end op://Shelf/MISSING/password', 'start op://Shelf/NOVAULT_TOKEN/password', 'end op://Shelf/NOVAULT_TOKEN/password']);
    assert.deepEqual(leftoverRunFolders(), []);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});

test('a read that times out stops the password manager it started before the next read begins', { skip: cannotRunFakeOp }, async () => {
  const { world, runner, opCalls } = makeFakeOpWorld(500);
  try {
    const source = { manager: '1password', lookIn: 'Shelf' } as const;
    const [slow, found] = await Promise.all([runner.read(source, 'SLOW_TOKEN'), runner.read(source, 'GH_TOKEN')]);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    assert.ok('failure' in slow);
    assert.equal(slow.failure.kind, 'timed-out');
    assert.deepEqual(found, { value: 'value-of-op://Shelf/GH_TOKEN/password' });
    assert.deepEqual(opCalls(), ['start op://Shelf/SLOW_TOKEN/password', 'start op://Shelf/GH_TOKEN/password', 'end op://Shelf/GH_TOKEN/password']);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});

test('a connection test asks the password manager who is signed in and reads no item', { skip: cannotRunFakeOp }, async () => {
  const { world, runner, opCalls } = makeFakeOpWorld();
  try {
    const outcome = await runner.test({ manager: '1password', lookIn: 'Shelf' });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.match(outcome.message, /^Signed in to 1Password/);
    assert.deepEqual(opCalls(), ['start whoami', 'end whoami']);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});
