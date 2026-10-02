import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAN_BODY_CAP_BYTES, PLAN_COMMENT_MAX_CHARS, PLAN_HOOK_OUTPUT_MAX_CHARS } from '../shared/contracts/plan-review.ts';
import type { PlanReview, PlanReviewState } from '../shared/contracts/plan-review.ts';
import { createPlanViewModel, currentHeadingIndex, formatRelativeAge, mergePlanChanged, planLimitRefusal, previousRevisionFor } from '../public/plan/plan-view-core.ts';
import type { PlanChangedMessage, PlanViewInput } from '../public/plan/plan-view-core.ts';

const state: PlanReviewState = {
  reviews: [
    {
      agentId: null,
      agentType: null,
      revisions: [
        { revision: 1, receivedAt: 10, chars: 4000, title: 'First' },
        { revision: 2, receivedAt: 20, chars: 8400, title: 'Second' },
      ],
      state: 'open',
      openRevision: { revision: 2, since: 20 },
      approvedRevision: null,
      lastDecision: null,
    },
    {
      agentId: 'agent-1',
      agentType: 'Explore',
      revisions: [{ revision: 1, receivedAt: 30, chars: 1000, title: 'Explore plan' }],
      state: 'closed',
      openRevision: null,
      approvedRevision: 1,
      lastDecision: 'approve',
    },
  ],
};

test('plan view exposes main and subagent tabs with revision metadata', () => {
  const view = createPlanViewModel({
    state,
    selectedAgentId: null,
    selectedRevision: 2,
    body: 'x'.repeat(8400),
    isConnected: true,
  });
  assert.deepEqual(view.tabs.map((tab) => tab.label), ['Main', 'Explore']);
  assert.deepEqual(view.revisions.map((revision) => [revision.label, revision.receivedAt]), [
    ['Rev 1', 10],
    ['Rev 2', 20],
  ]);
  assert.equal(view.status, '');
});

const CONSTANT_LABELS = ['Approve', 'Send feedback', 'Answer in terminal'];

function viewFor(overrides: Partial<PlanReview>, input: Partial<PlanViewInput> = {}) {
  const review: PlanReview = {
    agentId: null,
    agentType: null,
    revisions: [{ revision: 1, receivedAt: 10, chars: 100, title: 'First' }],
    state: 'open',
    openRevision: { revision: 1, since: 10 },
    approvedRevision: null,
    lastDecision: null,
    ...overrides,
  };
  return createPlanViewModel({
    state: { reviews: [review] },
    selectedAgentId: null,
    selectedRevision: 1,
    body: 'plan',
    isConnected: true,
    ...input,
  });
}

test('an open review without comments enables approval and terminal, and the editor shares their guard', () => {
  const view = viewFor({});
  assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS);
  assert.deepEqual(
    view.actions.filter((action) => action.enabled).map((action) => action.kind),
    ['approve', 'terminal'],
  );
});

test('a review that is not open disables every action and says why, with labels unchanged', () => {
  const cases = [
    { overrides: { state: 'released' as const }, status: 'Answer in the terminal' },
    { overrides: { state: 'decided' as const, lastDecision: 'approve' as const }, status: 'Approved' },
    { overrides: { state: 'decided' as const, lastDecision: 'approve-accept-edits' as const }, status: 'Approved' },
    { overrides: { state: 'decided' as const, lastDecision: 'revise' as const }, status: 'Feedback sent, waiting for the next revision' },
    { overrides: { state: 'closed' as const }, status: 'Closed' },
    { overrides: { state: 'closed' as const, approvedRevision: 1 }, status: 'Approved' },
  ];
  for (const { overrides, status } of cases) {
    const view = viewFor({ openRevision: null, ...overrides });
    assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS, 'labels never change with state');
    assert.equal(view.actions.every((action) => action.enabled === false), true, `${overrides.state} disables every action`);
    assert.equal(view.status, status);
  }
});

test('a revision the open one has moved past disables every action and says which one is open', () => {
  const view = viewFor(
    {
      revisions: [
        { revision: 1, receivedAt: 10, chars: 100, title: 'First' },
        { revision: 2, receivedAt: 20, chars: 100, title: 'Second' },
      ],
      openRevision: { revision: 2, since: 20 },
    },
    { selectedRevision: 1 },
  );
  assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS, 'labels never change with selection');
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Rev 2 is the one open');
});

test('the status describes the SELECTED revision, so an approved one reads approved under a reopened review', () => {
  const revisions = [
    { revision: 1, receivedAt: 10, chars: 100, title: 'First' },
    { revision: 2, receivedAt: 20, chars: 100, title: 'Second' },
  ];
  const approvedThenReopened = viewFor(
    { revisions, state: 'open', openRevision: { revision: 2, since: 20 }, approvedRevision: 1 },
    { selectedRevision: 1 },
  );
  assert.equal(approvedThenReopened.status, 'Rev 2 is the one open');

  const closedWithApproval = viewFor(
    { revisions, state: 'closed', openRevision: null, approvedRevision: 1 },
    { selectedRevision: 1 },
  );
  assert.equal(closedWithApproval.status, 'Approved');

  const closedUnapprovedRevision = viewFor(
    { revisions, state: 'closed', openRevision: null, approvedRevision: 1 },
    { selectedRevision: 2 },
  );
  assert.equal(closedUnapprovedRevision.status, 'Closed');
});

