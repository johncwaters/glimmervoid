import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import {
  PUBLIC_SOURCE_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  findStorageCallsInSource,
  isStorageBoundaryExempt,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';
import type { TrackedSourceFile } from '../../scripts/state-inventory.ts';

const DIRECT_STORAGE_REPLACEMENT = 'public/local-store.ts (getJSON/setJSON/getString/setString/getSessionStorage/localStorageBackend) or public/state/persist.ts definePersisted';
const LOCAL_STORE_IMPORT_REPLACEMENT = 'public/state/persist.ts definePersisted';

function storageBoundaryViolationsIn(
  sourceFiles: readonly TrackedSourceFile[],
  recordedImportsByPath: Readonly<Record<string, number>>,
): string[] {
  const violations: string[] = [];
  const scannedNonExemptPaths = new Set<string>();

  for (const sourceFile of sourceFiles) {
    if (isStorageBoundaryExempt(sourceFile.path)) continue;
    scannedNonExemptPaths.add(sourceFile.path);
    const found = findStorageCallsInSource(sourceFile.content);

    for (const directMatch of [...found.localStorage, ...found.sessionStorage, ...found.indexedDB]) {
      violations.push(
        `${sourceFile.path}:${directMatch.line}: forbidden direct browser storage "${directMatch.form}" -> use ${DIRECT_STORAGE_REPLACEMENT}`,
      );
    }

    const recordedImportCount = recordedImportsByPath[sourceFile.path] ?? 0;
    if (found.localStoreImports.length > recordedImportCount) {
      for (const excessImport of found.localStoreImports.slice(recordedImportCount)) {
        violations.push(
          `${sourceFile.path}:${excessImport.line}: forbidden local-store.ts import "${excessImport.form}" (${found.localStoreImports.length} found, ${recordedImportCount} recorded) -> use ${LOCAL_STORE_IMPORT_REPLACEMENT}`,
        );
      }
    }
    if (found.localStoreImports.length < recordedImportCount) {
      violations.push(
        `${sourceFile.path}:1: local-store.ts import count dropped from ${recordedImportCount} to ${found.localStoreImports.length} -> lower its recorded count in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
    }
  }

  for (const recordedPath of Object.keys(recordedImportsByPath)) {
    if (scannedNonExemptPaths.has(recordedPath)) continue;
    violations.push(
      `${recordedPath}:1: recorded local-store.ts entry is gone -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }

  return violations;
}

test('no public file touches browser storage directly or imports local-store.ts past its recorded count', () => {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN);
  assert.ok(trackedPaths.length > 0, 'expected tracked public/**/*.{ts,tsx} files');
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const committedRatchets = readCommittedStateRatchets();
  const violations = storageBoundaryViolationsIn(sourceFiles, committedRatchets.localStoreImports);
  assert.deepEqual(
    violations,
    [],
    `Client storage boundary violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-storage-boundary gate fails on planted violations with file, line, form, and replacement', () => {
  const plantedFiles: TrackedSourceFile[] = [
    {
      path: 'public/planted-storage-view.ts',
      content: [
        "import { getString } from './local-store.ts';",
        'export function runPlantedStorageView() {',
        "  localStorage.getItem('k');",
        "  sessionStorage.getItem('k');",
        "  indexedDB.open('db');",
        "  return getString('k');",
        '}',
      ].join('\n'),
    },
    {
      path: 'public/planted-lowered-storage.ts',
      content: 'export function runPlantedLoweredStorage() {}\n',
    },
  ];
  const recorded: Record<string, number> = {
    'public/planted-lowered-storage.ts': 1,
    'public/planted-deleted-storage.ts': 1,
  };

  const violations = storageBoundaryViolationsIn(plantedFiles, recorded);
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-storage-view.ts:3:') && entry.includes('localStorage') && entry.includes('public/local-store.ts')),
    `expected localStorage violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-storage-view.ts:4:') && entry.includes('sessionStorage') && entry.includes('public/local-store.ts')),
    `expected sessionStorage violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-storage-view.ts:5:') && entry.includes('indexedDB') && entry.includes('public/local-store.ts')),
    `expected indexedDB violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-storage-view.ts:1:') && entry.includes('local-store.ts') && entry.includes('public/state/persist.ts definePersisted')),
    `expected local-store.ts import violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-lowered-storage.ts:1:') && entry.includes('lower its recorded count')),
    `expected lowered-count violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-deleted-storage.ts:1:') && entry.includes('remove it')),
    `expected deleted-file violation, got: ${violations.join(' | ')}`,
  );
});
