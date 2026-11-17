import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileSync } from '../server/child-process-safe.ts';
import { resolveFnoxPath } from '../server/runtime-paths.ts';
import { createAgeStore } from '../server/secrets/age-store.ts';
import { createFnoxRunner } from '../server/secrets/fnox-runner.ts';

const pinnedFnoxPath = resolveFnoxPath();
const cannotRunFakeOp = process.platform === 'win32' || !fs.existsSync(pinnedFnoxPath);
const cannotRunFnox = !fs.existsSync(pinnedFnoxPath);

const FAKE_OP_SCRIPT = `#!/bin/sh
log="$(dirname "$0")/op.log"
reference=""
for argument in "$@"; do reference="$argument"; done
echo "start $reference" >> "$log"
case "$1 $2 $reference" in
  "whoami "*) echo "end $reference" >> "$log"; echo "[ERROR] account is not signed in" >&2; exit 1 ;;
  "item list --vault=Shelf") echo "end $reference" >> "$log"; printf '[{"id":"one","title":"GH_TOKEN"}]'; exit 0 ;;
  "item list --vault="*) echo "end $reference" >> "$log"; echo "[ERROR] \\"\${reference#--vault=}\\" isn't a vault in this account." >&2; exit 1 ;;
esac
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
  const ageFile = { storePath: path.join(world, 'no-age-store.toml'), keyPath: path.join(world, 'no-age-key.txt') };
  const runner = createFnoxRunner({ fnoxPath: pinnedFnoxPath, runsRoot, ageFile, environment, readTimeoutMs });
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

test('a connection test opens the Look in vault the way a read signs in, reads no secret, and names a vault that is not there', { skip: cannotRunFakeOp }, async () => {
  const { world, runner, opCalls } = makeFakeOpWorld();
  try {
    const opened = await runner.test({ manager: '1password', lookIn: 'Shelf' });
    const missingVault = await runner.test({ manager: '1password', lookIn: 'Attic' });

    assert.deepEqual(opened, { ok: true, message: '1Password opened the vault Shelf', detail: '' });
    assert.equal(missingVault.ok, false);
    assert.equal(missingVault.message, '1Password has no vault Attic. Check Look in');
    assert.deepEqual(opCalls(), ['start --vault=Shelf', 'end --vault=Shelf', 'start --vault=Attic', 'end --vault=Attic']);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});

test('an age file Glimmervoid created reads back an allowed name through the pinned fnox, names a missing value or key, never mints a key the age file cannot use, and Test connection counts names without the key', { skip: cannotRunFnox }, async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-age-file-'));
  try {
    const glimmervoidHome = path.join(world, '.glimmervoid');
    const ageStore = createAgeStore({ glimmervoidHome });
    const emptyConfigFolder = path.join(world, 'empty-global');
    fs.mkdirSync(emptyConfigFolder);
    const environment = { PATH: process.env.PATH ?? '', HOME: world, FNOX_CONFIG_DIR: path.join(world, 'planted-global') };
    const runner = createFnoxRunner({ fnoxPath: pinnedFnoxPath, runsRoot: path.join(glimmervoidHome, 'fnox-runs'), ageFile: ageStore, environment });
    const source = { manager: 'age' } as const;

    const beforeAnything = await runner.read(source, 'GH_TOKEN');
    assert.ok('failure' in beforeAnything);
    assert.equal(beforeAnything.failure.message, 'The age file has no GH_TOKEN');
    assert.deepEqual(await ageStore.test(), { ok: true, message: 'The age file is empty. The first value you save on a request card creates it', detail: '' });

    await ageStore.ensureCreated();
    execFileSync(pinnedFnoxPath, ['-c', ageStore.storePath, '--no-daemon', '--non-interactive', 'set', '-p', 'source', 'GH_TOKEN'], { input: 'age-held-value', env: { ...environment, FNOX_CONFIG_DIR: emptyConfigFolder } });

    assert.deepEqual(await runner.read(source, 'GH_TOKEN'), { value: 'age-held-value' });
    assert.doesNotMatch(fs.readFileSync(ageStore.storePath, 'utf8'), /age-held-value/);
    const missing = await runner.read(source, 'OTHER_TOKEN');
    assert.ok('failure' in missing);
    assert.equal(missing.failure.kind, 'not-found');
    assert.equal(missing.failure.message, 'The age file has no OTHER_TOKEN');
    assert.deepEqual(await ageStore.test(), { ok: true, message: 'The age key is in place and the age file holds 1 name', detail: '' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(ageStore.keyPath).mode & 0o777, 0o600);

    fs.rmSync(ageStore.keyPath);
    const withoutKey = await runner.read(source, 'GH_TOKEN');
    assert.ok('failure' in withoutKey);
    assert.equal(withoutKey.failure.message, 'The age key is missing or unreadable, so Glimmervoid cannot read GH_TOKEN');
    assert.equal((await ageStore.test()).ok, false);
    await assert.rejects(ageStore.ensureCreated(), /is missing while the age file/);
    assert.equal(fs.existsSync(ageStore.keyPath), false);
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }
});