test('pending section comments are counted beside the state, never inside a button label', () => {
  assert.equal(viewFor({}, { pendingCommentCount: 0 }).status, '');
  assert.equal(
    viewFor({}, { pendingCommentCount: 1 }).status,
    '1 comment to send. Remove it to approve.',
  );
  assert.equal(
    viewFor({}, { pendingCommentCount: 3 }).status,
    '3 comments to send. Remove them to approve.',
  );
  assert.deepEqual(viewFor({}, { pendingCommentCount: 3 }).actions.map((action) => action.label), CONSTANT_LABELS);
});

test('a draft on screen is labelled a draft and takes no decision, whatever the review says', () => {
  const view = viewFor({}, { isDraft: true, body: 'draft body' });
  assert.equal(view.status, 'Draft');
  assert.equal(view.actions.every((action) => action.enabled === false), true, 'nobody approves bytes the agent has not submitted');
  assert.deepEqual(view.actions.map((action) => action.label), CONSTANT_LABELS);
  assert.equal(viewFor({}, { isDraft: true, body: 'draft body', pendingCommentCount: 2 }).status, 'Draft');
});

test('the previous revision is what a diff runs against, and the first revision has none', () => {
  const revisions = [
    { revision: 1, receivedAt: 10, chars: 100, title: 'First' },
    { revision: 3, receivedAt: 30, chars: 100, title: 'Third' },
  ];
  assert.equal(viewFor({ revisions }, { selectedRevision: 3 }).previousRevision, 1);
  assert.equal(viewFor({ revisions }, { selectedRevision: 1 }).previousRevision, null);
  assert.equal(previousRevisionFor({ reviews: [] }, null, 3), null);
});

test('an open revision whose body has not loaded disables every action, so no click approves unread bytes', () => {
  const view = viewFor({}, { body: null });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Loading');
});

test('a decision in flight disables every action and says so beside them', () => {
  const view = viewFor({}, { isDecisionInFlight: true });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Sending your decision');
});

test('a disconnected socket disables every action on an open review', () => {
  const view = viewFor({}, { isConnected: false });
  assert.equal(view.actions.every((action) => action.enabled === false), true);
  assert.equal(view.status, 'Disconnected');
});

function planChanged(overrides: Partial<PlanChangedMessage> = {}): PlanChangedMessage {
  return {
    id: 'session-1',
    agentId: null,
    agentType: null,
    revision: 1,
    receivedAt: 10,
    state: 'open',
    lastDecision: null,
    approvedRevision: null,
    chars: 100,
    title: 'First',
    hasPlan: true,
    ...overrides,
  };
}

test('a resent summary for a known revision replaces it instead of appending a duplicate', () => {
  const opened = mergePlanChanged({ reviews: [] }, planChanged());
  const resent = mergePlanChanged(opened, planChanged({ chars: 250, title: 'First, revised' }));
  assert.equal(resent.reviews.length, 1);
  assert.deepEqual(resent.reviews[0].revisions, [{ revision: 1, receivedAt: 10, chars: 250, title: 'First, revised' }]);
});

test('summaries that arrive out of order are ordered by revision, not arrival', () => {
  const third = mergePlanChanged({ reviews: [] }, planChanged({ revision: 3, receivedAt: 30, title: 'Third' }));
  const first = mergePlanChanged(third, planChanged({ revision: 1, receivedAt: 10, title: 'First' }));
  const merged = mergePlanChanged(first, planChanged({ revision: 2, receivedAt: 20, title: 'Second' }));
  assert.deepEqual(merged.reviews[0].revisions.map((entry) => entry.revision), [1, 2, 3]);
  assert.deepEqual(merged.reviews[0].openRevision, { revision: 2, since: 20 });
});

test('a subagent summary lands beside the main review and the close push carries the approved revision', () => {
  const opened = mergePlanChanged({ reviews: [] }, planChanged());
  const withSubagent = mergePlanChanged(opened, planChanged({ agentId: 'agent-1', agentType: 'Explore' }));
  const closedMain = mergePlanChanged(withSubagent, planChanged({ state: 'closed', approvedRevision: 1 }));
  assert.deepEqual(closedMain.reviews.map((review) => review.agentId), [null, 'agent-1'], 'an updated review keeps its tab position');
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.approvedRevision, 1);
  assert.equal(closedMain.reviews.find((review) => review.agentId === null)?.openRevision, null);
});

test('feedback composing past the hook output limit is refused before it is sent', () => {
  const comments = [0, 1, 2].map((index) => ({
    heading: `Section ${index}`,
    comment: 'x'.repeat(PLAN_COMMENT_MAX_CHARS),
  }));
  const refusal = planLimitRefusal({ comments });
  assert.ok(refusal);
  assert.match(refusal, new RegExp(String(PLAN_HOOK_OUTPUT_MAX_CHARS)));
  assert.equal(planLimitRefusal({ comments: comments.slice(0, 2) }), null);
});

