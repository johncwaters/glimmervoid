import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from '../server/child-process-safe.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('doctor reports every builtin agent and a loading node-pty', () => {
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-doctor-'));
  try {
    const stdout = execFileSync(process.execPath, ['bin/glimmervoid.ts', 'doctor'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: npmPrefix, USERPROFILE: npmPrefix, GLIMMERVOID_HOME: npmPrefix, npm_config_prefix: npmPrefix },
    });
    assert.match(stdout, /claude-code \(Claude Code\)/);
    assert.match(stdout, /codex \(Codex CLI\)/);
    assert.match(stdout, /grok \(Grok Build\)/);
    assert.match(stdout, /Sane YOLO/);
    assert.match(stdout, /cc-safety-net version\s+2\.6\.0/);
    assert.match(stdout, /inactive unless Codex trusts/);
    assert.match(stdout, /inactive; run glimmervoid agent setup grok/);
    assert.match(stdout, /node-pty\s+loads OK/);
  } finally {
    fs.rmSync(npmPrefix, { recursive: true, force: true });
  }
});

test('doctor reports the config file named by --config, not the default one', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-doctor-config-'));
  try {
    const configPath = path.join(scratch, 'alternate-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projects: [] }));
    const stdout = execFileSync(process.execPath, ['bin/glimmervoid.ts', 'doctor', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, GLIMMERVOID_HOME: scratch, npm_config_prefix: scratch, GLIMMERVOID_CONFIG: '' },
    });
    const resolvedConfigLine = stdout.split('\n').find((outputLine) => outputLine.includes('resolved config'));
    assert.ok(resolvedConfigLine?.includes(configPath), stdout);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('removed pack command exits with usage before server startup', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-unknown-command-'));
  try {
    const configPath = path.join(scratch, 'config.json');
    assert.throws(() => execFileSync(process.execPath, ['bin/glimmervoid.ts', 'pack'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, GLIMMERVOID_HOME: scratch, GLIMMERVOID_CONFIG: configPath },
      stdio: 'pipe',
    }), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'status' in error && 'stderr' in error);
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /Unknown command: pack/);
      assert.match(String(error.stderr), /Usage: glimmervoid/);
      return true;
    });
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
