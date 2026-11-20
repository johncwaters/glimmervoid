import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from '../server/child-process-safe.ts';

const ROOT = path.join(import.meta.dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

const PATCHED_LAUNCHES_SCRIPT = `
import { createRequire } from 'node:module';
const [impostorPath, safeModuleUrl, shellProgram, shellFlag] = process.argv.slice(-4);
const require = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});
process.execPath = impostorPath;
process.argv[0] = impostorPath;
require('@yao-pkg/pkg/prelude/bootstrap-shared.js').patchChildProcess(impostorPath);
const { execFileAsync, execSync } = await import(safeModuleUrl);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
const env = { ...baseEnv, PATH: ${JSON.stringify(path.dirname(process.execPath))} };
const direct = await execFileAsync('node', ['-p', 'process.execPath'], { env, encoding: 'utf8' });
const shell = await execFileAsync(shellProgram, [shellFlag, 'node -p process.execPath'], { env, encoding: 'utf8' });
const shellSync = execSync('node -p process.execPath', { env, encoding: 'utf8' });
const missing = await execFileAsync('node', ['-v'], { env: { ...baseEnv, PATH: '' }, encoding: 'utf8' }).then(() => 'ran', (error) => error.code);
console.log(JSON.stringify({ direct: direct.stdout.trim(), shell: shell.stdout.trim(), shellSync: shellSync.trim(), missing }));
`;

test('a bare node launched under the pkg child_process patch runs the Node on PATH, never the binary itself', () => {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-launch-'));
  const impostorPath = path.join(scratchDirectory, IS_WINDOWS ? 'glimmervoid.exe' : 'glimmervoid');
  fs.copyFileSync(process.execPath, impostorPath);
  const safeModuleUrl = new URL('../server/child-process-safe.ts', import.meta.url).href;
  const [shellProgram, shellFlag] = IS_WINDOWS ? ['cmd.exe', '/c'] : ['/bin/sh', '-c'];
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', PATCHED_LAUNCHES_SCRIPT, impostorPath, safeModuleUrl, shellProgram, shellFlag], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { direct: process.execPath, shell: process.execPath, shellSync: process.execPath, missing: 'ENOENT' });
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});
