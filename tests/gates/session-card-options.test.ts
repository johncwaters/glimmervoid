import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const cardCreationCall = /\bcreateSessionCard\(/;
const cardCreationDefinition = /\bfunction\s+createSessionCard\(/;
const builderAsFourthArgument = /\bcreateSessionCard\([^;]*,\s*buildSessionCardOptions\(/;
const aliasedCardImport = /\bcreateSessionCard\s+as\b/;

test('every session card is created with options from buildSessionCardOptions', () => {
  const creationLines = trackedFiles(/^public\/.+\.ts$/).flatMap((repoPath) =>
    readTracked(repoPath)
      .split('\n')
      .map((line, index) => ({ line, location: `${repoPath}:${index + 1}` }))
      .filter(({ line }) => cardCreationCall.test(line) && !cardCreationDefinition.test(line)));
  assert.ok(creationLines.length > 0, 'no createSessionCard call found in public/: the call pattern no longer matches');
  const offenders = creationLines
    .filter(({ line }) => !builderAsFourthArgument.test(line) || line.includes('...buildSessionCardOptions'))
    .map(({ location }) => location);
  assert.deepEqual(offenders, [], 'a card built from hand-picked fields drops the identity flags the builder maps from both wire shapes');
});

test('createSessionCard is never imported under another name', () => {
  const aliasers = trackedFiles(/^public\/.+\.ts$/).filter((repoPath) => aliasedCardImport.test(readTracked(repoPath)));
  assert.deepEqual(aliasers, [], 'an aliased createSessionCard escapes the options gate');
});
