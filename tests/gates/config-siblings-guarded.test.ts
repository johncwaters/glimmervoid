import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { standardWriteBlockCandidates } from '../../server/guardrails/core/guardrails-policy-core.ts';
import { sessionRole } from '../../server/guardrails/core/guardrails-roles-core.ts';
import { entryPaths, glimmervoidHome, hostPaths, planFor } from '../helpers/guardrails-host.ts';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const configSiblingCall = /configSiblingPath\([^,()]*,\s*'([^']+)'\)/g;

test('every config sibling file the server names is write-blocked for a session beside the config file, wherever the config lives', () => {
  const siblingNames = trackedFiles(/^server\/.+\.ts$/).flatMap((repoPath) => [...readTracked(repoPath).matchAll(configSiblingCall)].map((match) => match[1]));
  assert.ok(siblingNames.includes('pairings.json'), 'no configSiblingPath call names pairings.json: the call pattern no longer matches');
  const role = sessionRole({ writableRoots: [], readDenied: [], readablePaths: [], blockedPaths: [] });
  for (const configFolder of [glimmervoidHome, path.resolve('/etc/glimmervoid')]) {
    const glimmervoidConfigFile = path.join(configFolder, 'settings.json');
    const blocked = standardWriteBlockCandidates(role, { ...hostPaths, glimmervoidConfigFile, glimmervoidHomeEntryNames: [] });
    for (const blockedPath of [glimmervoidConfigFile, ...siblingNames.map((name) => path.join(configFolder, name))]) assert.equal(blocked.includes(blockedPath), true, blockedPath);
    const readDenied = entryPaths(planFor(role, { ...hostPaths, glimmervoidConfigFile, existingPaths: new Set() }).policy.filesystem.denyRead);
    assert.equal(readDenied.includes(path.join(configFolder, 'agent-logins')), true, configFolder);
  }
});
