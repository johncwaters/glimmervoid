import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import kimi from '../session/adapters/kimi.ts';
import { BLOCK_END, BLOCK_START } from '../session/core/kimi-hooks-block-core.ts';
import { loadFileLocks } from '../server/guardrails/session-temp-locks.ts';
import { generatedKimiHomePath, holdKimiHome, prepareKimiHome, releaseKimiHome, releaseUnheldKimiHomeSecrets } from '../session/kimi-home.ts';

const OPERATOR_CONFIG = 'default_model = "kimi-code/k3.1-pro"\r\n\n[models."kimi-code/k3.1-pro"]\ndisplay_name = "K3.1 Pro"\n';
const HAND_EDITED_OLD_BLOCK = `${BLOCK_START}\n[[hooks]]\nevent = "Stop"\ncommand = 'curl https://example.invalid'\n${BLOCK_END}\n`;

interface KimiHomes {
  realHome: string;
  env: Record<string, string>;
}

function withKimiHomes(run: (homes: KimiHomes) => void): void {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-kimi-'));
  const realHome = path.join(scratchRoot, '.kimi-code');
  fs.mkdirSync(path.join(realHome, 'credentials'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(realHome, 'device_id'), 'device-1\n');
  try {
    run({ realHome, env: { KIMI_CODE_HOME: realHome, GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') } });
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function prepare(env: Record<string, string>): string {
  const hooksBlock = kimi.expectedHooksBlock();
  assert.ok(hooksBlock);
  const prepared = prepareKimiHome({ env, hooksBlock });
  assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
  return prepared.home;
}

test('a kimi spawn gets a generated home that shares the real home and never writes the real config', () => {
  withKimiHomes(({ realHome, env }) => {
    const realConfigPath = path.join(realHome, 'config.toml');
    const realConfig = `${OPERATOR_CONFIG}${HAND_EDITED_OLD_BLOCK}`;
    fs.writeFileSync(realConfigPath, realConfig);

    const generatedHome = prepare(env);
    assert.equal(generatedHome, generatedKimiHomePath(env));
    assert.equal(fs.statSync(generatedHome).mode & 0o777, 0o700);
    const generatedConfigPath = path.join(generatedHome, 'config.toml');
    const generatedConfig = fs.readFileSync(generatedConfigPath, 'utf8');
    assert.equal(generatedConfig, `${OPERATOR_CONFIG}\n${kimi.expectedHooksBlock()}`);
    assert.equal(generatedConfig.split(BLOCK_START).length, 2);
    assert.equal(fs.statSync(generatedConfigPath).mode & 0o777, 0o600);

    fs.writeFileSync(path.join(generatedHome, 'credentials', 'kimi-code.json'), '{"refreshed":true}');
    assert.equal(fs.readFileSync(path.join(realHome, 'credentials', 'kimi-code.json'), 'utf8'), '{"refreshed":true}');
    assert.equal(fs.readFileSync(path.join(generatedHome, 'device_id'), 'utf8'), 'device-1\n');
    assert.equal(fs.existsSync(path.join(realHome, 'sessions')), false);

    const sessionEdit = `${generatedConfig}\n[tui]\ntheme = "dark"\n`;
    fs.writeFileSync(generatedConfigPath, sessionEdit);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8'), sessionEdit);

    fs.writeFileSync(generatedConfigPath, OPERATOR_CONFIG);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8').split(BLOCK_START).length, 2);

    fs.mkdirSync(path.join(realHome, 'sessions'));
    prepare(env);
    assert.equal(fs.realpathSync(path.join(generatedHome, 'sessions')), fs.realpathSync(path.join(realHome, 'sessions')));
    assert.equal(fs.readFileSync(realConfigPath, 'utf8'), realConfig);

    const sessionModelEdit = fs.readFileSync(generatedConfigPath, 'utf8').replace('default_model = "kimi-code/k3.1-pro"', 'default_model = "kimi-code/k3.1-flash"');
    fs.writeFileSync(generatedConfigPath, sessionModelEdit);
    fs.writeFileSync(realConfigPath, `${realConfig}\n[ui]\ntheme = "light"\n`);
    prepare(env);
    const mergedConfig = fs.readFileSync(generatedConfigPath, 'utf8');
    assert.match(mergedConfig, /default_model = "kimi-code\/k3\.1-flash"/);
    assert.match(mergedConfig, /\[ui\]\ntheme = "light"/);
    assert.equal(mergedConfig.split(BLOCK_START).length, 2);
    assert.equal(fs.statSync(path.join(generatedHome, '.glimmervoid-base.toml')).mode & 0o777, 0o600);

    const kimiRewriteWithoutMarkers = fs.readFileSync(generatedConfigPath, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n');
    fs.writeFileSync(generatedConfigPath, kimiRewriteWithoutMarkers);
    fs.writeFileSync(realConfigPath, `${realConfig}\n[ui]\ntheme = "dark"\n`);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8').split('[[hooks]]').length, kimi.expectedHooksBlock()?.split('[[hooks]]').length);

    const locks = loadFileLocks();
    assert.ok(locks);
    const otherInstanceLock = fs.openSync(path.join(generatedHome, '.glimmervoid-in-use.lock'), 'a+');
    locks.waitForLockSync(otherInstanceLock, { shared: true });
    releaseUnheldKimiHomeSecrets(generatedHome);
    holdKimiHome(generatedHome);
    releaseKimiHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), true);
    locks.unlock(otherInstanceLock);
    fs.closeSync(otherInstanceLock);

    holdKimiHome(generatedHome);
    holdKimiHome(generatedHome);
    releaseKimiHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), true);
    releaseKimiHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), false);
    assert.equal(fs.existsSync(path.join(generatedHome, '.glimmervoid-base.toml')), false);
    assert.equal(fs.readFileSync(path.join(generatedHome, 'device_id'), 'utf8'), 'device-1\n');
  });
});

test('a kimi spawn refuses a real config whose own hooks key a [[hooks]] block would redefine', () => {
  withKimiHomes(({ realHome, env }) => {
    const inlineHooks = `hooks = [{ event = "Stop", command = "say done" }]\n${OPERATOR_CONFIG}`;
    fs.writeFileSync(path.join(realHome, 'config.toml'), inlineHooks);
    const hooksBlock = kimi.expectedHooksBlock();
    assert.ok(hooksBlock);
    const prepared = prepareKimiHome({ env, hooksBlock });
    assert.ok('refusal' in prepared);
    assert.match(prepared.refusal, /\[hooks\] table/);
    assert.equal(fs.existsSync(path.join(generatedKimiHomePath(env), 'config.toml')), false);
    assert.equal(fs.readFileSync(path.join(realHome, 'config.toml'), 'utf8'), inlineHooks);
  });
});

test('a kimi spawn heals a file kimi replaced and adopts a private folder once the real home grows it', () => {
  withKimiHomes(({ realHome, env }) => {
    const generatedHome = prepare(env);
    const realDevicePath = path.join(realHome, 'device_id');
    const generatedDevicePath = path.join(generatedHome, 'device_id');

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-2\n');
    prepare(env);
    assert.equal(fs.readFileSync(realDevicePath, 'utf8'), 'device-2\n');
    assert.equal(fs.lstatSync(generatedDevicePath).isSymbolicLink(), true);

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-3\n');
    fs.writeFileSync(realDevicePath, 'device-from-operator\n');
    prepare(env);
    assert.equal(fs.readFileSync(realDevicePath, 'utf8'), 'device-from-operator\n');
    assert.equal(fs.readFileSync(generatedDevicePath, 'utf8'), 'device-from-operator\n');

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-4\n');
    fs.writeFileSync(realDevicePath, 'device-from-operator-again\n');
    prepare(env);
    const conflictsFolder = path.join(generatedHome, '.glimmervoid-conflicts');
    const setAsideContents = fs.readdirSync(conflictsFolder).map((name) => fs.readFileSync(path.join(conflictsFolder, name), 'utf8'));
    assert.deepEqual(setAsideContents.sort(), ['device-3\n', 'device-4\n']);

    const dotfilesDevicePath = path.join(path.dirname(realHome), 'dotfiles-device_id');
    fs.writeFileSync(dotfilesDevicePath, 'device-dotfiles\n');
    fs.rmSync(realDevicePath);
    fs.symlinkSync(dotfilesDevicePath, realDevicePath);
    prepare(env);
    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-5\n');
    prepare(env);
    assert.equal(fs.lstatSync(realDevicePath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(dotfilesDevicePath, 'utf8'), 'device-5\n');
    assert.deepEqual(fs.readdirSync(realHome).filter((name) => name.includes('glimmervoid')), []);

    fs.mkdirSync(path.join(generatedHome, 'sessions', 'session_b'), { recursive: true });
    fs.mkdirSync(path.join(generatedHome, 'logs'));
    fs.writeFileSync(path.join(generatedHome, 'logs', 'kimi.log'), 'private\n');
    fs.mkdirSync(path.join(realHome, 'sessions', 'session_a'), { recursive: true });
    fs.mkdirSync(path.join(realHome, 'logs'));
    fs.writeFileSync(path.join(realHome, 'logs', 'kimi.log'), 'real\n');
    prepare(env);
    assert.deepEqual(fs.readdirSync(path.join(realHome, 'sessions')).sort(), ['session_a', 'session_b']);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'sessions')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'logs')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(realHome, 'logs', 'kimi.log'), 'utf8'), 'real\n');

    fs.mkdirSync(path.join(generatedHome, 'cache', 'blob'), { recursive: true });
    fs.mkdirSync(path.join(realHome, 'cache'), { mode: 0o555 });
    prepare(env);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'cache')).isDirectory(), true);
    fs.chmodSync(path.join(realHome, 'cache'), 0o755);
  });
});
