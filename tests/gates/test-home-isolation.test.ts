import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TESTS_DIR = path.join(import.meta.dirname, '..');

const BACKEND_BOOT = /\bcreateBackend\s*\(/;
const SETS_CONFIG_ENV = /process\.env\.GLIMMERVOID_CONFIG\s*=/;
const TEMP_ROOT = /\bmkdtempSync\s*\(|\bos\.tmpdir\s*\(/;

function collectTestFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
      continue;
    }
    if (entry.isFile() && /\.test\.(js|ts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function readTestFiles(): { file: string; src: string }[] {
  const files = collectTestFiles(TESTS_DIR, []);
  assert.ok(files.length > 100, `expected to scan the suite, only found ${files.length} files`);
  return files.map((file) => ({ file: path.relative(TESTS_DIR, file), src: fs.readFileSync(file, 'utf8') }));
}

test('every backend-booting test points GLIMMERVOID_CONFIG at a throwaway config', () => {
  const offenders: string[] = [];
  for (const { file, src } of readTestFiles()) {
    if (!BACKEND_BOOT.test(src)) continue;
    if (!SETS_CONFIG_ENV.test(src)) offenders.push(`${file}: boots a backend without setting process.env.GLIMMERVOID_CONFIG`);
    if (SETS_CONFIG_ENV.test(src) && !TEMP_ROOT.test(src)) offenders.push(`${file}: sets GLIMMERVOID_CONFIG to a path outside os.tmpdir()`);
  }
  assert.deepEqual(offenders, [], `A backend booted on the resolved config writes into the operator's own ~/.glimmervoid:\n  ${offenders.join('\n  ')}`);
});

function isolationImportFor(file: string): string {
  const helperFromFile = path.relative(path.dirname(path.join(TESTS_DIR, file)), path.join(TESTS_DIR, 'helpers', 'isolate-home.ts')).split(path.sep).join('/');
  return `import '${helperFromFile.startsWith('.') ? helperFromFile : `./${helperFromFile}`}';`;
}

test('every test file imports the isolation helper first', () => {
  const offenders: string[] = [];
  for (const { file, src } of readTestFiles()) {
    const firstImport = src.split(/\r?\n/).find((line) => /^import\b/.test(line));
    if (firstImport !== isolationImportFor(file)) offenders.push(`${file}: first import must be ${isolationImportFor(file)}`);
  }
  assert.deepEqual(offenders, [], `A test file run as bare node --test resolves the operator's own home and temp folder unless its first import isolates them:\n  ${offenders.join('\n  ')}`);
});
