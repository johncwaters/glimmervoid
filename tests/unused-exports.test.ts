import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const EXPORTING_ROOTS = new Set(['server', 'session', 'detection', 'notifications', 'shared', 'public', 'knowledge-graph']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|astro|html)$/;
const MODULE_FILE = /\.(?:[cm]?[jt]s)$/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const EXPORTED_DECLARATION = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const EXPORT_STATEMENT = /^export\b/gm;
const NAMELESS_EXPORT = /^export\s+(?:default\b|(?:type\s+)?\*\s+from\b)/;

function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((repoPath) => SOURCE_FILE.test(repoPath) && fs.existsSync(path.join(ROOT, repoPath)));
}

function exportedNamesIn(sourceText: string): string[] {
  const declaredNames = [...sourceText.matchAll(EXPORTED_DECLARATION)].map((match) => match[1]);
  const listedNames = [...sourceText.matchAll(EXPORT_LIST)].flatMap((match) => match[1].split(',')
    .map((specifier) => specifier.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((specifier) => specifier.split(/\s+as\s+/).at(-1) ?? specifier));
  return [...new Set([...declaredNames, ...listedNames])].filter((name) => name !== 'default');
}

function unparsedExportLinesIn(sourceText: string): string[] {
  const parsedExportOffsets = new Set([...sourceText.matchAll(EXPORTED_DECLARATION), ...sourceText.matchAll(EXPORT_LIST)].map((match) => match.index));
  return [...sourceText.matchAll(EXPORT_STATEMENT)]
    .filter((match) => !parsedExportOffsets.has(match.index))
    .map((match) => sourceText.slice(match.index).split('\n', 1)[0])
    .filter((exportLine) => !NAMELESS_EXPORT.test(exportLine));
}

test('every export is named by some other tracked source file', () => {
  const sourceTextByPath = new Map(trackedSourceFiles().map((repoPath) => [repoPath, fs.readFileSync(path.join(ROOT, repoPath), 'utf8')]));
  const namingFileCountByIdentifier = new Map<string, number>();
  for (const sourceText of sourceTextByPath.values()) {
    for (const identifier of new Set(sourceText.match(IDENTIFIER))) {
      namingFileCountByIdentifier.set(identifier, (namingFileCountByIdentifier.get(identifier) ?? 0) + 1);
    }
  }
  const exportingModules = [...sourceTextByPath.keys()].filter((repoPath) => EXPORTING_ROOTS.has(repoPath.split('/')[0]) && MODULE_FILE.test(repoPath));
  assert.ok(exportingModules.length > 500, `expected to scan every module, only found ${exportingModules.length}`);

  const unparsedExports = exportingModules.flatMap((modulePath) => unparsedExportLinesIn(sourceTextByPath.get(modulePath) ?? '').map((exportLine) => `${modulePath}: ${exportLine}`));
  assert.deepEqual(unparsedExports, [], 'Rewrite the export as a named declaration or an export list so this gate can check it');

  const unusedExports: string[] = [];
  for (const modulePath of exportingModules) {
    const sourceText = sourceTextByPath.get(modulePath) ?? '';
    const ownIdentifiers = new Set(sourceText.match(IDENTIFIER));
    for (const exportedName of exportedNamesIn(sourceText)) {
      const otherNamingFiles = (namingFileCountByIdentifier.get(exportedName) ?? 0) - (ownIdentifiers.has(exportedName) ? 1 : 0);
      if (otherNamingFiles > 0) continue;
      unusedExports.push(`${modulePath}: ${exportedName}`);
    }
  }
  assert.deepEqual(unusedExports, [], 'Drop the export keyword, or delete the declaration when nothing in its module uses it either');
});
