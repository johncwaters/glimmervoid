import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { SessionSnapshot } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import {
  INITIAL_SESSIONS_STATE,
  applyOptimisticApprovalDecision,
  applyOptimisticSessionRemove,
  applyOptimisticSessionRename,
  applyOptimisticSessionRestart,
  applySessionsServerMessage,
} from '../public/state/sessions-core.ts';
import type { SessionsCollectionState } from '../public/state/sessions-core.ts';

function sampleSnapshotRow(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'session-1',
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

function applyMessage(state: SessionsCollectionState, message: ServerMessage): SessionsCollectionState {
  let current = structuredClone(state);
  applySessionsServerMessage(current, message, {
    replace(nextState) {
      current = structuredClone(nextState);
    },
  });
  return current;
}

test('sessions reducer applies snapshot, rename, status, title, git, merge-status, and remove', () => {
  let state = applyMessage(INITIAL_SESSIONS_STATE, {
    type: 'snapshot',
    seq: 1,
    serverBuild: 'build-1',
    sessions: [sampleSnapshotRow()],
  } as ServerMessage);

  assert.equal(state.serverBuild, 'build-1');
  assert.deepEqual(state.order, ['session-1']);
  assert.equal(state.byId['session-1']?.name, 'alpha');

  state = applyMessage(state, {
    type: 'session-renamed',
    seq: 2,
    id: 'session-1',
    oldName: 'alpha',
    newName: 'beta',
  } as ServerMessage);
  assert.equal(state.byId['session-1']?.name, 'beta');

  state = applyMessage(state, {
    type: 'session-status',
    seq: 3,
    id: 'session-1',
    session: 'beta',
    timestamp: 2000,
    transition: { from: STATES.IDLE, to: STATES.RUNNING },
    stateSince: 2000,
  } as ServerMessage);
  assert.equal(state.byId['session-1']?.state, STATES.RUNNING);
  assert.equal(state.byId['session-1']?.stateSince, 2000);

  state = applyMessage(state, {
    type: 'session-title',
    seq: 4,
    id: 'session-1',
    taskTitle: 'Ship S4.1',
    isCustom: true,
  } as ServerMessage);
  assert.equal(state.byId['session-1']?.taskTitle, 'Ship S4.1');
  assert.equal(state.byId['session-1']?.taskTitleIsCustom, true);

  state = applyMessage(state, {
    type: 'session-removed',
    seq: 5,
    id: 'session-1',
    session: 'beta',
  } as ServerMessage);
  assert.equal(state.byId['session-1'], undefined);
  assert.deepEqual(state.order, []);
});

test('optimistic helpers update name, restart state, and removal without mutating unrelated sessions', () => {
  const seeded = applyMessage(INITIAL_SESSIONS_STATE, {
    type: 'snapshot',
    seq: 1,
    serverBuild: null,
    sessions: [
      sampleSnapshotRow({ id: 'session-1', name: 'alpha', state: STATES.FAILED, failureReason: 'boom' }),
      sampleSnapshotRow({ id: 'session-2', name: 'gamma', state: STATES.IDLE }),
    ],
  } as ServerMessage);

  const renamed = structuredClone(seeded);
  applyOptimisticSessionRename(renamed, 'session-1', 'renamed');
  assert.equal(renamed.byId['session-1']?.name, 'renamed');
  assert.equal(renamed.byId['session-2']?.name, 'gamma');

  const restarted = structuredClone(seeded);
  applyOptimisticSessionRestart(restarted, 'session-1');
  assert.equal(restarted.byId['session-1']?.state, STATES.INITIALIZING);
  assert.equal(restarted.byId['session-1']?.failureReason, null);
  assert.equal(restarted.byId['session-2']?.state, STATES.IDLE);

  const removed = structuredClone(seeded);
  applyOptimisticSessionRemove(removed, 'session-1');
  assert.equal(removed.byId['session-1'], undefined);
  assert.deepEqual(removed.order, ['session-2']);

  const approved = structuredClone(seeded);
  approved.byId['session-1'].state = STATES.WAITING;
  approved.byId['session-1'].pendingPromptKind = 'approval';
  applyOptimisticApprovalDecision(approved, 'session-1');
  assert.equal(approved.byId['session-1']?.state, STATES.RUNNING);
  assert.equal(approved.byId['session-1']?.pendingPromptKind, null);
  assert.equal(approved.byId['session-2']?.state, STATES.IDLE);
});
