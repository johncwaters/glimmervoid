import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedFiles } from '../helpers/tracked-files.ts';
import {
  STATE_ACTIONS_DIR_PATTERN,
  STATE_ACTION_MODULE_PATTERN,
  STATE_COLLECTIONS_DIR_PATTERN,
  STATE_COLLECTION_MODULE_PATTERN,
} from '../../scripts/state-inventory.ts';
import {
  ACTION_CONTINUITY_CASES,
  COLLECTION_CONTINUITY_CASES,
} from '../../harness/browser/continuity-cases.ts';

interface CaseDeclaration {
  name: string;
  checks: readonly string[];
  stub?: boolean;
}

const REQUIRED_ACTION_CHECKS = ['C1', 'C2', 'C5'] as const;
const REQUIRED_COLLECTION_CHECKS = ['C3', 'C4'] as const;

function continuityParityViolationsIn(
  actionModulePaths: readonly string[],
  collectionModulePaths: readonly string[],
  actionCases: readonly CaseDeclaration[],
  collectionCases: readonly CaseDeclaration[],
): string[] {
  const violations: string[] = [];
  const actionCasesByName = new Map<string, CaseDeclaration>();
  for (const entry of actionCases) {
    if (actionCasesByName.has(entry.name)) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: duplicate action continuity case "${entry.name}" -> keep one entry per action in ACTION_CONTINUITY_CASES`,
      );
      continue;
    }
    actionCasesByName.set(entry.name, entry);
  }

  const collectionCasesByName = new Map<string, CaseDeclaration>();
  for (const entry of collectionCases) {
    if (collectionCasesByName.has(entry.name)) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: duplicate collection continuity case "${entry.name}" -> keep one entry per collection in COLLECTION_CONTINUITY_CASES`,
      );
      continue;
    }
    collectionCasesByName.set(entry.name, entry);
  }

  const knownActionNames = new Set<string>();
  for (const repoPath of [...actionModulePaths].sort()) {
    const match = STATE_ACTION_MODULE_PATTERN.exec(repoPath);
    if (!match?.[1]) continue;
    const actionName = match[1];
    knownActionNames.add(actionName);
    const declared = actionCasesByName.get(actionName);
    if (!declared) {
      violations.push(
        `${repoPath}:1: action "${actionName}" has no continuity case in harness/browser/continuity-cases.ts -> add an entry to ACTION_CONTINUITY_CASES declaring C1, C2 and C5`,
      );
      continue;
    }
    if (declared.stub === true) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: action continuity case "${actionName}" is still a stub -> implement prepare() and remove stub: true in ACTION_CONTINUITY_CASES`,
      );
    }
    const missingChecks = REQUIRED_ACTION_CHECKS.filter((check) => !declared.checks.includes(check));
    if (missingChecks.length > 0) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: action continuity case "${actionName}" is missing ${missingChecks.join(', ')} -> declare checks: ['C1', 'C2', 'C5'] in ACTION_CONTINUITY_CASES`,
      );
    }
  }

  for (const actionName of [...actionCasesByName.keys()].sort()) {
    if (knownActionNames.has(actionName)) continue;
    violations.push(
      `harness/browser/continuity-cases.ts:1: orphaned action continuity case "${actionName}" has no module at public/state/actions/${actionName}.ts -> remove the retired case from ACTION_CONTINUITY_CASES`,
    );
  }

  const knownCollectionNames = new Set<string>();
  for (const repoPath of [...collectionModulePaths].sort()) {
    const match = STATE_COLLECTION_MODULE_PATTERN.exec(repoPath);
    if (!match?.[1]) continue;
    const collectionName = match[1];
    knownCollectionNames.add(collectionName);
    const declared = collectionCasesByName.get(collectionName);
    if (!declared) {
      violations.push(
        `${repoPath}:1: collection "${collectionName}" has no continuity case in harness/browser/continuity-cases.ts -> add an entry to COLLECTION_CONTINUITY_CASES declaring C3 and C4`,
      );
      continue;
    }
    if (declared.stub === true) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: collection continuity case "${collectionName}" is still a stub -> implement prepare() and remove stub: true in COLLECTION_CONTINUITY_CASES`,
      );
    }
    const missingChecks = REQUIRED_COLLECTION_CHECKS.filter((check) => !declared.checks.includes(check));
    if (missingChecks.length > 0) {
      violations.push(
        `harness/browser/continuity-cases.ts:1: collection continuity case "${collectionName}" is missing ${missingChecks.join(', ')} -> declare checks: ['C3', 'C4'] in COLLECTION_CONTINUITY_CASES`,
      );
    }
  }

  for (const collectionName of [...collectionCasesByName.keys()].sort()) {
    if (knownCollectionNames.has(collectionName)) continue;
    violations.push(
      `harness/browser/continuity-cases.ts:1: orphaned collection continuity case "${collectionName}" has no module at public/state/collections/${collectionName}.ts -> remove the retired case from COLLECTION_CONTINUITY_CASES`,
    );
  }

  return violations;
}

test('every public/state action and collection has a matching continuity case with required C1 to C5 checks', () => {
  const actionModulePaths = trackedFiles(STATE_ACTIONS_DIR_PATTERN).sort();
  const collectionModulePaths = trackedFiles(STATE_COLLECTIONS_DIR_PATTERN).sort();
  const violations = continuityParityViolationsIn(
    actionModulePaths,
    collectionModulePaths,
    ACTION_CONTINUITY_CASES,
    COLLECTION_CONTINUITY_CASES,
  );
  assert.deepEqual(
    violations,
    [],
    `State continuity parity violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-continuity-parity gate fails on planted missing, stub, orphaned, and incomplete declarations', () => {
  const violations = continuityParityViolationsIn(
    ['public/state/actions/rename-session.ts', 'public/state/actions/save-hook.ts', 'public/state/actions/restart.ts'],
    ['public/state/collections/sessions.ts', 'public/state/collections/hooks.ts', 'public/state/collections/packs.ts'],
    [
      { name: 'rename-session', checks: ['C1', 'C2'] },
      { name: 'restart', checks: ['C1', 'C2', 'C5'], stub: true },
      { name: 'retired-action', checks: ['C1', 'C2', 'C5'] },
    ],
    [
      { name: 'sessions', checks: ['C3'] },
      { name: 'packs', checks: ['C3', 'C4'], stub: true },
      { name: 'retired-collection', checks: ['C3', 'C4'] },
    ],
  );

  assert.ok(
    violations.some((entry) => entry.includes('public/state/actions/save-hook.ts:1:') && entry.includes('ACTION_CONTINUITY_CASES')),
    `expected missing action case violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('action continuity case "rename-session" is missing C5')),
    `expected missing C5 violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('action continuity case "restart" is still a stub')),
    `expected stub action violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('orphaned action continuity case "retired-action"')),
    `expected orphaned action violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/collections/hooks.ts:1:') && entry.includes('COLLECTION_CONTINUITY_CASES')),
    `expected missing collection case violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('collection continuity case "sessions" is missing C4')),
    `expected missing C4 violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('collection continuity case "packs" is still a stub')),
    `expected stub collection violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('orphaned collection continuity case "retired-collection"')),
    `expected orphaned collection violation, got: ${violations.join(' | ')}`,
  );
});
