import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectKimiAgentSetup, runAgentSetupCli } from '../server/agent-setup-cli.ts';
import { BLOCK_END, BLOCK_START } from '../session/core/kimi-hooks-block-core.ts';

const OPERATOR_CONFIG = 'default_model = "kimi-code/k3.1-pro"\r\n\n[models."kimi-code/k3.1-pro"]\ndisplay_name = "K3.1 Pro"';

function withKimiHome(run: (kimiHome: string, configPath: string) => void): void {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-kimi-'));
  const kimiHome = path.join(scratchRoot, '.kimi-code');
  fs.mkdirSync(kimiHome, { mode: 0o700 });
  try {
    run(kimiHome, path.join(kimiHome, 'config.toml'));
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSetup(kimiHome: string): { exitCode: number; errors: string[] } {
  const errors: string[] = [];
  const exitCode = runAgentSetupCli(['setup', 'kimi'], {
    env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    log: () => {},
    error: (message) => errors.push(message),
  });
  return { exitCode, errors };
}

test('kimi setup appends the managed block, keeps every operator byte, and is idempotent', () => {
  withKimiHome((kimiHome, configPath) => {
    fs.writeFileSync(configPath, OPERATOR_CONFIG);
    assert.equal(runSetup(kimiHome).exitCode, 0);
    const installed = fs.readFileSync(configPath, 'utf8');
    assert.ok(installed.startsWith(`${OPERATOR_CONFIG}\n\n${BLOCK_START}\n`));
    assert.ok(installed.endsWith(`${BLOCK_END}\n`));
    assert.match(installed, /event = "PreToolUse"\nmatcher = '\^AskUserQuestion\$'/);
    assert.equal(inspectKimiAgentSetup({ env: { KIMI_CODE_HOME: kimiHome } }).classification, 'current');
    assert.equal(runSetup(kimiHome).exitCode, 0);
    assert.equal(fs.readFileSync(configPath, 'utf8'), installed);
  });
});

test('kimi setup replaces a stale managed block in place and refuses a hand-edited one', () => {
  withKimiHome((kimiHome, configPath) => {
    const staleBlock = `${BLOCK_START}\n[[hooks]]\nevent = "Stop"\ncommand = 'node /old/dist/hook-relay.js Stop'\n${BLOCK_END}\n`;
    const trailer = '\n[tui]\ntheme = "dark"\n';
    fs.writeFileSync(configPath, `${OPERATOR_CONFIG}\n${staleBlock}${trailer}`);
    assert.equal(inspectKimiAgentSetup({ env: { KIMI_CODE_HOME: kimiHome } }).classification, 'managed-stale');
    assert.equal(runSetup(kimiHome).exitCode, 0);
    const replaced = fs.readFileSync(configPath, 'utf8');
    assert.ok(replaced.startsWith(`${OPERATOR_CONFIG}\n${BLOCK_START}\n`));
    assert.ok(replaced.endsWith(`${BLOCK_END}\n${trailer}`));
    assert.doesNotMatch(replaced, /\/old\/dist/);

    const handEdited = replaced.replace(`${BLOCK_END}\n`, `command = 'curl https://example.invalid'\n${BLOCK_END}\n`);
    fs.writeFileSync(configPath, handEdited);
    const refusal = runSetup(kimiHome);
    assert.equal(refusal.exitCode, 1);
    assert.match(refusal.errors.join('\n'), /edited by hand/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), handEdited);
  });
});

test('kimi setup refuses a config whose own hooks key a [[hooks]] block would redefine', () => {
  withKimiHome((kimiHome, configPath) => {
    const inlineHooks = `hooks = [{ event = "Stop", command = "say done" }]\n${OPERATOR_CONFIG}\n`;
    fs.writeFileSync(configPath, inlineHooks);
    const refusal = runSetup(kimiHome);
    assert.equal(refusal.exitCode, 1);
    assert.match(refusal.errors.join('\n'), /\[hooks\] table/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), inlineHooks);
    assert.equal(inspectKimiAgentSetup({ env: { KIMI_CODE_HOME: kimiHome } }).classification, 'conflicting');
  });
});
