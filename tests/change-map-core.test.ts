import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangedFile } from '../shared/contracts/change-map.ts';
import {
  isAgentsDocPath,
  isSourcePath,
  mergeChangedFiles,
  parseNameStatus,
  parseNulSeparatedPaths,
  presentPaths,
  readImportsMap,
} from '../server/core/change-map-core.ts';

const nul = String.fromCharCode(0);

function nameStatusRecords(...fields: string[]): string {
  return fields.map((field) => `${field}${nul}`).join('');
}

test('parseNameStatus maps git status letters and keeps the rename source', () => {
  const files = parseNameStatus({
    repoName: 'repo',
    nameStatusText: nameStatusRecords('M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts', '?', 'scratch.ts', 'X', 'ignored.ts'),
    isCommitted: true,
  });
  assert.deepEqual(files.map((file) => [file.path, file.status]), [
    ['a.ts', 'modified'], ['b.ts', 'added'], ['c.ts', 'deleted'], ['new.ts', 'renamed'], ['scratch.ts', 'untracked'],
  ]);
  assert.equal(files[3].previousPath, 'old.ts');
  assert.equal(files[0].factId, 'file:repo:a.ts');
  for (const file of files) assert.equal(ChangedFile.safeParse(file).success, true);
});

test('parseNameStatus keeps non-ASCII and tab-bearing paths verbatim from NUL records', () => {
  const accentedPath = `docs/caf${String.fromCharCode(0xe9)}.ts`;
  const files = parseNameStatus({
    repoName: 'repo',
    nameStatusText: nameStatusRecords('M', accentedPath, 'R100', 'old\tname.ts', 'new\tname.ts', 'C075', 'source.ts', 'copy.ts'),
    isCommitted: false,
  });
  assert.deepEqual(files.map((file) => [file.path, file.status, file.previousPath]), [
    [accentedPath, 'modified', undefined], ['new\tname.ts', 'renamed', 'old\tname.ts'], ['copy.ts', 'added', undefined],
  ]);
});

test('a committed file edited again stays one entry marked uncommitted with its committed status', () => {
  const committed = parseNameStatus({ repoName: 'repo', nameStatusText: nameStatusRecords('A', 'new.ts', 'M', 'kept.ts'), isCommitted: true });
  const uncommitted = parseNameStatus({ repoName: 'repo', nameStatusText: nameStatusRecords('M', 'new.ts', 'D', 'kept.ts', '?', 'fresh.ts'), isCommitted: false });
  const merged = mergeChangedFiles(committed, uncommitted);
  assert.deepEqual(merged.map((file) => [file.path, file.status, file.isCommitted]), [
    ['fresh.ts', 'untracked', false],
    ['kept.ts', 'deleted', false],
    ['new.ts', 'added', false],
  ]);
  assert.deepEqual(presentPaths(merged), ['fresh.ts', 'new.ts']);
});

test('source and AGENTS.md path predicates', () => {
  assert.equal(isSourcePath('server/a.ts'), true);
  assert.equal(isSourcePath('posthog/models/user.py'), true);
  assert.equal(isSourcePath('public/style.css'), false);
  assert.equal(isAgentsDocPath('AGENTS.md'), true);
  assert.equal(isAgentsDocPath('session/AGENTS.md'), true);
  assert.equal(isAgentsDocPath('docs/NOT-AGENTS.md'), false);
});

test('parseNulSeparatedPaths drops the trailing empty entry', () => {
  assert.deepEqual(parseNulSeparatedPaths(`a.ts${nul}b c.ts${nul}`), ['a.ts', 'b c.ts']);
});

test('readImportsMap keeps string targets and fails closed on bad json', () => {
  assert.deepEqual(readImportsMap('{"imports":{"#shared/*":"./shared/*","#cond":{"node":"./x.js"}}}'), { '#shared/*': './shared/*' });
  assert.deepEqual(readImportsMap('{not json'), {});
  assert.deepEqual(readImportsMap(null), {});
});