test('a decision serializing past one control frame is refused, since the socket would close on it', () => {
  const plainPlan = 'y'.repeat(PLAN_BODY_CAP_BYTES);
  assert.equal(planLimitRefusal({ plan: plainPlan }), null, 'a plan at the body cap still fits one frame');
  const escapeHeavyPlan = String.fromCharCode(1).repeat(PLAN_BODY_CAP_BYTES - 1);
  const refusal = planLimitRefusal({ plan: escapeHeavyPlan });
  assert.ok(refusal);
  assert.match(refusal, /control frame/);
});

test('the current heading is the last one above the reading line, and the first before any is passed', () => {
  const headingOffsets = [0, 400, 900];
  assert.equal(currentHeadingIndex({ headingOffsets, scrollTop: 0, isScrolledToEnd: false, readingLineOffset: 48 }), 0);
  assert.equal(currentHeadingIndex({ headingOffsets, scrollTop: 360, isScrolledToEnd: false, readingLineOffset: 48 }), 1);
  assert.equal(currentHeadingIndex({ headingOffsets, scrollTop: 899, isScrolledToEnd: false, readingLineOffset: 0 }), 1);
  assert.equal(currentHeadingIndex({ headingOffsets: [120, 400], scrollTop: 0, isScrolledToEnd: false, readingLineOffset: 0 }), 0);
});

test('scrolling to the end marks the last heading, since a short final section never reaches the reading line', () => {
  assert.equal(currentHeadingIndex({ headingOffsets: [0, 400, 900], scrollTop: 500, isScrolledToEnd: true, readingLineOffset: 48 }), 2);
});

test('a plan without headings has no current heading', () => {
  assert.equal(currentHeadingIndex({ headingOffsets: [], scrollTop: 0, isScrolledToEnd: false, readingLineOffset: 48 }), null);
});


test('approval and feedback are mutually exclusive by pending comment count under every decision guard', () => {
  for (const pendingCommentCount of [0, 1, 3]) {
    const live = viewFor({}, { pendingCommentCount });
    assert.equal(live.actions.find((action) => action.kind === 'approve')?.enabled, pendingCommentCount === 0);
    assert.equal(live.actions.find((action) => action.kind === 'revise')?.enabled, pendingCommentCount > 0);
    assert.equal(live.actions.find((action) => action.kind === 'terminal')?.enabled, true);
    for (const guard of [{ isDraft: true }, { body: null }, { isConnected: false }, { isDecisionInFlight: true }]) {
      const blocked = viewFor({}, { pendingCommentCount, ...guard });
      assert.ok(blocked.actions.every((action) => !action.enabled));
      assert.equal(blocked.modes.find((mode) => mode.kind === 'edit')?.enabled, false);
    }
  }
});

test('revision models identify the open revision and mode guards distinguish history from editing', () => {
  const selected = createPlanViewModel({ state, selectedAgentId: null, selectedRevision: 1, body: 'old', isConnected: true });
  assert.deepEqual(selected.revisions.map((revision) => revision.isOpen), [false, true]);
  assert.deepEqual(selected.modes.map((mode) => [mode.label, mode.enabled]), [['Read', true], ['Changes', false], ['Edit', false]]);
  assert.equal(viewFor({}).modes.find((mode) => mode.kind === 'edit')?.enabled, true);
});

test('relative revision ages use the supplied clock, including future and unit boundaries', () => {
  const now = 200_000_000;
  const cases: [number, string][] = [
    [-1000, 'just now'], [0, 'just now'], [59_999, 'just now'], [60_000, '1 min ago'],
    [120_000, '2 min ago'], [3_599_999, '59 min ago'], [3_600_000, '1 hr ago'],
    [86_399_999, '23 hr ago'], [86_400_000, '1 day ago'], [172_800_000, '2 days ago'],
  ];
  for (const [elapsedMs, age] of cases) assert.equal(formatRelativeAge(now - elapsedMs, now), age);
});

test('status omits repeated metadata, handles no selection and appends a problem', () => {
  const input = { state: { reviews: [] }, selectedAgentId: null, selectedRevision: null, body: null, isConnected: true };
  assert.equal(createPlanViewModel(input).status, 'No plan revision selected');
  assert.equal(createPlanViewModel({ ...input, isConnected: false }).status, 'Disconnected');
  assert.equal(viewFor({}, { problem: 'send refused' }).status, 'send refused');
  assert.equal(viewFor({}, { isDecisionInFlight: true, problem: 'send refused' }).status, 'Sending your decision, send refused');
});

test('an unsaved open comment disables approve and send but leaves the terminal, and says to save or cancel it', () => {
  for (const pendingCommentCount of [0, 2]) {
    const view = viewFor({}, { pendingCommentCount, hasUnsavedComment: true });
    assert.deepEqual(view.actions.map((action) => [action.kind, action.enabled]), [['approve', false], ['revise', false], ['terminal', true]]);
    assert.equal(view.status, 'Save or cancel the open comment first.');
  }
});
