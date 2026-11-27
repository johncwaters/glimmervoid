import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { ChatOutboxEntry, SessionSnapshot } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import {
  INITIAL_CHAT_OUTBOX_STATE,
  OPTIMISTIC_OUTBOX_ENTRY_PREFIX,
  applyChatOutboxServerMessage,
  applyOptimisticChatCancel,
  applyOptimisticChatSend,
  createChatOutboxProjection,
  isChatOutboxAwaitingTurn,
  isOptimisticOutboxEntryId,
  newestCancellableChatOutboxEntryOf,
  queuedChatOutboxEntriesOf,
  reconcileChatOutboxProjection,
  takeStandInsForPrompts,
} from '../public/state/chat-outbox-core.ts';
import type { ChatOutboxCollectionState } from '../public/state/chat-outbox-core.ts';

function sampleEntry(overrides: Partial<ChatOutboxEntry> = {}): ChatOutboxEntry {
  return {
    entryId: 'entry-1',
    text: 'hello',
    attachments: [],
    state: 'held',
    failure: null,
    shouldOpenTerminal: false,
    origin: 'operator',
    ...overrides,
  };
}

function sampleSnapshotRow(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    name: 'alpha',
    taskTitle: null,
    taskTitleIsCustom: false,
    path: '/tmp/repo',
    agent: 'claude-code',
    agentDrawsAlternateScreen: false,
    hasTerminal: true,
    state: STATES.IDLE,
    stateSince: 1000,
    dangerouslySkipPermissions: false,
    saneYolo: false,
    isQuestionManagerOn: false,
    accountId: null,
    isWorktree: false,
    isWorkspace: false,
    resumeSessionId: null,
    ephemeral: false,
    parent: null,
    isStudioMain: false,
    attentionOwner: 'operator',
    linkedPrs: [],
    mergeStatus: 'none',
    mergeReason: null,
    activeAgents: 0,
    awaitingBackgroundTasks: false,
    pendingPromptKind: null,
    usageLimit: null,
    unseenOutcome: null,
    failureReason: null,
    attentionNotes: [],
    planGate: null,
    auditLog: [],
    managerSeenSeq: 0,
    passedQuestionSeq: 0,
    ...overrides,
  } as SessionSnapshot;
}

function applyMessage(state: ChatOutboxCollectionState, message: ServerMessage): ChatOutboxCollectionState {
  let current = structuredClone(state);
  applyChatOutboxServerMessage(current, message, {
    replace(nextState) {
      current = structuredClone(nextState);
    },
  });
  return current;
}

test('chat-outbox reducer applies snapshot, session-status, and session-removed without wiping omitted chatOutbox', () => {
  let state = applyMessage(INITIAL_CHAT_OUTBOX_STATE, {
    type: 'snapshot',
    seq: 1,
    serverBuild: 'build-1',
    sessions: [
      sampleSnapshotRow({ id: 's1', chatOutbox: [sampleEntry({ entryId: 'e1', text: 'first' })] }),
      sampleSnapshotRow({ id: 's2', chatOutbox: [] }),
    ],
  } as ServerMessage);

  assert.deepEqual(state.bySessionId.s1?.map((entry) => entry.entryId), ['e1']);
  assert.equal(state.bySessionId.s2, undefined);

  state = applyMessage(state, {
    type: 'session-status',
    seq: 2,
    id: 's1',
    session: 'alpha',
    timestamp: 2000,
  } as ServerMessage);
  assert.deepEqual(state.bySessionId.s1?.map((entry) => entry.entryId), ['e1']);

  state = applyMessage(state, {
    type: 'session-status',
    seq: 3,
    id: 's1',
    session: 'alpha',
    timestamp: 2100,
    chatOutbox: [sampleEntry({ entryId: 'e2', text: 'second', state: 'sending' })],
  } as ServerMessage);
  assert.deepEqual(state.bySessionId.s1?.map((entry) => entry.entryId), ['e2']);

  state = applyMessage(state, {
    type: 'session-removed',
    seq: 4,
    id: 's1',
    session: 'alpha',
  } as ServerMessage);
  assert.equal(state.bySessionId.s1, undefined);
});

