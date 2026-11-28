import '../helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HELPER_PATH = path.join(REPO_ROOT, 'harness', 'support', 'git-local-env.ts');
const HARNESS_DIRECTORY = path.join(REPO_ROOT, 'harness');
const SCRIPTS_DIRECTORY = path.join(REPO_ROOT, 'scripts');

const BACKEND_ENTRY_SPECIFIER = String.raw`(?:[./]*server\/(?:backend\/backend|main|index)\.ts|vite)`;
const BOOTS_BACKEND_STATIC = new RegExp(String.raw`^import\s+(?!type\b)[^;]*?['"]${BACKEND_ENTRY_SPECIFIER}['"]`, 'm');
const BOOTS_BACKEND_DYNAMIC = new RegExp(String.raw`import\(\s*['"]${BACKEND_ENTRY_SPECIFIER}['"]\s*\)`);
const TOP_LEVEL_ENTRY_SIGNAL = /^(?:(?:await|void)\s+)?main\(|^if\s*\([^)]*(?:import\.meta\.main|process\.argv\[1\])|^process\.exitCode\s*=|\bprocess\.exit\(/m;
const GIT_OR_SUBPROCESS_SIGNAL = /\b(?:child_process|runGit|runCommand|runCommandSafely|createProject)\b|isolated-glimmervoid\.ts|backend-harness\.ts/;
const SCRIPT_GIT_OR_TEST_SIGNAL = /\b(?:spawnSync|execFileSync|execFile|execSync|spawn)\s*\(\s*(?:['"`]git\b|process\.execPath\b)|\brunGit\b/;

const LIBRARY_MODULES_BOOTING_BACKEND = new Set([
  'harness/load-cost/whiteboard-bench.ts',
  'harness/site-capture/isolated-glimmervoid.ts',
]);

const SPAWNED_CHILD_SHIMS = new Set([
  'harness/browser/fake-agent.ts',
  'harness/browser/fake-acp-agent.ts',
  'harness/load-cost/scrollback-agent.ts',
  'harness/site-capture/glimmervoid-call-log.ts',
  'harness/site-capture/replay-agent.ts',
]);

const REPO_MUTATING_SCRIPTS: Readonly<Record<string, string>> = {
  'scripts/release.ts': 'intentionally tags and pushes the real repository',
};

function toPosixRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function listTsFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => relativePath.endsWith('.ts'))
    .map((relativePath) => path.join(directory, relativePath))
    .sort();
}

function packageJsonTsEntries(): Set<string> {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const entries = new Set<string>();
  for (const command of Object.values(packageJson.scripts ?? {})) {
    for (const match of command.matchAll(/\bnode\s+((?:scripts|harness)\/[^\s'"]+\.ts)\b/g)) {
      entries.add(match[1]);
    }
  }
  return entries;
}

function expectedHelperSpecifierFor(filePath: string): string {
  const relative = path.relative(path.dirname(filePath), HELPER_PATH).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const TELEMETRY_KILL_SWITCH_IMPORT = /^import\s+['"][./]*(?:harness\/)?(?:support\/)?disable-telemetry\.ts['"];?$/;

function leadingImportLinesOf(source: string): string[] {
  const importLines: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('import ')) break;
    importLines.push(trimmed);
    if (importLines.length >= 2) break;
  }
  return importLines;
}

function hasValueImportSpecifiers(namedClause: string): boolean {
  const braceMatch = /^\{([^}]*)\}$/.exec(namedClause.trim());
  if (!braceMatch) return true;
  const specifiers = braceMatch[1].split(',').map((part) => part.trim()).filter((part) => part !== '');
  return specifiers.some((specifier) => !/^type\s+/.test(specifier));
}

function isRuntimeGitLocalEnvImport(filePath: string, importLine: string): boolean {
  const specifier = expectedHelperSpecifierFor(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sideEffectImport = new RegExp(String.raw`^import\s+['"]${specifier}['"];?$`);
  if (sideEffectImport.test(importLine)) return true;
  const valueImport = new RegExp(String.raw`^import\s+(?!type\b)(.+?)\s+from\s+['"]${specifier}['"];?$`);
  const match = valueImport.exec(importLine);
  if (!match) return false;
  return hasValueImportSpecifiers(match[1]);
}

function importsGitLocalEnvAtTop(filePath: string, source: string): boolean {
  const importLines = leadingImportLinesOf(source);
  if (importLines.length === 0) return false;
  if (isRuntimeGitLocalEnvImport(filePath, importLines[0])) return true;
  if (importLines.length < 2) return false;
  return TELEMETRY_KILL_SWITCH_IMPORT.test(importLines[0]) && isRuntimeGitLocalEnvImport(filePath, importLines[1]);
}

function requiredHarnessEntries(packageEntries: ReadonlySet<string>): string[] {
  return listTsFilesUnder(HARNESS_DIRECTORY).filter((filePath) => {
    const repoPath = toPosixRelative(filePath);
    if (repoPath === 'harness/support/git-local-env.ts') return false;
    if (LIBRARY_MODULES_BOOTING_BACKEND.has(repoPath) || SPAWNED_CHILD_SHIMS.has(repoPath)) return false;
    if (packageEntries.has(repoPath)) return true;
    const source = fs.readFileSync(filePath, 'utf8');
    if (BOOTS_BACKEND_STATIC.test(source) || BOOTS_BACKEND_DYNAMIC.test(source)) return true;
    return TOP_LEVEL_ENTRY_SIGNAL.test(source) && GIT_OR_SUBPROCESS_SIGNAL.test(source);
  });
}

function requiredScriptEntries(): string[] {
  return listTsFilesUnder(SCRIPTS_DIRECTORY).filter((filePath) => {
    const repoPath = toPosixRelative(filePath);
    if (repoPath.startsWith('scripts/core/')) return false;
    if (repoPath in REPO_MUTATING_SCRIPTS) return false;
    const source = fs.readFileSync(filePath, 'utf8');
    return SCRIPT_GIT_OR_TEST_SIGNAL.test(source);
  });
}

test('every runnable harness and git-using script entry imports git-local-env.ts at top of file', () => {
  const packageEntries = packageJsonTsEntries();
  const harnessEntries = requiredHarnessEntries(packageEntries);
  const scriptEntries = requiredScriptEntries();
  const requiredEntries = [...harnessEntries, ...scriptEntries];

  assert.ok(harnessEntries.length >= 20, `expected at least 20 runnable harness entries, found ${harnessEntries.length}`);
  assert.ok(scriptEntries.length >= 2, `expected at least 2 runnable script entries, found ${scriptEntries.length}`);

  const offenders = requiredEntries
    .filter((filePath) => !importsGitLocalEnvAtTop(filePath, fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => `${toPosixRelative(filePath)}: must import '${expectedHelperSpecifierFor(filePath)}' at the top of the file`);

  assert.deepEqual(offenders, []);
});

test('isolate-home.ts and isolated-glimmervoid.ts share the git-local-env.ts helper at top of file', () => {
  const sharedGuards = [
    path.join(REPO_ROOT, 'tests', 'helpers', 'isolate-home.ts'),
    path.join(REPO_ROOT, 'harness', 'site-capture', 'isolated-glimmervoid.ts'),
  ];
  const offenders = sharedGuards
    .filter((filePath) => !importsGitLocalEnvAtTop(filePath, fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => `${toPosixRelative(filePath)}: must import '${expectedHelperSpecifierFor(filePath)}' at the top of the file`);

  assert.deepEqual(offenders, []);
});

test('git-local-env gate rejects type-only imports and non-guard imports placed ahead of the helper', () => {
  const sampleEntryPath = path.join(REPO_ROOT, 'harness', 'acp-spike', 'run.ts');
  assert.equal(importsGitLocalEnvAtTop(sampleEntryPath, "import '../support/git-local-env.ts';\nimport fs from 'node:fs';\n"), true);
  assert.equal(importsGitLocalEnvAtTop(sampleEntryPath, "import '../support/disable-telemetry.ts';\nimport '../support/git-local-env.ts';\n"), true);
  assert.equal(importsGitLocalEnvAtTop(sampleEntryPath, "import './early-mutator.ts';\nimport '../support/git-local-env.ts';\n"), false);
  assert.equal(importsGitLocalEnvAtTop(sampleEntryPath, "import type { scrubGitLocalEnv } from '../support/git-local-env.ts';\n"), false);
  assert.equal(importsGitLocalEnvAtTop(sampleEntryPath, "import { type scrubGitLocalEnv } from '../support/git-local-env.ts';\n"), false);
});
