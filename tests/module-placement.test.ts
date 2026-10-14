import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const FEATURE_FOLDER_THRESHOLD = 5;
const WATCHED_ROOTS = [
  { label: 'server/ with server/core/', directories: ['server', 'server/core'] },
  { label: 'public/', directories: ['public'] },
];
const MODULE_EXTENSIONS = new Set(['.ts', '.mjs', '.js']);

function moduleNamesIn(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && MODULE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts'))
    .map((entry) => entry.name);
}

function firstWordOf(moduleName: string): string {
  return path.basename(moduleName, path.extname(moduleName)).split('-')[0];
}

test('five modules sharing a first word get a feature folder instead of crowding a root', () => {
  const crowdedGroups: string[] = [];
  for (const { label, directories } of WATCHED_ROOTS) {
    const modulesByFirstWord = new Map<string, string[]>();
    for (const directory of directories) {
      for (const moduleName of moduleNamesIn(directory)) {
        const firstWord = firstWordOf(moduleName);
        modulesByFirstWord.set(firstWord, [...(modulesByFirstWord.get(firstWord) ?? []), `${directory}/${moduleName}`]);
      }
    }
    for (const [firstWord, modules] of modulesByFirstWord) {
      if (modules.length < FEATURE_FOLDER_THRESHOLD) continue;
      crowdedGroups.push(`${label}: ${modules.length} ${firstWord}-* modules (${modules.join(', ')})`);
    }
  }
  assert.deepEqual(
    crowdedGroups,
    [],
    'Move each group into its own feature folder, with its pure cores in that folder\'s core/, as server/radar/ and public/github/ do',
  );
});
