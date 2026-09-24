import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRECTORIES = ['server', 'session', 'detection', 'notifications'];
const STATUS_ARGV = /\[[^\][]*'status',\s*'--porcelain[^\][]*\]/g;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

test('every git status probe passes --no-optional-locks so a killed poll never strands index.lock', () => {
  const offenders: string[] = [];
  let probesFound = 0;
  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(path.join(REPO_ROOT, directory))) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(STATUS_ARGV)) {
        probesFound += 1;
        if (!match[0].includes("'--no-optional-locks'")) offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`);
      }
    }
  }
  assert.ok(probesFound > 0, 'the scan found no status probes, so its pattern has drifted');
  assert.deepEqual(offenders, []);
});