test('optimistic send handles trimming, concurrent identical sends, stalled outbox, and optimistic cancel guards sending', () => {
  const opt1 = `${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}1`;
  const opt2 = `${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}2`;
  assert.equal(isOptimisticOutboxEntryId(opt1), true);
  assert.equal(isOptimisticOutboxEntryId('srv-1'), false);

  const emptyDraft: ChatOutboxCollectionState = { bySessionId: {} };
  applyOptimisticChatSend(emptyDraft, {
    sessionId: 's1',
    optimisticEntryId: opt1,
    text: '  continue  ',
    attachments: [],
    isTurnRunning: false,
    knownServerEntryIds: new Set(),
    priorInFlightMatchCount: 0,
  });
  assert.equal(emptyDraft.bySessionId.s1?.[0]?.text, 'continue');
  assert.equal(emptyDraft.bySessionId.s1?.[0]?.state, 'sending');

  const behindFailed: ChatOutboxCollectionState = {
    bySessionId: {
      s1: [sampleEntry({ entryId: 'e1', text: 'failed-one', state: 'failed', failure: 'boom' })],
    },
  };
  applyOptimisticChatSend(behindFailed, {
    sessionId: 's1',
    optimisticEntryId: opt1,
    text: 'waits behind failure',
    attachments: [],
    isTurnRunning: false,
    knownServerEntryIds: new Set(['e1']),
    priorInFlightMatchCount: 0,
  });
  assert.equal(behindFailed.bySessionId.s1?.[1]?.state, 'held');

  const afterFirstServerPush: ChatOutboxCollectionState = {
    bySessionId: {
      s1: [sampleEntry({ entryId: 'srv-1', text: 'continue', state: 'sending' })],
    },
  };
  applyOptimisticChatSend(afterFirstServerPush, {
    sessionId: 's1',
    optimisticEntryId: opt1,
    text: 'continue',
    attachments: [],
    isTurnRunning: false,
    knownServerEntryIds: new Set(),
    priorInFlightMatchCount: 0,
  });
  applyOptimisticChatSend(afterFirstServerPush, {
    sessionId: 's1',
    optimisticEntryId: opt2,
    text: 'continue',
    attachments: [],
    isTurnRunning: false,
    knownServerEntryIds: new Set(),
    priorInFlightMatchCount: 1,
  });
  assert.deepEqual(afterFirstServerPush.bySessionId.s1?.map((entry) => entry.entryId), ['srv-1', opt2]);

  const withSending: ChatOutboxCollectionState = {
    bySessionId: {
      s1: [sampleEntry({ entryId: 'e1', state: 'sending' })],
    },
  };
  applyOptimisticChatCancel(withSending, 's1', 'e1');
  assert.deepEqual(withSending.bySessionId.s1?.map((entry) => entry.entryId), ['e1']);

  const withFailure: ChatOutboxCollectionState = {
    bySessionId: {
      s1: [
        sampleEntry({ entryId: 'e1', state: 'failed', failure: 'boom' }),
        sampleEntry({ entryId: 'e2', state: 'held' }),
      ],
    },
  };
  applyOptimisticChatCancel(withFailure, 's1', 'e1');
  assert.equal(withFailure.bySessionId.s1, undefined);
});

test('projection adopts only new server entries and removes rolled-back optimistic stand-in without hijacking prior held entry', () => {
  const projection = createChatOutboxProjection();
  const optimisticId = `${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}1`;
  const optimisticEntry = sampleEntry({ entryId: optimisticId, text: 'ask-chat', state: 'sending' });

  const initial = reconcileChatOutboxProjection(projection, [optimisticEntry], false, 100);
  assert.equal(initial.addedStandIns.length, 1);
  assert.equal(initial.addedStandIns[0]?.id, `sent-${optimisticId}`);
  assert.equal(isChatOutboxAwaitingTurn(projection, [optimisticEntry], false), true);
  assert.deepEqual(queuedChatOutboxEntriesOf(projection, [optimisticEntry]), []);
  assert.equal(newestCancellableChatOutboxEntryOf(projection, [sampleEntry({ entryId: optimisticId, state: 'held' })]), undefined);

  const serverEntry = sampleEntry({ entryId: 'srv-1', text: 'ask-chat', state: 'sending' });
  const adopted = reconcileChatOutboxProjection(projection, [serverEntry], false, 150);
  assert.deepEqual(adopted.addedStandIns, []);
  assert.deepEqual(adopted.removedStandInEntryIds, []);
  assert.deepEqual(adopted.clearedStandInEntryIds, []);
  assert.equal(projection.standInByEntryId.get('srv-1')?.id, `sent-${optimisticId}`);
  assert.deepEqual(takeStandInsForPrompts(projection, 1), ['srv-1']);

  const rollbackProjection = createChatOutboxProjection();
  const existingHeld = sampleEntry({ entryId: 'srv-old', text: 'continue', state: 'held' });
  reconcileChatOutboxProjection(rollbackProjection, [existingHeld], true, 100);
  const optimisticSameText = sampleEntry({ entryId: `${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}4`, text: 'continue', state: 'sending' });
  reconcileChatOutboxProjection(rollbackProjection, [existingHeld, optimisticSameText], false, 200);
  const rolledBack = reconcileChatOutboxProjection(rollbackProjection, [existingHeld], false, 300);
  assert.deepEqual(rolledBack.removedStandInEntryIds, [`${OPTIMISTIC_OUTBOX_ENTRY_PREFIX}4`]);
  assert.deepEqual(rolledBack.queuedEntries.map((entry) => entry.entryId), ['srv-old']);
  assert.equal(newestCancellableChatOutboxEntryOf(rollbackProjection, [existingHeld])?.entryId, 'srv-old');
});
