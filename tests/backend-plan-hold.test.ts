import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import { createPlanReviewWiring } from '../server/plan-review-wiring.ts';
import type { PlanReview } from '../shared/contracts/plan-review.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

type PlanLane = ReturnType<typeof createPlanReviewWiring>;
type HeldReply = Promise<Record<string, unknown> | null> | null;

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function laneWorkspace(name: string): PlanLane {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-plan-hold-${name}-`));
  temporaryDirectories.push(configDirectory);
  return createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: () => {} },
    nowFn: () => 7,
  });
}

function planRequest(plan: string, agentId: string | null = null) {
  return {
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/plans/a.md' },
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
  };
}

interface Watched {
  isSettled: boolean;
  reply: Record<string, unknown> | null;
}

function watch(held: HeldReply): Watched {
  const watched: Watched = { isSettled: false, reply: null };
  assert.ok(held, 'the lane held the reply instead of answering at once');
  held.then((reply) => {
    watched.isSettled = true;
    watched.reply = reply;
  });
  return watched;
}

async function openHold(
  lane: PlanLane,
  { sessionId = 'session-1', plan = '# Ship it', agentId = null as string | null }: {
    sessionId?: string;
    plan?: string;
    agentId?: string | null;
  },
): Promise<Watched> {
  const watched = watch(lane.onHookEvent({
    glimmervoidId: sessionId,
    event: 'permissionrequest-plan',
    payload: planRequest(plan, agentId),
    accepted: true,
  }));
  await lane.whenIdle();
  return watched;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function reviewOf(result: { reviews: PlanReview[] } | null, agentId: string | null = null) {
  return result?.reviews.find((review) => review.agentId === agentId) ?? null;
}

async function stateOf(lane: PlanLane, sessionId: string, agentId: string | null = null) {
  return reviewOf(await lane.readPlanRevision(sessionId, { agentId }), agentId)?.state ?? null;
}

test('each dashboard decision writes the exact hook reply the spike measured, and moves the review once', async () => {
  const cases = [
    {
      decision: 'approve' as const,
      state: 'decided',
      reply: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { plan: '# Ship it', planFilePath: '/plans/a.md' } },
        },
      },
    },
    {
      decision: 'approve-accept-edits' as const,
      state: 'decided',
      reply: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: { plan: '# Ship it', planFilePath: '/plans/a.md' },
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
          },
        },
      },
    },
    {
      decision: 'revise' as const,
      state: 'decided',
      reply: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'Feedback on plan revision 1:\n\nstep 2 must print the file\n\nRevise the plan and present it again.',
          },
        },
      },
    },
    { decision: 'terminal' as const, state: 'released', reply: {} },
  ];

  for (const { decision, state, reply } of cases) {
    const lane = laneWorkspace(`decision-${decision}`);
    const held = await openHold(lane, {});
    const refusal = lane.decide('session-1', {
      id: 'session-1',
      agentId: null,
      revision: 1,
      decision,
      feedback: 'step 2 must print the file',
    });
    assert.equal(refusal, null, `${decision} was accepted`);
    await flush();
    assert.equal(held.isSettled, true, `${decision} wrote the held reply`);
    assert.deepEqual(held.reply, reply);
    assert.equal(await stateOf(lane, 'session-1'), state);
    await lane.stop();
  }
});

interface HoldServer {
  base: string;
  server: Server;
  lane: PlanLane;
}

async function startHoldServer(name: string): Promise<HoldServer> {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-plan-route-${name}-`));
  temporaryDirectories.push(configDirectory);
  const warnings: string[] = [];
  const lane = createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: (message: string) => { warnings.push(message); } },
    nowFn: () => 7,
  });
  const app = createBackendHttpApp({
    staticDir: null,
    configStore: { configPath: path.join(configDirectory, 'config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    pageToken: 'page-token',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    getPlanReview: () => lane,
    logger: { warn: (message: string) => { warnings.push(message); } },
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  return { base: `http://127.0.0.1:${boundPort(server)}`, server, lane };
}

async function stopHoldServer({ server, lane }: HoldServer): Promise<void> {
  await lane.stop();
  server.closeAllConnections();
  await closeServer(server);
}

async function waitForOpenRevision(lane: PlanLane, sessionId: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const review = reviewOf(await lane.readPlanRevision(sessionId, { agentId: null }));
    if (review?.state === 'open' && review.openRevision) return review.openRevision.revision;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the request never opened a held reply');
}

test('the route holds the response and writes the decision body to the waiting request', async () => {
  const harness = await startHoldServer('decision');
  const pending = fetch(`${harness.base}/hook/session-1/permissionrequest-plan`, {
    method: 'POST',
    body: JSON.stringify(planRequest('# Ship it')),
    headers: { 'content-type': 'application/json' },
  });
  const revision = await waitForOpenRevision(harness.lane, 'session-1');
  assert.equal(harness.lane.decide('session-1', { id: 'session-1', agentId: null, revision, decision: 'approve' }), null);

  const body = await (await pending).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.hookSpecificOutput, {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { plan: '# Ship it', planFilePath: '/plans/a.md' } },
  });
  await stopHoldServer(harness);
});

test('a socket Claude Code destroyed releases the review, and the later write is a no-op', async () => {
  const harness = await startHoldServer('abort');
  const aborter = new AbortController();
  const pending = fetch(`${harness.base}/hook/session-1/permissionrequest-plan`, {
    method: 'POST',
    body: JSON.stringify(planRequest('# Ship it')),
    headers: { 'content-type': 'application/json' },
    signal: aborter.signal,
  }).catch(() => null);
  const revision = await waitForOpenRevision(harness.lane, 'session-1');

  aborter.abort();
  assert.equal(await pending, null, 'the request never came back');
  for (let attempt = 0; attempt < 400; attempt++) {
    if (reviewOf(await harness.lane.readPlanRevision('session-1', { agentId: null }))?.state === 'released') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(reviewOf(await harness.lane.readPlanRevision('session-1', { agentId: null }))?.state, 'released');
  assert.match(
    String(harness.lane.decide('session-1', { id: 'session-1', agentId: null, revision, decision: 'approve' })),
    /no longer open/,
    'a decision after the socket died is refused rather than written',
  );
  await stopHoldServer(harness);
});

test('a PostToolUse carrying the plan twice clears the cap, so a terminal answer still releases the hold', async () => {
  const harness = await startHoldServer('posttooluse-cap');
  const abandonHeldRequest = new AbortController();
  const plan = `# Big plan\n${'y'.repeat(200 * 1024)}`;
  const pending = fetch(`${harness.base}/hook/session-1/permissionrequest-plan`, {
    method: 'POST',
    body: JSON.stringify(planRequest(plan)),
    headers: { 'content-type': 'application/json' },
    signal: abandonHeldRequest.signal,
  }).catch(() => null);

  try {
    const revision = await waitForOpenRevision(harness.lane, 'session-1');
    const approved = await fetch(`${harness.base}/hook/session-1/posttooluse-plan`, {
      method: 'POST',
      body: JSON.stringify({
        tool_name: 'ExitPlanMode',
        tool_input: { plan, planFilePath: '/plans/a.md' },
        tool_response: { plan },
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(approved.status, 200, 'the plan cap covers the event that carries the plan twice');

    const answered = await pending;
    assert.ok(answered, 'the held request came back once the terminal answered');
    const body = await answered.json();
    assert.equal(body.ok, true);
    assert.equal(Object.hasOwn(body, 'hookSpecificOutput'), false, 'the terminal answered, so Glimmervoid decides nothing');
    const review = reviewOf(await harness.lane.readPlanRevision('session-1', { agentId: null }));
    assert.equal(review?.state, 'closed');
    assert.equal(review?.approvedRevision, revision);
  } finally {
    abandonHeldRequest.abort();
    await stopHoldServer(harness);
  }
});

test('an over-cap body logs a known event name only, so a local process cannot forge a journal line', async () => {
  const warnings: string[] = [];
  const app = createBackendHttpApp({
    staticDir: null,
    configStore: { configPath: '/nowhere/config.json' },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    pageToken: 'page-token',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    logger: { warn: (message: string) => { warnings.push(message); } },
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  const base = `http://127.0.0.1:${boundPort(server)}`;
  const forged = 'stop [hook] a forged journal line';
  await fetch(`${base}/hook/session-1/${encodeURIComponent(forged)}`, {
    method: 'POST',
    body: 'x'.repeat(100 * 1024),
    headers: { 'content-type': 'application/json' },
  }).catch(() => {});
  await fetch(`${base}/hook/session-1/Stop`, {
    method: 'POST',
    body: 'x'.repeat(100 * 1024),
    headers: { 'content-type': 'application/json' },
  }).catch(() => {});

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\[hook\] an unknown event body of/);
  assert.equal(warnings[0].includes('forged journal line'), false);
  assert.match(warnings[1], /\[hook\] stop body of/);

  server.closeAllConnections();
  await closeServer(server);
});
