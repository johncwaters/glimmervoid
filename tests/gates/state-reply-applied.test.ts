import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientMessage, ServerMessage } from '../../shared/contracts/control-messages.ts';
import { requestId as controlRequestId } from '../../shared/contracts/control/control-fields.ts';
import { CLIENT_MESSAGE_CLASS, MUTATION_COLLECTIONS, SERVER_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';
import type { ClientMessageClass } from '../../shared/contracts/control/message-classes.ts';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';
import {
  CONTROL_HANDLER_PATTERN,
  STATE_RATCHETS_RELATIVE_PATH,
  analyzeControlHandlerFile,
  readCommittedStateRatchets,
} from '../../scripts/state-inventory.ts';
import type { ControlHandlerEntryAnalysis, StateRatchetData, TrackedSourceFile } from '../../scripts/state-inventory.ts';

interface ClientSchemaSummary {
  type: string;
  hasRequestId: boolean;
  messageClass: ClientMessageClass;
}

interface ServerReplySummary {
  type: string;
  hasAppliedSeq: boolean;
}

type ReplyAppliedRatchetSlice = Pick<
  StateRatchetData,
  'unconvertedMutatingHandlers' | 'legacyMutatingWithoutRequestId' | 'legacyMutatingRepliesWithoutAppliedSeq'
>;

function checkClientRequestIdViolations(
  clientSchemas: readonly ClientSchemaSummary[],
  legacyWithoutRequestId: readonly string[],
  violations: string[],
): void {
  const legacySet = new Set(legacyWithoutRequestId);
  const actualMissing = new Set<string>();

  for (const schema of clientSchemas) {
    if (schema.messageClass !== 'mutating') continue;
    if (schema.hasRequestId) continue;
    actualMissing.add(schema.type);
    if (legacySet.has(schema.type)) continue;
    violations.push(
      `shared/contracts/control-messages.ts:1: mutating client schema "${schema.type}" lacks requestId -> add requestId from shared/contracts/control/control-fields.ts`,
    );
  }

  for (const recordedType of legacyWithoutRequestId) {
    if (actualMissing.has(recordedType)) continue;
    violations.push(
      `shared/contracts/control-messages.ts:1: recorded legacy mutating type "${recordedType}" now carries requestId -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }
}

function checkHandlerFileViolations(
  handlerFiles: readonly TrackedSourceFile[],
  recordedUnconverted: Readonly<Record<string, number>>,
  violations: string[],
  expectedMutatingTypes?: readonly string[],
): Set<string> {
  const scannedPaths = new Set<string>();
  const mutatingReplyTypes = new Set<string>();
  const discoveredMutatingTypes = new Set<string>();

  for (const handlerFile of handlerFiles) {
    scannedPaths.add(handlerFile.path);
    const entries: ControlHandlerEntryAnalysis[] = analyzeControlHandlerFile(handlerFile);
    const unconvertedEntries: ControlHandlerEntryAnalysis[] = [];

    for (const entry of entries) {
      if (entry.messageClass !== 'mutating') {
        if (!entry.hasReplyApplied) continue;
        violations.push(
          `${handlerFile.path}:${entry.replyAppliedLine ?? entry.line}: forbidden "replyApplied(" in ${entry.messageClass} handler "${entry.typeName}" -> use server/control/control-context.ts replyTo`,
        );
        continue;
      }

      discoveredMutatingTypes.add(entry.typeName);
      for (const replyType of entry.replyTypes) mutatingReplyTypes.add(replyType);
      if (!entry.hasReplyApplied || entry.bareReplies.length > 0) {
        unconvertedEntries.push(entry);
      }
    }

    const recordedCount = recordedUnconverted[handlerFile.path] ?? 0;
    if (unconvertedEntries.length > recordedCount) {
      for (const excessEntry of unconvertedEntries.slice(recordedCount)) {
        const firstBare = excessEntry.bareReplies[0];
        const line = firstBare?.line ?? excessEntry.line;
        const form = firstBare ? `bare "${firstBare.form}"` : 'missing replyApplied(';
        violations.push(
          `${handlerFile.path}:${line}: mutating handler "${excessEntry.typeName}" uses ${form} (${unconvertedEntries.length} unconverted, ${recordedCount} recorded) -> use server/control/control-context.ts replyApplied`,
        );
      }
    }
    if (unconvertedEntries.length < recordedCount) {
      violations.push(
        `${handlerFile.path}:1: unconverted mutating handler count dropped from ${recordedCount} to ${unconvertedEntries.length} -> lower its recorded count in ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
      );
    }
  }

  for (const recordedPath of Object.keys(recordedUnconverted)) {
    if (scannedPaths.has(recordedPath)) continue;
    violations.push(
      `${recordedPath}:1: recorded unconverted mutating handler entry is gone -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }

  if (expectedMutatingTypes) {
    for (const expectedType of expectedMutatingTypes) {
      if (discoveredMutatingTypes.has(expectedType)) continue;
      violations.push(
        `server/control/handlers:1: mutating client type "${expectedType}" was not discovered in any ControlHandlerTable -> keep it registered in server/control/handlers/*-handlers.ts`,
      );
    }
  }

  return mutatingReplyTypes;
}

function checkMutatingReplySchemaViolations(
  mutatingReplyTypes: ReadonlySet<string>,
  serverReplySchemas: readonly ServerReplySummary[],
  legacyRepliesWithoutAppliedSeq: readonly string[],
  violations: string[],
): void {
  const hasAppliedSeqByReply = new Map<string, boolean>();
  for (const schema of serverReplySchemas) hasAppliedSeqByReply.set(schema.type, schema.hasAppliedSeq);

  const legacySet = new Set(legacyRepliesWithoutAppliedSeq);
  const actualMissing = new Set<string>();

  for (const replyType of mutatingReplyTypes) {
    if (hasAppliedSeqByReply.get(replyType) !== false) continue;
    actualMissing.add(replyType);
    if (legacySet.has(replyType)) continue;
    violations.push(
      `shared/contracts/control-messages.ts:1: mutating reply schema "${replyType}" lacks appliedSeq -> declare it with shared/contracts/control/control-fields.ts looseMutatingReply`,
    );
  }

  for (const recordedReply of legacyRepliesWithoutAppliedSeq) {
    if (actualMissing.has(recordedReply)) continue;
    violations.push(
      `shared/contracts/control-messages.ts:1: recorded legacy mutating reply "${recordedReply}" now carries appliedSeq -> remove it from ${STATE_RATCHETS_RELATIVE_PATH} in the same change`,
    );
  }
}

function replyAppliedViolationsIn(
  handlerFiles: readonly TrackedSourceFile[],
  clientSchemas: readonly ClientSchemaSummary[],
  serverReplySchemas: readonly ServerReplySummary[],
  recorded: ReplyAppliedRatchetSlice,
  expectedMutatingTypes?: readonly string[],
): string[] {
  const violations: string[] = [];
  checkClientRequestIdViolations(clientSchemas, recorded.legacyMutatingWithoutRequestId, violations);
  const mutatingReplyTypes = checkHandlerFileViolations(handlerFiles, recorded.unconvertedMutatingHandlers, violations, expectedMutatingTypes);
  checkMutatingReplySchemaViolations(mutatingReplyTypes, serverReplySchemas, recorded.legacyMutatingRepliesWithoutAppliedSeq, violations);
  return violations;
}

test('mutating handlers reply through replyApplied with appliedSeq and requestId within recorded ratchets', () => {
  const handlerPaths = trackedFiles(CONTROL_HANDLER_PATTERN).sort();
  assert.ok(handlerPaths.length > 0, 'expected tracked server/control/handlers/*-handlers.ts files');
  const handlerFiles = handlerPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));

  const clientSchemas: ClientSchemaSummary[] = ClientMessage.options.map((option) => {
    const type = option.shape.type.value;
    return { type, hasRequestId: 'requestId' in option.shape && option.shape.requestId === controlRequestId, messageClass: CLIENT_MESSAGE_CLASS[type] };
  });
  const serverReplySchemas: ServerReplySummary[] = ServerMessage.options
    .filter((option) => SERVER_MESSAGE_CLASS[option.shape.type.value] === 'reply')
    .map((option) => ({ type: option.shape.type.value, hasAppliedSeq: Object.hasOwn(option.shape, 'appliedSeq') }));

  const committedRatchets = readCommittedStateRatchets();
  const expectedMutatingTypes = Object.keys(MUTATION_COLLECTIONS).sort();
  const violations = replyAppliedViolationsIn(handlerFiles, clientSchemas, serverReplySchemas, committedRatchets, expectedMutatingTypes);
  assert.deepEqual(
    violations,
    [],
    `Control replyApplied contract violations:\n  ${violations.join('\n  ')}`,
  );
});

test('state-reply-applied gate fails on planted violations for all four conditions, syntax variants, and lowered ratchets', () => {
  const plantedHandlers: TrackedSourceFile[] = [
    {
      path: 'server/control/handlers/planted-handlers.ts',
      content: [
        'const sendBare = (msg, socket) => {',
        "  replyTo(socket, msg, 'whiteboard-result', { ok: true });",
        '};',
        'const handleSilentMutate = (msg, socket) => {',
        '  socket.send(JSON.stringify({ ok: true }));',
        '};',
        'const handleBadRead = (msg, socket) => {',
        "  replyApplied(socket, msg, 'start-picks', { picks: [] });",
        '};',
        'const sessionHandlers: ControlHandlerTable = {',
        "  'rename-session': (msg, socket) => {",
        "    const nested = { 'nested-key': true };",
        '    void nested;',
        '    sendBare(msg, socket);',
        '  },',
        '  kill: handleSilentMutate,',
        "  'list-start-picks': handleBadRead,",
        '};',
      ].join('\n'),
    },
    {
      path: 'server/control/handlers/planted-lowered-handlers.ts',
      content: [
        'const handlers = {',
        '} satisfies ControlHandlerTable;',
      ].join('\n'),
    },
  ];
  const plantedClients: ClientSchemaSummary[] = [
    { type: 'rename-session', hasRequestId: false, messageClass: 'mutating' },
    { type: 'kill', hasRequestId: true, messageClass: 'mutating' },
    { type: 'list-start-picks', hasRequestId: true, messageClass: 'read' },
  ];
  const plantedServerReplies: ServerReplySummary[] = [
    { type: 'whiteboard-result', hasAppliedSeq: false },
    { type: 'session-action-result', hasAppliedSeq: true },
  ];
  const recorded: ReplyAppliedRatchetSlice = {
    unconvertedMutatingHandlers: {
      'server/control/handlers/planted-lowered-handlers.ts': 1,
      'server/control/handlers/planted-deleted-handlers.ts': 1,
    },
    legacyMutatingWithoutRequestId: ['kill'],
    legacyMutatingRepliesWithoutAppliedSeq: ['session-action-result'],
  };

  const violations = replyAppliedViolationsIn(
    plantedHandlers,
    plantedClients,
    plantedServerReplies,
    recorded,
    ['rename-session', 'kill', 'restart'],
  );
  assert.ok(
    violations.some((entry) => entry.includes('mutating client schema "rename-session" lacks requestId') && entry.includes('shared/contracts/control/control-fields.ts')),
    `expected missing requestId violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('server/control/handlers/planted-handlers.ts:2:') && entry.includes('rename-session') && entry.includes('replyTo(') && entry.includes('server/control/control-context.ts replyApplied')),
    `expected bare replyTo violation via arrow helper and nested key, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('server/control/handlers/planted-handlers.ts:5:') && entry.includes('kill') && entry.includes('socket.send(') && entry.includes('server/control/control-context.ts replyApplied')),
    `expected non-ws socket.send violation on unquoted key, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('mutating reply schema "whiteboard-result" lacks appliedSeq') && entry.includes('looseMutatingReply')),
    `expected missing appliedSeq violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('server/control/handlers/planted-handlers.ts:8:') && entry.includes('read handler "list-start-picks"') && entry.includes('server/control/control-context.ts replyTo')),
    `expected read calling replyApplied violation via arrow handler, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('mutating client type "restart" was not discovered')),
    `expected completeness violation for missing mutating type, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('planted-lowered-handlers.ts:1:') && entry.includes('lower its recorded count')),
    `expected lowered handler count violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('planted-deleted-handlers.ts:1:') && entry.includes('remove it')),
    `expected deleted handler entry violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('recorded legacy mutating type "kill"') && entry.includes('remove it')),
    `expected stale legacy requestId violation, got: ${violations.join(' | ')}`,
  );
  assert.ok(
    violations.some((entry) => entry.includes('recorded legacy mutating reply "session-action-result"') && entry.includes('remove it')),
    `expected stale legacy appliedSeq violation, got: ${violations.join(' | ')}`,
  );
});
