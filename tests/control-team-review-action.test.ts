import test from 'node:test';
import assert from 'node:assert/strict';

import type { TeamReviewActionControl } from '../server/control-handlers.ts';
import type { TeamReviewActionRequest } from '../shared/contracts/team-review.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const REVIEWED_HEAD = 'a'.repeat(40);
const KEY = 'Acme/app#7';

interface ActionFrame {
  type: string;
  requestId?: string | null;
  key?: string;
  ok?: boolean;
  error?: string;
  warning?: string;
}

function harness({ isRunning = true, outcome = { ok: true } }: { isRunning?: boolean; outcome?: Awaited<ReturnType<TeamReviewActionControl['submitAction']>> } = {}) {
  const submitted: TeamReviewActionRequest[] = [];
  const teamReview: TeamReviewActionControl = {
    isRunning: () => isRunning,
    submitAction: async (request) => {
      submitted.push(request);
      return outcome;
    },
  };
  const server = createControlServer(controlDeps({ projects: [] }, { teamReview }));
  const connection = connectControl<ActionFrame>(server);
  connection.sent.length = 0;
  return {
    send: (message: Record<string, unknown>) => Promise.resolve(connection.send({
      type: 'team-review-action', requestId: 'review-1', key: KEY, head: REVIEWED_HEAD, body: 'LGTM', comments: [], ...message,
    })),
    results: () => connection.sent.filter((frame) => frame.type === 'team-review-action-result'),
    submitted,
  };
}

test('a valid action is handed to the lane and its outcome is replied for the key', async () => {
  const h = harness({ outcome: { ok: true, warning: 'Do not post it again' } });
  await h.send({ action: 'approve' });
  assert.deepEqual(h.submitted, [{ key: KEY, head: REVIEWED_HEAD, action: 'approve', body: 'LGTM', comments: [] }]);
  assert.deepEqual(h.results(), [{ type: 'team-review-action-result', requestId: 'review-1', key: KEY, ok: true, warning: 'Do not post it again' }]);
});

test('an action is refused while the lane is not running', async () => {
  const h = harness({ isRunning: false });
  await h.send({ action: 'approve' });
  assert.equal(h.results()[0]?.ok, false);
  assert.match(String(h.results()[0]?.error), /not running/);
  assert.deepEqual(h.submitted, []);
});

test('a malformed action is answered with a failed result for its key', async () => {
  const h = harness();
  await h.send({ action: 'merge' });
  assert.equal(h.results()[0]?.ok, false);
  assert.equal(h.results()[0]?.key, KEY);
  assert.deepEqual(h.submitted, []);
});
