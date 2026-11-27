import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION_OF } from '../../shared/contracts/control/message-classes.ts';
import { trackedFiles } from '../helpers/tracked-files.ts';
import {
  STATE_COLLECTIONS_DIR_PATTERN,
  STATE_COLLECTION_MODULE_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';

function collectionParityViolationsIn(
  collectionNamesInWire: readonly string[],
  collectionModulePaths: readonly string[],
  recordedLegacyCollections: readonly string[],
): string[] {
  const violations: string[] = [];
  const wireCollectionSet = new Set(collectionNamesInWire);
  const legacySet = new Set(recordedLegacyCollections);
  const definedCollectionSet = new Set<string>();

  for (const repoPath of collectionModulePaths) {
    const match = STATE_COLLECTION_MODULE_PATTERN.exec(repoPath);
    if (!match?.[1]) {
      violations.push(
        `${repoPath}:1: unexpected file under public/state/collections/ -> name collection modules public/state/collections/<collection-name>.ts matching shared/contracts/control/message-classes.ts COLLECTION_OF`,
      );
      continue;
    }
    const collectionName = match[1];
    definedCollectionSet.add(collectionName);
    if (wireCollectionSet.has(collectionName)) continue;
    violations.push(
      `${repoPath}:1: collection module "${collectionName}" is not in COLLECTION_OF -> remove the file or classify a server collection message in shared/contracts/control/message-classes.ts COLLECTION_OF`,
    );
  }

  for (const collectionName of [...wireCollectionSet].sort()) {
    if (definedCollectionSet.has(collectionName) || legacySet.has(collectionName)) continue;
    violations.push(
      `shared/contracts/control/message-classes.ts:1: collection "${collectionName}" in COLLECTION_OF has no public/state/collections/${collectionName}.ts -> add public/state/collections/${collectionName}.ts using public/state/define-collection.ts defineCollection`,
    );
  }

  for (const recordedName of recordedLegacyCollections) {
    if (!wireCollectionSet.has(recordedName)) {
      violations.push(
        `${STATE_RATCHETS_RELATIVE_PATH}:1: recorded legacy collection "${recordedName}" is no longer in COLLECTION_OF -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
      continue;
    }
    if (definedCollectionSet.has(recordedName)) {
      violations.push(
        `public/state/collections/${recordedName}.ts:1: collection "${recordedName}" is now defined -> remove it from legacyCollections in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
    }
  }

  return violations;
}

test('COLLECTION_OF collections match public/state/collections/<name>.ts plus recorded legacyCollections', () => {
  const collectionNamesInWire = [...new Set(Object.values(COLLECTION_OF))].sort();
  const collectionModulePaths = trackedFiles(STATE_COLLECTIONS_DIR_PATTERN).sort();
  const committedRatchets = readCommittedStateRatchets();
  const violations = collectionParityViolationsIn(
    collectionNamesInWire,
    collectionModulePaths,
    committedRatchets.legacyCollections,
  );
  assert.deepEqual(
    violations,
    [],
    `State collection parity violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-collection-parity gate fails on planted missing, orphan, and stale legacy collection violations', () => {
  const violations = collectionParityViolationsIn(
    ['sessions', 'settings', 'hooks'],
    ['public/state/collections/settings.ts', 'public/state/collections/phantom.ts', 'public/state/collections/sub/bad_name.tsx'],
    ['settings', 'retired'],
  );

  assert.ok(
    violations.some((entry) => entry.includes('public/state/collections/sub/bad_name.tsx:1:') && entry.includes('unexpected file under public/state/collections/')),
    `expected invalid filename violation, got: ${violations.join(' | ')}`,
  );

  assert.ok(
    violations.some((entry) => entry.includes('collection "hooks" in COLLECTION_OF has no public/state/collections/hooks.ts') && entry.includes('defineCollection')),
    `expected missing collection violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/collections/phantom.ts:1:') && entry.includes('not in COLLECTION_OF')),
    `expected orphan collection file violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/collections/settings.ts:1:') && entry.includes('remove it from legacyCollections')),
    `expected stale migrated collection ratchet violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('recorded legacy collection "retired" is no longer in COLLECTION_OF')),
    `expected removed collection ratchet violation, got: ${violations.join(' | ')}`,
  );
});
