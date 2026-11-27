import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import {
  PUBLIC_SOURCE_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  findSubscribeExportsInSource,
  isStoreModuleExempt,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';
import type { TrackedSourceFile } from '../../scripts/state-inventory.ts';

const STORE_MODULE_REPLACEMENT = 'public/state/define-collection.ts defineCollection';

function storeModuleViolationsIn(
  sourceFiles: readonly TrackedSourceFile[],
  recordedModules: readonly string[],
): string[] {
  const violations: string[] = [];
  const recordedSet = new Set(recordedModules);
  const liveSubscribeModulePaths = new Set<string>();

  for (const sourceFile of sourceFiles) {
    if (isStoreModuleExempt(sourceFile.path)) continue;
    const subscribeExports = findSubscribeExportsInSource(sourceFile.content);
    if (subscribeExports.length === 0) continue;
    liveSubscribeModulePaths.add(sourceFile.path);
    if (recordedSet.has(sourceFile.path)) continue;
    for (const exportMatch of subscribeExports) {
      violations.push(
        `${sourceFile.path}:${exportMatch.line}: forbidden per-feature store export "${exportMatch.form}" -> use ${STORE_MODULE_REPLACEMENT}`,
      );
    }
  }

  for (const recordedPath of recordedModules) {
    if (liveSubscribeModulePaths.has(recordedPath)) continue;
    violations.push(
      `${recordedPath}:1: recorded legacy store module no longer exports subscribe* -> lower the recorded list in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }

  return violations;
}

test('no new public file outside public/state/ exports subscribe[A-Z]', () => {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN);
  assert.ok(trackedPaths.length > 0, 'expected tracked public/**/*.{ts,tsx} files');
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const committedRatchets = readCommittedStateRatchets();
  const violations = storeModuleViolationsIn(sourceFiles, committedRatchets.subscribeModules);
  assert.deepEqual(
    violations,
    [],
    `Legacy store module ratchet violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-store-modules gate fails on planted violations with file, line, form, and replacement', () => {
  const plantedFiles: TrackedSourceFile[] = [
    {
      path: 'public/planted-widgets-store.ts',
      content: [
        'const listeners = new Set<() => void>();',
        'export function subscribeWidgets(listener: () => void) {',
        '  listeners.add(listener);',
        '}',
        'export const subscribeGadgets = () => {};',
        'function subscribeQueued() {}',
        'export { subscribeQueued };',
      ].join('\n'),
    },
    {
      path: 'public/state/collections/widgets.ts',
      content: 'export function subscribeAllowedInState() {}\n',
    },
  ];
  const recorded = ['public/planted-retired-store.ts'];

  const violations = storeModuleViolationsIn(plantedFiles, recorded);
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-widgets-store.ts:2:') && entry.includes('export function subscribeWidgets') && entry.includes('public/state/define-collection.ts defineCollection')),
    `expected subscribeWidgets violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-widgets-store.ts:5:') && entry.includes('export const subscribeGadgets') && entry.includes('public/state/define-collection.ts defineCollection')),
    `expected subscribeGadgets violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-widgets-store.ts:7:') && entry.includes('subscribeQueued') && entry.includes('public/state/define-collection.ts defineCollection')),
    `expected subscribeQueued export-list violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-retired-store.ts:1:') && entry.includes('lower the recorded list')),
    `expected retired-store violation, got: ${violations.join(' | ')}`,
  );
  assert.equal(
    violations.filter((entry) => entry.includes('public/state/collections/widgets.ts')).length,
    0,
  );
});
