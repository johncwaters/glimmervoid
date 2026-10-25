import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const MAX_ROOT_BYTES = 10000;
const MAX_NESTED_BYTES = 18000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.glimmervoid-worktrees']);
const CITATION_EXTENSIONS = /\.(js|mjs|cjs|ts|mts|cts|json|md|css|html|toml|yml|yaml|sh|ps1)$/;

function agentsMdFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) agentsMdFiles(path.join(dir, entry.name), found);
      continue;
    }
    if (entry.name === 'AGENTS.md') found.push(path.join(dir, entry.name));
  }
  return found;
}

function citedPaths(markdown: string): Set<string> {
  const cited = new Set<string>();
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim();
    if (!raw.includes('/') || /[<>*: #]/.test(raw)) continue;
    if (/^([~/]|https?:|\.[A-Za-z])/.test(raw)) continue;
    if (CITATION_EXTENSIONS.test(raw)) { cited.add(raw); continue; }
    const withoutSymbol = raw.replace(/\.[A-Za-z_$][\w$]*$/, '');
    if (CITATION_EXTENSIONS.test(withoutSymbol)) cited.add(withoutSymbol);
  }
  return cited;
}

function resolvesFromAnyAncestor(citation: string, startDir: string): boolean {
  if (fs.existsSync(path.join(REPO_ROOT, citation))) return true;
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.resolve(dir, citation))) return true;
    if (dir === REPO_ROOT) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function sectionBody(markdown: string, heading: string): string {
  const headingLine = new RegExp(`^${heading}$`, 'm').exec(markdown);
  if (!headingLine) return '';
  const rest = markdown.slice(headingLine.index + heading.length);
  const nextSection = rest.search(/^## /m);
  if (nextSection === -1) return rest;
  return rest.slice(0, nextSection);
}

function invariantHeadings(markdown: string): string[] {
  return [...sectionBody(markdown, '## Invariants').matchAll(/^### (.+)$/gm)].map((match) => match[1].replace(/\s*\([^)]*\)$/, '').trim());
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('root AGENTS.md stays under the always-loaded byte budget', () => {
  const sizeBytes = fs.statSync(path.join(REPO_ROOT, 'AGENTS.md')).size;
  assert.ok(
    sizeBytes <= MAX_ROOT_BYTES,
    `AGENTS.md is ${sizeBytes} bytes, over the ${MAX_ROOT_BYTES} byte budget. It is loaded into every ` +
      'session: a subsystem rule belongs in that subsystem\'s own AGENTS.md, and what-prose belongs nowhere.'
  );
});

test('every nested AGENTS.md stays under its own budget, so growth cannot just move downhill', () => {
  const oversized = agentsMdFiles(REPO_ROOT)
    .filter((file) => file !== path.join(REPO_ROOT, 'AGENTS.md'))
    .map((file) => ({ file: path.relative(REPO_ROOT, file), sizeBytes: fs.statSync(file).size }))
    .filter((entry) => entry.sizeBytes > MAX_NESTED_BYTES);
  assert.deepEqual(
    oversized,
    [],
    `over the ${MAX_NESTED_BYTES} byte budget. Retire a rule whose code is gone or whose test now pins it, ` +
      'rather than trimming words off live ones.'
  );
});

test('every path an AGENTS.md cites still exists', () => {
  const broken: string[] = [];
  for (const file of agentsMdFiles(REPO_ROOT)) {
    const from = path.dirname(file);
    for (const citation of citedPaths(fs.readFileSync(file, 'utf8'))) {
      if (resolvesFromAnyAncestor(citation, from)) continue;
      broken.push(`${path.relative(REPO_ROOT, file)} cites ${citation}`);
    }
  }
  assert.deepEqual(broken, [], 'a citation resolving to nothing means the rule outlived its code: retire the rule or fix the path');
});

test('no AGENTS.md cites a test file', () => {
  const namedTestFile = /`[^`\s]*[A-Za-z0-9]\.test\.[cm]?[jt]s`/g;
  const citations = agentsMdFiles(REPO_ROOT).flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(namedTestFile)].map((match) => `${path.relative(REPO_ROOT, file)} cites ${match[0]}`));
  assert.deepEqual(citations, [], 'a test file citation drifts the day the test moves or goes: name the rule, never the test that pins it');
});

test('the root Dependencies section names every runtime dependency', () => {
  const runtimeDependencies = Object.keys(JSON.parse(readRepoFile('package.json')).dependencies);
  const dependenciesSection = sectionBody(readRepoFile('AGENTS.md'), '## Dependencies');
  const unnamed = runtimeDependencies.filter((name) => !dependenciesSection.includes(`\`${name}\``));
  assert.deepEqual(unnamed, [], 'each runtime dependency gets a line in the root Dependencies section saying why it is there');
});

test('the root invariants table and the invariant headings it points at match', () => {
  const namesByFile = new Map<string, string[]>();
  const drift: string[] = [];
  const tableNames = new Set<string>();
  for (const row of sectionBody(readRepoFile('AGENTS.md'), '## Invariants').matchAll(/^\| (.+?) \| `([^`]+)` \|$/gm)) {
    const [, rowNames, file] = row;
    const names = rowNames.split(', ').map((name) => name.trim());
    for (const name of names.filter((rowName) => tableNames.has(rowName))) drift.push(`root table lists ${name} twice`);
    for (const name of names) tableNames.add(name);
    namesByFile.set(file, [...(namesByFile.get(file) ?? []), ...names]);
  }
  for (const [file, names] of namesByFile) {
    const headings = invariantHeadings(readRepoFile(file));
    for (const name of names.filter((tableName) => !headings.includes(tableName))) drift.push(`${file} has no invariant heading ${name}`);
    for (const heading of headings.filter((fileHeading) => !names.includes(fileHeading))) drift.push(`${file} heading ${heading} is missing from the root table`);
  }
  for (const file of agentsMdFiles(REPO_ROOT).map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/'))) {
    if (file === 'AGENTS.md' || namesByFile.has(file)) continue;
    if (invariantHeadings(readRepoFile(file)).length === 0) continue;
    drift.push(`${file} states invariants but has no row in the root table`);
  }
  assert.deepEqual(drift, [], 'the root invariants table is the index to every subsystem rule: keep its rows and the headings they name in step');
});
