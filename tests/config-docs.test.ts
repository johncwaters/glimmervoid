import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONFIGURATION_DOC_PATH,
  ENVIRONMENT_VARIABLES,
  UNLISTED_KEY_NOTES,
  renderConfigurationDoc,
  unlistedConfigKeys,
} from '../scripts/generate-config-docs.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const SCANNED_TREES = ['server', 'session', 'shared', 'bin'];
const ENV_READ_PATTERNS = [
  /\benv\.(GLIMMERVOID_[A-Z0-9_]+)/g,
  /\benv\[\s*['"](GLIMMERVOID_[A-Z0-9_]+)['"]\s*\]/g,
  /_ENV\s*=\s*['"](GLIMMERVOID_[A-Z0-9_]+)['"]/g,
  /environmentVariable:\s*['"](GLIMMERVOID_[A-Z0-9_]+)['"]/g,
];

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(fullPath));
      continue;
    }
    if (/\.(ts|mjs|js)$/.test(entry.name)) found.push(fullPath);
  }
  return found;
}

function environmentVariablesReadByCode(): Set<string> {
  const names = new Set<string>();
  const files = SCANNED_TREES.flatMap((tree) => sourceFilesUnder(path.join(REPO_ROOT, tree)));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of ENV_READ_PATTERNS) {
      for (const match of source.matchAll(pattern)) names.add(match[1]);
    }
  }
  return names;
}

test('docs/configuration.md matches what npm run docs:config generates', () => {
  const committed = fs.readFileSync(CONFIGURATION_DOC_PATH, 'utf8');
  assert.equal(committed, renderConfigurationDoc(), 'docs/configuration.md is stale: run npm run docs:config');
});

test('every GLIMMERVOID_* variable the code reads has a row in the environment table', () => {
  const documented = new Set(ENVIRONMENT_VARIABLES.map((variable) => variable.name));
  const undocumented = [...environmentVariablesReadByCode()].filter((name) => !documented.has(name)).sort();
  assert.deepEqual(undocumented, [], 'add each to ENVIRONMENT_VARIABLES in scripts/generate-config-docs.ts');
});

test('the environment table lists no variable the code no longer reads', () => {
  const readByCode = environmentVariablesReadByCode();
  const stale = ENVIRONMENT_VARIABLES.map((variable) => variable.name).filter((name) => !readByCode.has(name));
  assert.deepEqual(stale, []);
});

test('every config key outside the Settings view carries a note, and no note outlives its key', () => {
  const unlisted = unlistedConfigKeys();
  assert.deepEqual(unlisted.filter((key) => !UNLISTED_KEY_NOTES[key]), []);
  assert.deepEqual(Object.keys(UNLISTED_KEY_NOTES).filter((key) => !unlisted.includes(key)), []);
});

test('the PostHog lane still refuses to start without Telegram, as the reference says', () => {
  const wiring = fs.readFileSync(path.join(REPO_ROOT, 'server', 'posthog-wiring.ts'), 'utf8');
  assert.match(wiring, /posthog\.enabled but telegram botToken\/chatId missing/);
});
