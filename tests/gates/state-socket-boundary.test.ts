import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import {
  PUBLIC_SOURCE_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  findSocketCallsInSource,
  isSocketBoundaryExempt,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';
import type { SocketCallRatchetEntry, TrackedSourceFile } from '../../scripts/state-inventory.ts';

type SocketSymbol = keyof SocketCallRatchetEntry;

const SOCKET_SYMBOLS: readonly { symbol: SocketSymbol; replacement: string }[] = [
  { symbol: 'sendControlMsg', replacement: 'public/state/define-action.ts defineAction' },
  { symbol: 'sendControlRequest', replacement: 'public/state/define-action.ts defineAction' },
  { symbol: 'onControlMessage', replacement: 'public/state/ingest.ts ingest' },
];

const ZERO_SOCKET_ENTRY: SocketCallRatchetEntry = {
  sendControlMsg: 0,
  sendControlRequest: 0,
  onControlMessage: 0,
};

function socketBoundaryViolationsIn(
  sourceFiles: readonly TrackedSourceFile[],
  recordedByPath: Readonly<Record<string, SocketCallRatchetEntry>>,
): string[] {
  const violations: string[] = [];
  const scannedNonExemptPaths = new Set<string>();

  for (const sourceFile of sourceFiles) {
    if (isSocketBoundaryExempt(sourceFile.path)) continue;
    scannedNonExemptPaths.add(sourceFile.path);
    const matchesBySymbol = findSocketCallsInSource(sourceFile.content);
    const recordedEntry = recordedByPath[sourceFile.path] ?? ZERO_SOCKET_ENTRY;

    for (const { symbol, replacement } of SOCKET_SYMBOLS) {
      const symbolMatches = matchesBySymbol[symbol];
      const recordedCount = recordedEntry[symbol];
      if (symbolMatches.length > recordedCount) {
        for (const excessMatch of symbolMatches.slice(recordedCount)) {
          violations.push(
            `${sourceFile.path}:${excessMatch.line}: forbidden control-socket reference "${excessMatch.form}" (${symbolMatches.length} found, ${recordedCount} recorded) -> use ${replacement}`,
          );
        }
      }
      if (symbolMatches.length < recordedCount) {
        violations.push(
          `${sourceFile.path}:1: "${symbol}" count dropped from ${recordedCount} to ${symbolMatches.length} -> lower its recorded count in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
        );
      }
    }
  }

  for (const recordedPath of Object.keys(recordedByPath)) {
    if (scannedNonExemptPaths.has(recordedPath)) continue;
    violations.push(
      `${recordedPath}:1: recorded socket entry is gone -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }

  return violations;
}

test('no public file calls control-socket helpers past its recorded ratchet count', () => {
  const trackedPaths = trackedFiles(PUBLIC_SOURCE_PATTERN);
  assert.ok(trackedPaths.length > 0, 'expected tracked public/**/*.{ts,tsx} files');
  const sourceFiles = trackedPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const committedRatchets = readCommittedStateRatchets();
  const violations = socketBoundaryViolationsIn(sourceFiles, committedRatchets.socketCalls);
  assert.deepEqual(
    violations,
    [],
    `Client control-socket boundary violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-socket-boundary gate fails on planted violations with file, line, form, and replacement', () => {
  const plantedFiles: TrackedSourceFile[] = [
    {
      path: 'public/planted-socket-view.ts',
      content: [
        "import './planted-socket-view.css';",
        "import { onControlMessage, sendControlMsg as sendMsg, sendControlRequest } from './control-ws.ts';",
        'export function runPlantedSocketView() {',
        "  sendMsg({ type: 'ping' });",
        "  void sendControlRequest('get-settings', {});",
        '  onControlMessage(() => {});',
        "  return \"from './note'\";",
        '}',
      ].join('\n'),
    },
    {
      path: 'public/planted-lowered-view.ts',
      content: 'export function runPlantedLoweredView() {}\n',
    },
  ];
  const recorded: Record<string, SocketCallRatchetEntry> = {
    'public/planted-lowered-view.ts': { sendControlMsg: 1, sendControlRequest: 0, onControlMessage: 0 },
    'public/planted-deleted-view.ts': { sendControlMsg: 1, sendControlRequest: 0, onControlMessage: 0 },
  };

  const violations = socketBoundaryViolationsIn(plantedFiles, recorded);
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-socket-view.ts:4:') && entry.includes('sendMsg') && entry.includes('public/state/define-action.ts defineAction')),
    `expected aliased sendControlMsg violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-socket-view.ts:5:') && entry.includes('sendControlRequest') && entry.includes('public/state/define-action.ts defineAction')),
    `expected sendControlRequest violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-socket-view.ts:6:') && entry.includes('onControlMessage') && entry.includes('public/state/ingest.ts ingest')),
    `expected onControlMessage violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-lowered-view.ts:1:') && entry.includes('lower its recorded count')),
    `expected lowered-count violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('public/planted-deleted-view.ts:1:') && entry.includes('remove it')),
    `expected deleted-file violation, got: ${violations.join(' | ')}`,
  );
});
