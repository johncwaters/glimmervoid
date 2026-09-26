import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');

test('doctor reports each pack carrier and the codex hook-trust caveat', () => {
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-doctor-'));
  try {
    const result = spawnSync(process.execPath, ['bin/glimmervoid.ts', 'doctor'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_prefix: npmPrefix },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude-code pack carrier\s+--add-dir directories/);
    assert.match(result.stdout, /codex pack carrier\s+developer_instructions index pointers/);
    assert.match(result.stdout, /grok pack carrier\s+--rules index pointers/);
    assert.match(result.stdout, /codex pack notices\s+staleness notices require trusted UserPromptSubmit hooks or the hook-trust bypass/);
    assert.match(result.stdout, /node-pty\s+loads OK/);
  } finally {
    fs.rmSync(npmPrefix, { recursive: true, force: true });
  }
});

test('doctor reports the config file named by --config, not the default one', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-doctor-config-'));
  try {
    const configPath = path.join(scratch, 'alternate-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projects: [] }));
    const result = spawnSync(process.execPath, ['bin/glimmervoid.ts', 'doctor', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_prefix: scratch, GLIMMERVOID_CONFIG: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const resolvedConfigLine = result.stdout.split('\n').find((outputLine) => outputLine.includes('resolved config'));
    assert.ok(resolvedConfigLine?.includes(configPath), result.stdout);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
