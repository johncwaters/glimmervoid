import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '../session/sessions.ts';
import { PLAN_BODY_CAP_BYTES } from '../shared/contracts/plan-review.ts';
import { composePlanFeedback } from '../server/core/plan-feedback-core.ts';
import { createPlanReviewWiring } from '../server/plan-review-wiring.ts';
import type { PlanReadResult } from '../server/plan-review-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-plan-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const temporaryDirectories: string[] = [claudeHome];
after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

interface PlanFrameReview {
  agentId: string | null;
  agentType: string | null;
  revisions: { revision: number }[];
  state: string;
  approvedRevision: number | null;
}

interface PlanFrame {
  type: string;
  id?: string;
  scope?: string;
  reviews?: PlanFrameReview[];
  body?: { agentId: string | null; revision: number; plan: string; planFilePath: string; receivedAt: number } | null;
  message?: string;
}

type PlanReader = (
  sessionId: string,
  request: { agentId?: string | null; revision?: number | null },
) => Promise<PlanReadResult | null>;

function reviewOf(source: { reviews?: PlanFrameReview[] } | null | undefined) {
  return source?.reviews?.find((review) => review.agentId === null) ?? null;
}

type PlanLane = ReturnType<typeof createPlanReviewWiring>;

async function openPlan(lane: PlanLane, event: Parameters<PlanLane['onHookEvent']>[0]): Promise<void> {
  const held = lane.onHookEvent(event);
  heldReplies.push(held);
  await lane.whenIdle();
}

const heldReplies: (Promise<Record<string, unknown> | null> | null)[] = [];

function planWorkspace(name: string) {
  const configDirectory = fs.mkdtempSync(path.join(claudeHome, `${name}-`));
  temporaryDirectories.push(configDirectory);
  return createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: () => {} },
    nowFn: () => 7,
  });
}

function planRequest(plan: string) {
  return { tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath: '/plans/a.md' } };
}

function planHarness(readPlanRevision: PlanReader | null, decidePlanReview: PlanLane['decide'] | null = null) {
  const session = plainSession('session-1');
  const sessions = new Map<string, Session>([[session.id, session]]);
  const server = createControlServer(controlDeps({ projects: [] }, { sessions, readPlanRevision, decidePlanReview }));
  const connection = connectControl<PlanFrame>(server, { trust: 'local' });
  connection.sent.length = 0;
  return connection;
}

test('a plan body crosses the control socket only on request, never as a push', async () => {
  const lane = planWorkspace('body-on-request');
  const pushed: Record<string, unknown>[] = [];
  lane.on('plan-changed', (summary: Record<string, unknown>) => { pushed.push(summary); });
  await openPlan(lane, {
    glimmervoidId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Ship it\n\nthe body'),
    accepted: true,
  });
  assert.equal(pushed.length, 1);
  assert.deepEqual(
    Object.keys(pushed[0]).sort(),
    ['agentId', 'agentType', 'approvedRevision', 'chars', 'hasPlan', 'id', 'lastDecision', 'receivedAt', 'revision', 'state', 'title'],
  );
  assert.equal(pushed[0].title, 'Ship it');
  assert.equal(pushed[0].hasPlan, true);
  assert.equal(pushed[0].receivedAt, 7);
  assert.equal(pushed[0].agentType, null);

  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const response = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.ok(response, 'the body came back on request');
  assert.equal(response.body?.plan, '# Ship it\n\nthe body');
  assert.equal(response.body?.revision, 1);
  assert.equal(reviewOf(response)?.state, 'open', 'the reply is held until the operator decides');
  await lane.stop();
});

