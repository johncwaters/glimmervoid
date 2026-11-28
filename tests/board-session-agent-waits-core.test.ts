import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_AGENT_WAITS_STATE,
  NOT_SENT_TEXT,
  beginWaitsSync,
  closeWaitsState,
  decideWaitsDispatchSettled,
  decideWaitsFailureDisplay,
  decideWaitsOutgoingDispatch,
  shouldExposePlanGate,
  withPlanGateReset,
} from '../public/board-session/agent-waits-core.ts';

test('close then sync reopens waits so failures and cards display again', () => {
  const closed = closeWaitsState(INITIAL_AGENT_WAITS_STATE);
  assert.equal(closed.isClosed, true);
  assert.deepEqual(decideWaitsFailureDisplay(closed, 'boom'), { shouldShow: false, message: null });

  const reopened = beginWaitsSync(closed);
  assert.equal(reopened.isClosed, false);
  assert.equal(reopened.generation, closed.generation);
  assert.deepEqual(decideWaitsFailureDisplay(reopened, 'boom'), { shouldShow: true, message: 'boom' });
});

test('failed reply arriving after close is ignored without rollback or failure notice', () => {
  const started = decideWaitsOutgoingDispatch(INITIAL_AGENT_WAITS_STATE, {
    type: 'decide-approval',
    id: 'sess-1',
    approvalRequestId: 'req-1',
    decision: 'allow',
  });
  assert.ok(started.dispatch !== null);

  const closed = closeWaitsState(INITIAL_AGENT_WAITS_STATE);
  const settled = decideWaitsDispatchSettled(closed, started.dispatch.kind, started.generation, false, 'network down');
  assert.deepEqual(settled, { rollback: 'none', shouldShowFailure: false, failureText: null });
});

test('failed reply from before a close and reopen is ignored as stale generation', () => {
  const started = decideWaitsOutgoingDispatch(INITIAL_AGENT_WAITS_STATE, {
    type: 'plan-decision',
    id: 'sess-1',
    decision: 'approve',
  });
  assert.ok(started.dispatch !== null);

  const reopened = beginWaitsSync(closeWaitsState(INITIAL_AGENT_WAITS_STATE));
  const settled = decideWaitsDispatchSettled(reopened, started.dispatch.kind, started.generation, false, 'stale error');
  assert.deepEqual(settled, { rollback: 'none', shouldShowFailure: false, failureText: null });
});

test('failed reply in the current generation rolls back by dispatch kind and reports error', () => {
  const active = beginWaitsSync(closeWaitsState(INITIAL_AGENT_WAITS_STATE));

  const approvalStart = decideWaitsOutgoingDispatch(active, {
    type: 'decide-approval',
    id: 'sess-1',
    approvalRequestId: 'req-2',
    decision: 'deny',
  });
  assert.ok(approvalStart.dispatch !== null);
  assert.deepEqual(
    decideWaitsDispatchSettled(active, approvalStart.dispatch.kind, approvalStart.generation, false, 'denied failed'),
    { rollback: 'clear-approval', shouldShowFailure: true, failureText: 'denied failed' },
  );

  const planStart = decideWaitsOutgoingDispatch(active, {
    type: 'plan-decision',
    id: 'sess-1',
    decision: 'approve',
  });
  assert.ok(planStart.dispatch !== null);
  assert.deepEqual(
    decideWaitsDispatchSettled(active, planStart.dispatch.kind, planStart.generation, false, ''),
    { rollback: 'reset-plan', shouldShowFailure: true, failureText: NOT_SENT_TEXT },
  );

  assert.equal(shouldExposePlanGate(active), true);
  assert.equal(shouldExposePlanGate(withPlanGateReset(active, true)), false);
});
