import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractImportSpecifiers } from '../../server/core/import-graph-core.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const CHAT_DIRECTORY = path.join(ROOT, 'public', 'chat');
const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s|css|html)$/;
const CSS_URL_IMPORT = /@import\s+url\(\s*['"]?([^'")\s]+)/g;
const DYNAMIC_IMPORT_CALL = /\bimport\s*\(\s*([^)]*)\)/g;
const PLAIN_QUOTED_SPECIFIER = /^(['"])[^'"]+\1$/;
const ALLOWED_PACKAGE_PATTERNS = [/^@pierre\/diffs(\/|$)/, /^@xterm\//, /^shiki(\/|$)/];

function chatSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return chatSourceFiles(absolutePath);
    return SOURCE_FILE.test(entry.name) ? [absolutePath] : [];
  });
}

function isBarePackage(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('#') && !specifier.startsWith('/');
}

function importSpecifiersOf(sourceText: string): string[] {
  const cssUrlSpecifiers = [...sourceText.matchAll(CSS_URL_IMPORT)].map((match) => match[1] ?? '');
  const unreadableDynamicImports = [...sourceText.matchAll(DYNAMIC_IMPORT_CALL)]
    .map((match) => (match[1] ?? '').trim())
    .filter((argument) => !PLAIN_QUOTED_SPECIFIER.test(argument))
    .map((argument) => `import(${argument})`);
  return [...extractImportSpecifiers(sourceText), ...cssUrlSpecifiers, ...unreadableDynamicImports];
}

test('public/chat imports no bare package outside the chat allowlist', () => {
  const files = chatSourceFiles(CHAT_DIRECTORY);
  assert.ok(files.length > 0, 'public/chat has no sources, so the gate would pass vacuously');
  const offenders = files.flatMap((file) => importSpecifiersOf(fs.readFileSync(file, 'utf8'))
    .filter((specifier) => isBarePackage(specifier) && !ALLOWED_PACKAGE_PATTERNS.some((pattern) => pattern.test(specifier)))
    .map((specifier) => `${path.relative(ROOT, file)}: ${specifier}`));
  assert.deepEqual(offenders, [], `Chat components are our own; import only @pierre/diffs, @xterm/* or shiki:\n  ${offenders.join('\n  ')}`);
});