test('an ended session is served from the file the lane no longer holds in memory', async () => {
  const lane = planWorkspace('ended-session');
  await openPlan(lane, {
    glimmervoidId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  lane.onHookEvent({ glimmervoidId: 'session-1', event: 'SessionEnd', payload: {}, accepted: true });
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const response = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.equal(response?.body?.plan, '# Ship it');
  assert.equal(reviewOf(response)?.state, 'closed');
  await lane.stop();
});

test('a plan read for a session with no live Session never pins its file against the retention window', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-plan-retention-'));
  temporaryDirectories.push(configDirectory);
  const lane = createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: () => {} },
  });
  const liveSession = plainSession('live-session');
  lane.attachSession(liveSession);
  for (const sessionId of ['dormant-session', 'live-session']) {
    await openPlan(lane, {
      glimmervoidId: sessionId, event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
    });
  }

  const aged = new Date(Date.now() - (40 * 24 * 60 * 60 * 1000));
  const planFileOf = (sessionId: string) => path.join(configDirectory, 'plans', `${sessionId}.jsonl`);
  for (const sessionId of ['dormant-session', 'live-session']) {
    fs.utimesSync(planFileOf(sessionId), aged, aged);
  }

  const read = await lane.readPlanRevision('dormant-session', { agentId: null });
  assert.equal(read?.body?.plan, '# Ship it');

  await lane.start();
  assert.equal(fs.existsSync(planFileOf('dormant-session')), false, 'reading a dormant plan never makes it live');
  assert.equal(fs.existsSync(planFileOf('live-session')), true, 'an attached session keeps its plan file');
  await lane.stop();
});

test('a decision refusal names the plan scope so a trace error can never strand the plan face', async () => {
  const lane = planWorkspace('decision-scope');
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' });
  const refusal = connection.sent.at(-1);
  assert.equal(refusal?.type, 'session-error');
  assert.equal(refusal?.scope, 'plan-decision');

  const disabled = planHarness(null, null);
  await disabled.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' });
  assert.equal(disabled.sent.at(-1)?.scope, 'plan-decision');
  assert.match(String(disabled.sent.at(-1)?.message), /not enabled/);
  await lane.stop();
});

interface HeldReply {
  reply: Promise<Record<string, unknown> | null>;
}

async function openHeld(lane: PlanLane): Promise<HeldReply> {
  const held = lane.onHookEvent({
    glimmervoidId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Ship it'),
    accepted: true,
  });
  assert.ok(held, 'the lane held the reply');
  await lane.whenIdle();
  return { reply: held };
}

test('the deny message the hook reply carries is the text the section comments composed', async () => {
  const lane = planWorkspace('composed-deny');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  const comments = [
    { heading: 'Rollout', comment: 'stage it behind the flag' },
    { heading: null, comment: 'no rollback story anywhere' },
  ];
  await connection.send({
    type: 'plan-decision',
    id: 'session-1',
    agentId: null,
    revision: 1,
    decision: 'revise',
    feedback: 'the whole thing is too long',
    comments,
  });

  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: composePlanFeedback({ revision: 1, comments, feedback: 'the whole thing is too long' }),
      },
    },
  });
  assert.equal(connection.sent.filter((frame) => frame.type === 'session-error').length, 0);
  await lane.stop();
});

test('an approve carrying an edited plan puts the edit in updatedInput, and the path stays the one received', async () => {
  const lane = planWorkspace('edited-approve');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({
    type: 'plan-decision',
    id: 'session-1',
    agentId: null,
    revision: 1,
    decision: 'approve-accept-edits',
    plan: '# Ship it\n\nwith the operator step',
  });

  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { plan: '# Ship it\n\nwith the operator step', planFilePath: '/plans/a.md' },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    },
  });
  await lane.stop();
});

test('an edited plan over the byte cap is refused and the review stays open for a smaller one', async () => {
  const lane = planWorkspace('edited-cap');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  const overCap = String.fromCharCode(0x4e2d).repeat(PLAN_BODY_CAP_BYTES / 2);
  assert.ok(overCap.length <= PLAN_BODY_CAP_BYTES, 'the edit is inside the character cap the wire enforces');
  await connection.send({
    type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve', plan: overCap,
  });

  const refusal = connection.sent.at(-1);
  assert.equal(refusal?.type, 'session-error');
  assert.match(String(refusal?.message), /larger than the plan hook carries/);
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'open');

  await connection.send({
    type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve', plan: '# Small',
  });
  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { plan: '# Small', planFilePath: '/plans/a.md' } },
    },
  });
  await lane.stop();
});
