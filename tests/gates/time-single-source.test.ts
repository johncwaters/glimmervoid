import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const CLOCK_OWNER = 'shared/clock.ts';
const SCANNED_DIRECTORIES = ['bin', 'cloud', 'detection', 'mcp', 'notifications', 'public', 'scripts', 'server', 'session', 'shared'];
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;
const DIRECT_TIME_READS = [
  /\bDate\.now\b/,
  /\bnew\s+Date\(\s*\)/,
  /(?<![.\w]|new\s)Date\(/,
  /\bnew\s+Date\([^()]*,/,
  /\bglobalThis\.Date\b/,
  /\bDate\s*\[/,
  /\.(?:get|set)(?:FullYear|Month|Date|Day|Hours|Minutes)\(/,
  /\.toLocale(?:Date|Time)?String\(/,
  /\.to(?:Date|Time)String\(/,
  /\bIntl\.DateTimeFormat\b/,
  /\bgetTimezoneOffset\(/,
];

function scannedSourceFiles(): string[] {
  return SCANNED_DIRECTORIES.flatMap((directory) => fs.readdirSync(path.join(REPO_ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name))
    .map((entry) => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !file.includes('/node_modules/')));
}

test('every time read and timezone-dependent date call goes through the shared clock', () => {
  const offenders = scannedSourceFiles()
    .filter((file) => file !== CLOCK_OWNER)
    .flatMap((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n')
      .flatMap((line, index) => (DIRECT_TIME_READS.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}`] : [])));
  assert.deepEqual(offenders, [], `read time through clock from ${CLOCK_OWNER}: clock.nowMs(), clock.now(), clock.partsOf, clock.dayKeyOf, clock.startOfDay, clock.format`);
});
