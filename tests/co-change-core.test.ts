import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANGE_MAP_LIST_CAP,
  CoChangeGap,
  HotspotFact,
} from '../shared/contracts/change-map.ts';
import { LOG_FIELD_SEPARATOR } from '../server/core/ingest-git-core.ts';
import {
  CO_CHANGE_LOG_ARGS,
  CO_CHANGE_MAX_FILES_PER_COMMIT,
  computeCoChange,
  parseCoChangeLog,
  type CommitFiles,
} from '../server/core/co-change-core.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function commit(subject: string, paths: string[]): CommitFiles {
  return { subject, paths };
}

test('git log arguments are frozen and select the documented input format', () => {
  assert.equal(Object.isFrozen(CO_CHANGE_LOG_ARGS), true);
  assert.deepEqual(CO_CHANGE_LOG_ARGS, [
    'log', '--no-merges', '--name-only', '--format=%H%x1f%s', '-n', '2000',
  ]);
});

test('parseCoChangeLog reads headers and paths across blank lines and a trailing newline', () => {
  const logText = [
    `${SHA}${LOG_FIELD_SEPARATOR}fix(scope): first`,
    '',
    'src/a.ts',
    'src/b.ts',
    '',
    `${SHA}${LOG_FIELD_SEPARATOR}second`,
    '',
    'src/c.ts',
    '',
  ].join('\n');
  assert.deepEqual(parseCoChangeLog(logText), [
    commit('fix(scope): first', ['src/a.ts', 'src/b.ts']),
    commit('second', ['src/c.ts']),
  ]);
});

test('parseCoChangeLog skips commits touching more than 40 files', () => {
  const fortyPaths = Array.from({ length: CO_CHANGE_MAX_FILES_PER_COMMIT }, (_, index) => `f${index}.ts`);
  const logText = [
    `${SHA}${LOG_FIELD_SEPARATOR}keep`, '', ...fortyPaths, '',
    `${SHA}${LOG_FIELD_SEPARATOR}skip`, '', ...fortyPaths, 'extra.ts', '',
  ].join('\n');
  assert.deepEqual(parseCoChangeLog(logText), [commit('keep', fortyPaths)]);
});

test('computeCoChange requires three supporting commits and at least half of the path commits', () => {
  const commits = [
    commit('one', ['source.ts', 'included.ts', 'excluded-low-confidence.ts']),
    commit('two', ['source.ts', 'included.ts', 'excluded-low-confidence.ts']),
    commit('three', ['source.ts', 'included.ts', 'excluded-low-confidence.ts']),
    commit('four', ['source.ts', 'included.ts', 'excluded-low-confidence.ts']),
    commit('five', ['source.ts', 'included.ts', 'excluded-low-support.ts']),
    commit('six', ['source.ts', 'included.ts', 'excluded-low-support.ts']),
    commit('seven', ['source.ts', 'included.ts']),
    commit('eight', ['source.ts', 'included.ts']),
    commit('nine', ['source.ts', 'included.ts']),
    commit('ten', ['source.ts', 'included.ts']),
  ];
  const { coChangeGaps } = computeCoChange({ repoName: 'repo', commits, changedPaths: ['source.ts'] });
  assert.deepEqual(coChangeGaps.map(({ partner, support, confidence }) => ({ partner, support, confidence })), [
    { partner: 'included.ts', support: 10, confidence: 1 },
  ]);
});

test('computeCoChange excludes partners already in the diff and counts repeated paths once', () => {
  const commits = Array.from({ length: 3 }, () => commit('work', ['a.ts', 'a.ts', 'b.ts', 'outside.ts', 'outside.ts']));
  const { coChangeGaps } = computeCoChange({ repoName: 'repo', commits, changedPaths: ['a.ts', 'b.ts'] });
  assert.deepEqual(coChangeGaps.map(({ path, partner, support }) => ({ path, partner, support })), [
    { path: 'a.ts', partner: 'outside.ts', support: 3 },
    { path: 'b.ts', partner: 'outside.ts', support: 3 },
  ]);
});

test('computeCoChange detects fix subjects without counting fixture subjects', () => {
  const commits = [
    commit('fix: issue', ['a.ts']),
    commit('fix(scope): issue', ['a.ts']),
    commit('fix!: issue', ['a.ts']),
    commit('fixture: setup', ['a.ts']),
    commit('feature: add', ['a.ts']),
  ];
  const { hotspots } = computeCoChange({ repoName: 'repo', commits, changedPaths: ['a.ts'] });
  assert.deepEqual(hotspots, [{
    factId: 'hotspot:repo:a.ts', path: 'a.ts', commitCount: 5, fixCommitCount: 3,
  }]);
});

