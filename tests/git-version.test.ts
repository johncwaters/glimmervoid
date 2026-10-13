import test from 'node:test';
import assert from 'node:assert/strict';

import { gitVersionReport } from '../server/core/git-version-core.ts';
import { probeGitVersion, warnWhenGitIsTooOld } from '../server/git-version.ts';

test('git older than 2.48 is reported as too old to isolate new work, across the version strings git prints', () => {
  const isTooOldByOutput: [string, string, boolean][] = [
    ['git version 2.39.5\n', '2.39.5', true],
    ['git version 2.47.3', '2.47.3', true],
    ['git version 1.9', '1.9', true],
    ['git version 2.48.0', '2.48.0', false],
    ['git version 2.50.1 (Apple Git-155)', '2.50.1', false],
    ['git version 2.51.0.windows.1', '2.51.0', false],
    ['git version 3.0.0', '3.0.0', false],
  ];
  for (const [versionOutput, version, isTooOld] of isTooOldByOutput) {
    assert.deepEqual(gitVersionReport(versionOutput), { version, isTooOldToIsolateNewWork: isTooOld }, versionOutput);
  }
});

test('only a git too old to isolate new work warns at boot, and an unreadable version stays quiet', () => {
  const warnings: string[] = [];
  const log = { warn: (message: string) => { warnings.push(message); } };
  warnWhenGitIsTooOld({ probe: () => gitVersionReport('git version 2.48.1'), log });
  warnWhenGitIsTooOld({ probe: () => probeGitVersion({ readVersionOutput: () => { throw new Error('git is not on PATH'); } }), log });
  assert.deepEqual(warnings, []);
  warnWhenGitIsTooOld({ probe: () => gitVersionReport('git version 2.39.5'), log });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /git 2\.39\.5 is older than 2\.48/);
});
