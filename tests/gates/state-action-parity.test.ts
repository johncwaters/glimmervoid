import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';
import { trackedFiles } from '../helpers/tracked-files.ts';
import {
  STATE_ACTIONS_DIR_PATTERN,
  STATE_ACTION_MODULE_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';

function actionParityViolationsIn(
  mutatingClientTypes: readonly string[],
  actionModulePaths: readonly string[],
  recordedLegacyMutatingActions: readonly string[],
): string[] {
  const violations: string[] = [];
  const mutatingSet = new Set(mutatingClientTypes);
  const legacySet = new Set(recordedLegacyMutatingActions);
  const definedActionSet = new Set<string>();

  for (const repoPath of actionModulePaths) {
    const match = STATE_ACTION_MODULE_PATTERN.exec(repoPath);
    if (!match?.[1]) {
      violations.push(
        `${repoPath}:1: unexpected file under public/state/actions/ -> name action modules public/state/actions/<client-type>.ts matching a mutating type in shared/contracts/control/message-classes.ts CLIENT_MESSAGE_CLASS`,
      );
      continue;
    }
    const actionType = match[1];
    definedActionSet.add(actionType);
    if (mutatingSet.has(actionType)) continue;
    violations.push(
      `${repoPath}:1: action module "${actionType}" is not classified as "mutating" in CLIENT_MESSAGE_CLASS -> remove the file or classify it in shared/contracts/control/message-classes.ts CLIENT_MESSAGE_CLASS`,
    );
  }

  for (const mutatingType of [...mutatingSet].sort()) {
    if (definedActionSet.has(mutatingType) || legacySet.has(mutatingType)) continue;
    violations.push(
      `shared/contracts/control/message-classes.ts:1: mutating client type "${mutatingType}" has no public/state/actions/${mutatingType}.ts -> add public/state/actions/${mutatingType}.ts using public/state/define-action.ts defineAction`,
    );
  }

  for (const recordedType of recordedLegacyMutatingActions) {
    if (!mutatingSet.has(recordedType)) {
      violations.push(
        `${STATE_RATCHETS_RELATIVE_PATH}:1: recorded legacy mutating action "${recordedType}" is no longer classified as "mutating" -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
      continue;
    }
    if (definedActionSet.has(recordedType)) {
      violations.push(
        `public/state/actions/${recordedType}.ts:1: mutating action "${recordedType}" is now defined -> remove it from legacyMutatingActions in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
    }
  }

  return violations;
}

test('mutating CLIENT_MESSAGE_CLASS types match public/state/actions/<type>.ts plus recorded legacyMutatingActions', () => {
  const mutatingClientTypes = Object.entries(CLIENT_MESSAGE_CLASS)
    .filter(([, messageClass]) => messageClass === 'mutating')
    .map(([typeName]) => typeName)
    .sort();
  const actionModulePaths = trackedFiles(STATE_ACTIONS_DIR_PATTERN).sort();
  const committedRatchets = readCommittedStateRatchets();
  const violations = actionParityViolationsIn(
    mutatingClientTypes,
    actionModulePaths,
    committedRatchets.legacyMutatingActions,
  );
  assert.deepEqual(
    violations,
    [],
    `State action parity violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-action-parity gate fails on planted missing, non-mutating, and stale legacy action violations', () => {
  const violations = actionParityViolationsIn(
    ['rename-session', 'save-hook'],
    ['public/state/actions/save-hook.ts', 'public/state/actions/ping.ts', 'public/state/actions/nested/my_action.ts'],
    ['save-hook', 'removed-mutation'],
  );

  assert.ok(
    violations.some((entry) => entry.includes('public/state/actions/nested/my_action.ts:1:') && entry.includes('unexpected file under public/state/actions/')),
    `expected invalid action filename violation, got: ${violations.join(' | ')}`,
  );

  assert.ok(
    violations.some((entry) => entry.includes('mutating client type "rename-session" has no public/state/actions/rename-session.ts') && entry.includes('defineAction')),
    `expected missing mutating action violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/actions/ping.ts:1:') && entry.includes('not classified as "mutating"')),
    `expected non-mutating action file violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/state/actions/save-hook.ts:1:') && entry.includes('remove it from legacyMutatingActions')),
    `expected stale migrated action ratchet violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('recorded legacy mutating action "removed-mutation" is no longer classified as "mutating"')),
    `expected removed action ratchet violation, got: ${violations.join(' | ')}`,
  );
});
