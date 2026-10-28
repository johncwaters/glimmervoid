import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import kimi from '../session/adapters/kimi.ts';
import { BLOCK_END, BLOCK_START } from '../session/core/kimi-hooks-block-core.ts';
import { generatedKimiHomePath, prepareKimiHome } from '../session/kimi-home.ts';

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
