import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const importsLaneLog = /from '[./]*(?:lanes\/)?lane-log\.ts'/;
const consoleChannel = /\bconsole\s*(?:\?\.|\.|\[)/;
const calledLoggerChannel = /\blogger\s*(?:\??\.\s*(?:log|warn|error|info|debug)\s*\(|\[)/;
const handRolledLoggerGuard = /typeof\s+logger\s*\??\.\s*(?:log|warn)/;
const bracketPrefix = /['"]\s*(\[[a-z][a-z0-9:-]*\])/g;
const laneDirectoryModule = /^server\/(?:usage|ingest|visions)\/[^/]+\.ts$/;
const cliModule = /-cli\.ts$/;

test('every lane module logs only through lane-log with one prefix', () => {
  const importingModules = trackedFiles(/^server\/.+\.ts$/).filter((repoPath) => importsLaneLog.test(readTracked(repoPath)));
  assert.ok(importingModules.length > 0, 'no server module imports lane-log.ts: the import pattern no longer matches');
  const directoryModules = trackedFiles(laneDirectoryModule).filter((repoPath) => !cliModule.test(repoPath));
  const laneModules = [...new Set([...importingModules, ...directoryModules])].sort();
  const offenders: string[] = [];
  for (const repoPath of laneModules) {
    const source = readTracked(repoPath);
    if (!importsLaneLog.test(source)) offenders.push(`${repoPath}: logs without importing lane-log.ts`);
    if (consoleChannel.test(source)) offenders.push(`${repoPath}: direct console channel`);
    if (calledLoggerChannel.test(source)) offenders.push(`${repoPath}: called logger channel`);
    if (handRolledLoggerGuard.test(source)) offenders.push(`${repoPath}: hand-rolled logger guard`);
    const prefixes = new Set([...source.matchAll(bracketPrefix)].map((match) => match[1]));
    if (prefixes.size > 1) offenders.push(`${repoPath}: more than one log prefix (${[...prefixes].join(', ')})`);
  }
  assert.deepEqual(offenders, [], 'a lane module logs through createLaneLog alone, so debug gating and prefixes stay in one place');
});