test('computeCoChange requires five commits and emits a fifteen-commit hotspot without fixes', () => {
  const commits = [
    ...Array.from({ length: 4 }, () => commit('fix: short', ['too-short.ts'])),
    ...Array.from({ length: 14 }, () => commit('feature: work', ['no-fixes-yet.ts'])),
    ...Array.from({ length: 15 }, () => commit('feature: work', ['long-history.ts'])),
  ];
  const { hotspots } = computeCoChange({
    repoName: 'repo', commits, changedPaths: ['too-short.ts', 'no-fixes-yet.ts', 'long-history.ts'],
  });
  assert.deepEqual(hotspots.map(({ path }) => path), ['long-history.ts']);
});

test('computeCoChange orders and caps gaps and hotspots', () => {
  const changedPaths = Array.from({ length: CHANGE_MAP_LIST_CAP + 3 }, (_, index) => `changed-${String(index).padStart(2, '0')}.ts`);
  const commits = changedPaths.flatMap((path, index) =>
    Array.from({ length: 5 }, (_, commitIndex) => commit(
      commitIndex < 2 ? 'fix: work' : 'feature: work',
      [path, `partner-${String(index).padStart(2, '0')}.ts`],
    )));
  const { coChangeGaps, hotspots } = computeCoChange({ repoName: 'repo', commits, changedPaths });
  assert.equal(coChangeGaps.length, CHANGE_MAP_LIST_CAP);
  assert.equal(hotspots.length, CHANGE_MAP_LIST_CAP);
  assert.deepEqual(coChangeGaps.map(({ path }) => path), changedPaths.slice(0, CHANGE_MAP_LIST_CAP));
  assert.deepEqual(hotspots.map(({ path }) => path), changedPaths.slice(0, CHANGE_MAP_LIST_CAP));
  assert.equal(coChangeGaps.every((gap) => CoChangeGap.safeParse(gap).success), true);
  assert.equal(hotspots.every((hotspot) => HotspotFact.safeParse(hotspot).success), true);
});

test('computeCoChange ranks confidence before support and fix count before commit count', () => {
  const commits = [
    ...Array.from({ length: 3 }, () => commit('fix: work', ['certain.ts', 'certain-partner.ts'])),
    ...Array.from({ length: 4 }, () => commit('feature: work', ['frequent.ts', 'frequent-partner.ts'])),
    ...Array.from({ length: 4 }, () => commit('feature: work', ['frequent.ts'])),
    ...Array.from({ length: 12 }, () => commit('feature: work', ['long.ts'])),
    ...Array.from({ length: 2 }, () => commit('fix: work', ['long.ts'])),
  ];
  const { coChangeGaps, hotspots } = computeCoChange({
    repoName: 'repo', commits, changedPaths: ['certain.ts', 'frequent.ts', 'long.ts'],
  });
  assert.deepEqual(coChangeGaps.map(({ path }) => path), ['certain.ts', 'frequent.ts']);
  assert.deepEqual(hotspots.map(({ path }) => path), ['long.ts']);
});

test('computeCoChange uses support and commit count to break ranking ties', () => {
  const commits = [
    ...Array.from({ length: 4 }, () => commit('feature: work', ['a.ts', 'a-partner.ts'])),
    ...Array.from({ length: 4 }, () => commit('feature: work', ['a.ts'])),
    ...Array.from({ length: 3 }, () => commit('feature: work', ['b.ts', 'b-partner.ts'])),
    ...Array.from({ length: 3 }, () => commit('feature: work', ['b.ts'])),
    ...Array.from({ length: 7 }, () => commit('feature: work', ['long.ts'])),
    ...Array.from({ length: 2 }, () => commit('fix: work', ['long.ts'])),
    ...Array.from({ length: 3 }, () => commit('feature: work', ['short.ts'])),
    ...Array.from({ length: 2 }, () => commit('fix: work', ['short.ts'])),
  ];
  const { coChangeGaps, hotspots } = computeCoChange({
    repoName: 'repo', commits, changedPaths: ['b.ts', 'a.ts', 'short.ts', 'long.ts'],
  });
  assert.deepEqual(coChangeGaps.map(({ path }) => path), ['a.ts', 'b.ts']);
  assert.deepEqual(hotspots.map(({ path }) => path), ['long.ts', 'short.ts']);
});
