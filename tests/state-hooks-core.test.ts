import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import {
  INITIAL_HOOKS_STATE,
  applyHooksServerMessage,
  applyOptimisticHookDelete,
  applyOptimisticHookSave,
  shouldApplyHooksReport,
} from '../public/state/hooks-core.ts';
import type { HooksCollectionState } from '../public/state/hooks-core.ts';

function createState(): HooksCollectionState {
  return structuredClone(INITIAL_HOOKS_STATE);
}

function applyMessage(state: HooksCollectionState, message: ServerMessage): HooksCollectionState {
  let current = state;
  applyHooksServerMessage(current, message, {
    replace(nextState) {
      current = structuredClone(nextState);
    },
  });
  return current;
}

test('shouldApplyHooksReport drops stale requestIds and accepts matching or unsolicited reports', () => {
  assert.equal(shouldApplyHooksReport({ type: 'hooks-report', requestId: 'req-2' }, 'req-2'), true);
  assert.equal(shouldApplyHooksReport({ type: 'hooks-report', requestId: 'req-1' }, 'req-2'), false);
  assert.equal(shouldApplyHooksReport({ type: 'hooks-report' }, 'req-2'), true);
  assert.equal(shouldApplyHooksReport(null, 'req-2'), false);
});

test('applyHooksServerMessage populates report, updates count on hooks-updated, and reconciles saved and deleted hooks', () => {
  let state = createState();
  state = applyMessage(state, {
    type: 'hooks-report',
    requestId: 'req-1',
    hooks: [
      { id: 'h-1', name: 'Lint', event: 'PostToolUse', type: 'command', command: 'npm run lint', enabled: true },
    ],
  } as ServerMessage);

  assert.equal(state.serverRevision, 1);
  assert.equal(state.updatedCount, 1);
  assert.equal(state.report?.hooks?.length, 1);

  state = applyMessage(state, { type: 'hooks-updated', seq: 5, count: 2 } as ServerMessage);
  assert.equal(state.updatedCount, 2);
  assert.equal(state.serverRevision, 2);

  state = applyMessage(state, {
    type: 'save-hook-result',
    ok: true,
    appliedSeq: 5,
    hook: { id: 'h-2', name: 'Notify', event: 'Stop', type: 'command', command: 'echo done', enabled: true },
  } as ServerMessage);
  assert.equal(state.report?.hooks?.length, 2);
  assert.equal(state.report?.hooks?.[1]?.id, 'h-2');

  state = applyMessage(state, {
    type: 'delete-hook-result',
    ok: true,
    appliedSeq: 6,
    id: 'h-1',
  } as ServerMessage);
  assert.equal(state.report?.hooks?.length, 1);
  assert.equal(state.report?.hooks?.[0]?.id, 'h-2');
});

test('applyOptimisticHookSave and applyOptimisticHookDelete update report hooks and bump optimisticRevision', () => {
  let state = createState();
  state = applyMessage(state, {
    type: 'hooks-report',
    hooks: [
      { id: 'h-1', name: 'Lint', event: 'PostToolUse', type: 'command', command: 'npm run lint', enabled: true },
    ],
  } as ServerMessage);

  applyOptimisticHookSave(state, {
    name: 'Guard',
    event: 'PreToolUse',
    type: 'command',
    command: 'exit 0',
    enabled: true,
  }, 'optimistic-hook-1');
  assert.equal(state.report?.hooks?.length, 2);
  assert.equal(state.report?.hooks?.[1]?.id, 'optimistic-hook-1');
  assert.equal(state.optimisticRevision, 1);

  applyOptimisticHookSave(state, {
    id: 'h-1',
    name: 'Lint',
    event: 'PostToolUse',
    type: 'command',
    command: 'npm run lint',
    enabled: false,
  }, 'optimistic-hook-2');
  assert.equal(state.report?.hooks?.length, 2);
  assert.equal((state.report?.hooks?.[0] as { enabled?: boolean } | undefined)?.enabled, false);
  assert.equal(state.optimisticRevision, 2);

  applyOptimisticHookDelete(state, 'h-1');
  assert.equal(state.report?.hooks?.length, 1);
  assert.equal(state.report?.hooks?.[0]?.id, 'optimistic-hook-1');
  assert.equal(state.optimisticRevision, 3);
});
