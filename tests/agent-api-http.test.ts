import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend/backend.ts';
import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { ensureSessionTempFolder } from '../server/guardrails/guardrails-launch.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../server/spawn-gate.ts';
import { memoryReserveBytes } from '../server/core/memory-admission-core.ts';
import { sessionIdFromBranch } from '../server/core/branch-gc-core.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { describePushLanding, MAX_LIVE_CHILDREN, REFUSAL_REASON } from '../server/core/agent-api-core.ts';
import { AgentLimitsReply, AgentReadReply, AgentReviewDetailReply, AgentReviewsReply } from '../shared/contracts/session.ts';
import { TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { SessionCardFields } from '../shared/contracts/index.ts';
import { DEFAULT_CONFIG, glimmervoidHomeDir } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { STATES } from '../shared/states.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../shared/timer-deps.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { plainSession } from './helpers/fake-session.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { hasGit, git } from './helpers/git-fixture.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';
import { waitFor } from './helpers/wait-for.ts';

const SESSION_ID = 'agent-api-session';
const GIT = hasGit();

interface BootedBackend {
  tmpDir: string;
  server: Server;
  backend: Backend;
  base: string;
  token: string;
}

const booted: { enabled: BootedBackend | null; prevEnv: string | undefined } = {
  enabled: null,
  prevEnv: undefined,
};

function enabledBackend(): BootedBackend {
  if (!booted.enabled) throw new Error('the enabled backend was never booted');
  return booted.enabled;
}

async function boot(prefix: string): Promise<BootedBackend> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'agent api', path: projectDir }],
    repoRoots: [],
    autoResume: false,
  }, null, 2), 'utf8');
  process.env.GLIMMERVOID_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  const token = session.agentToken;
  assert.ok(token, 'the session was minted an agent token');

  return { tmpDir, server, backend, base: `http://127.0.0.1:${boundPort(server)}`, token };
}

async function teardown(context: BootedBackend | null): Promise<void> {
  if (!context) return;
  await settleBackendShutdown(context.backend);
  context.server.closeAllConnections();
  await closeServer(context.server);
  fs.rmSync(context.tmpDir, { recursive: true, force: true });
}

function post(base: string, verb: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/agent/${SESSION_ID}/${verb}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test.before(async () => {
  booted.prevEnv = process.env.GLIMMERVOID_CONFIG;
  booted.enabled = await boot('glimmervoid-agentapi-on-');
});

test.after(async () => {
  await teardown(booted.enabled);
  if (booted.prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (booted.prevEnv != null) process.env.GLIMMERVOID_CONFIG = booted.prevEnv;
});

test('the board answers a session presenting its own agent token', async () => {
  const { base, token } = enabledBackend();
  const response = await post(base, 'board', {}, token);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const row = body.sessions.find((entry: { id: string }) => entry.id === SESSION_ID);
  assert.ok(row, 'the calling session is on its own board');
  assert.deepEqual(Object.keys(row).sort(), ['agent', 'ephemeral', 'id', 'name', 'state']);
});

test('a missing, wrong or hook token is refused with the unknown-session answer', async () => {
  const { base, backend } = enabledBackend();
  const hookToken = backend.getSession(SESSION_ID)?._hooks.token();
  assert.ok(hookToken);
  for (const token of [null, 'not-the-token', hookToken]) {
    const response = await post(base, 'board', {}, token);
    assert.equal(response.status, 404, String(token));
    assert.deepEqual(await response.json(), { ok: false, error: REFUSAL_REASON });
  }
});

test('an unknown session id is refused identically', async () => {
  const { base, token } = enabledBackend();
  const response = await fetch(`${base}/agent/no-such-session/board`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: REFUSAL_REASON });
});

test('an unknown verb is refused identically, so the surface cannot be probed', async () => {
  const { base, token } = enabledBackend();
  const response = await post(base, 'kill', {}, token);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: REFUSAL_REASON });
});

test('an oversize body is aborted and the server survives', async () => {
  const { base, token } = enabledBackend();
  await post(base, 'attention', `{"note":"${'x'.repeat(70 * 1024)}"}`, token)
    .then((response) => assert.notEqual(response.status, 200, 'oversize never yields 200'))
    .catch(() => {});
  const after = await post(base, 'board', {}, token);
  assert.equal(after.status, 200, 'the server is still routing after the aborted request');
});

test('a malformed request body is refused as a bad request, never as a spawn', async () => {
  const { base, token } = enabledBackend();
  const empty = await post(base, 'attention', {}, token);
  assert.equal(empty.status, 400);
  const overLong = await post(base, 'attention', { note: 'x'.repeat(501) }, token);
  assert.equal(overLong.status, 400);
  const extra = await post(base, 'spawn', { prompt: 'go', cwd: '/etc' }, token);
  assert.equal(extra.status, 400);
  const flagShaped = await post(base, 'spawn', { prompt: '--dangerously-skip-permissions' }, token);
  assert.equal(flagShaped.status, 400);
});

test('attention raises the normal waiting notification path with an agent prompt kind', async () => {
  const { base, token, backend } = enabledBackend();
  const session = backend.getSession(SESSION_ID);
  assert.ok(session);
  session.transition('user_start');
  session.transition('spawn_success', { spawnCwdExists: true });
  session.transition('first_output');
  assert.equal(session.state, 'IDLE');
  const attentionCalls: string[] = [];
  session.on('needs-attention', ({ name }: { name: string }) => { attentionCalls.push(name); });
  const response = await post(base, 'attention', { note: 'the operator must choose a base branch' }, token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pending: false });
  assert.equal(session.state, 'WAITING');
  assert.equal(session.toSnapshot().pendingPromptKind, 'agent');
  assert.deepEqual(attentionCalls, ['agent api'], 'the normal needs-attention notification fired once');
});

interface WiringFixtureOptions {
  parentSkipsPermissions?: boolean;
  spawnFails?: boolean;
  makeSessionThrowsFirst?: boolean;
  laneSessions?: Session[];
  holdSpawnGate?: boolean;
  headroomBytes?: number;
  holdFirstHeadroomRead?: boolean;
  clock?: ManualClock;
  coderWorkspaceStatus?: (workspace: string) => string | null;
  childGitWorkspace?: SessionOptions['gitWorkspace'];
  teamReviewStatus?: TeamReviewStatus;
}

interface ManualClock {
  now: () => number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
}

function manualClock() {
  let nowMs = 1_000_000;
  const tasks: { handle: TimerHandle; dueAt: number; run: () => void }[] = [];
  const clock: ManualClock = {
    now: () => nowMs,
    setTimeoutFn: (run, ms) => {
      const handle = setTimeout(() => {}, 0);
      tasks.push({ handle, dueAt: nowMs + ms, run });
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const index = tasks.findIndex((task) => task.handle === handle);
      if (index >= 0) tasks.splice(index, 1);
    },
  };
  const advanceBy = (ms: number) => {
    nowMs += ms;
    for (const task of tasks.filter(({ dueAt }) => dueAt <= nowMs)) {
      tasks.splice(tasks.indexOf(task), 1);
      task.run();
    }
  };
  return { clock, advanceBy };
}

function wiringFixture({
  parentSkipsPermissions = true, spawnFails = false, makeSessionThrowsFirst = false, laneSessions = [],
  holdSpawnGate = false, headroomBytes = 64 * 1024 * 1024 * 1024, holdFirstHeadroomRead = false,
  clock, coderWorkspaceStatus, childGitWorkspace, teamReviewStatus,
}: WiringFixtureOptions = {}) {
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, projects: [] };
  const agentSessions = new Map<string, Session>();
  const parent = new Session({
    id: 'parent',
    name: 'parent',
    path: process.cwd(),
    dangerouslySkipPermissions: parentSkipsPermissions,
    ptySpawn: () => fakePty(),
  });
  const created: Session[] = [];
  const childProjects: ProjectEntry[] = [];
  const wired: Session[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const heldGateTasks: (() => void)[] = [];
  const heldHeadroomReads: (() => void)[] = [];
  let headroomReadCount = 0;
  const memoryAdmission = createMemoryAdmission({
    readHeadroom: () => {
      headroomReadCount += 1;
      const reading = { ok: true as const, headroomBytes };
      if (!holdFirstHeadroomRead || headroomReadCount > 1) return Promise.resolve(reading);
      return new Promise((resolve) => { heldHeadroomReads.push(() => resolve(reading)); });
    },
    reserveBytesFor: (kind) => memoryReserveBytes(config, kind),
    warn: () => {},
  });
  let makeSessionCalls = 0;
  const makeSession = (project: ProjectEntry, _config: GlimmervoidConfig, overrides: Partial<SessionOptions> = {}) => {
    makeSessionCalls += 1;
    if (makeSessionThrowsFirst && makeSessionCalls === 1) throw new Error('the factory refused this child');
    childProjects.push(project);
    const child = new Session({
      id: project.id,
      name: project.name,
      path: project.path,
      dangerouslySkipPermissions: project.dangerouslySkipPermissions !== false,
      ptySpawn: () => {
        if (spawnFails) throw new Error('no terminal today');
        return fakePty();
      },
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ...(childGitWorkspace ? { gitWorkspace: childGitWorkspace } : {}),
      ...overrides,
    });
    created.push(child);
    return child;
  };
  let registeredParent: Session | null = parent;
  const registerParent = (session: Session | null) => { registeredParent = session; };
  const wiring = createAgentApiWiring({
    config,
    agentSessions,
    listAllSessions: () => [...(registeredParent ? [registeredParent] : []), ...laneSessions, ...agentSessions.values()],
    listBoardSessions: () => [parent, ...agentSessions.values()],
    makeSession,
    wireSessionEvents: (session: Session) => { wired.push(session); },
    closeSessionDataClients: () => {},
    broadcastControl: (message) => { broadcasts.push(message); },
    spawnGate: holdSpawnGate
      ? { run: (task: () => unknown) => new Promise<unknown>((resolve) => { heldGateTasks.push(() => { resolve(task()); }); }) }
      : createSpawnGate({ memoryAdmission }),
    sessionDocs: createSessionDocsWiring({ broadcastControl: (message) => { broadcasts.push(message); } }),
    memoryAdmission,
    coderWorkspaceStatus,
    ...(teamReviewStatus ? {
      operatorState: {
        requestReview: async () => ({ ok: false as const, error: 'not in this fixture' }),
        teamReviewStatus: () => teamReviewStatus,
        myPrsStatus: () => null,
        readSettings: () => ({ ok: false as const, error: 'not in this fixture' }),
      },
    } : {}),
    logger: { warn: () => {} },
    ...clock,
  });
  const releaseSpawnGate = () => {
    for (const admit of heldGateTasks.splice(0)) admit();
  };
  const untilSpawnGateHolds = async () => {
    while (heldGateTasks.length === 0) await new Promise((resolve) => setImmediate(resolve));
  };
  const releaseHeadroomRead = () => {
    for (const settle of heldHeadroomReads.splice(0)) settle();
  };
  const untilHeadroomReadHolds = async () => {
    while (heldHeadroomReads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  };
  const spawn = (session: Session, request: Record<string, unknown>) => wiring.handle(session, 'spawn', request);
  const destroyAll = () => {
    for (const session of created) session.destroy();
    parent.destroy();
  };
  return {
    wiring, config, spawn, parent, agentSessions, created, childProjects, wired, broadcasts, releaseSpawnGate, untilSpawnGateHolds, releaseHeadroomRead, untilHeadroomReadHolds, destroyAll,
    registerParent,
  };
}



test('a valid spawn creates exactly one sibling that may not spawn again', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true);
    assert.equal(fixture.agentSessions.size, 1);
    assert.equal(fixture.created.length, 1);
    const child = fixture.created[0];
    assert.equal(child.ephemeral, true);
    assert.equal(child.agentSpawnBudget().depth, 1);
    assert.deepEqual(fixture.parent.agentSpawnBudget(), {
      liveChildren: 1, lifetimeSpawns: 1, inFlight: 0, depth: 0,
    });
    const grandchild = await fixture.spawn(child, { prompt: 'go deeper' });
    assert.equal(grandchild.status, 403);
  } finally {
    fixture.destroyAll();
  }
});

test('push lands only an operator session or its spawned child, and a refusal tells the agent why', async () => {
  const fixture = wiringFixture();
  const laneSession = new Session({ id: 'review-lane-12345678', name: 'review lane', path: fixture.parent.path, ephemeral: true });
  try {
    const withoutWorktree = await fixture.wiring.handle(fixture.parent, 'push', {});
    assert.equal(withoutWorktree.status, 409);
    assert.deepEqual([withoutWorktree.body.ok, withoutWorktree.body.reason], [false, 'no-worktree']);
    assert.match(String(withoutWorktree.body.error), /no worktree of its own/);
    const fromLane = await fixture.wiring.handle(laneSession, 'push', {});
    assert.deepEqual([fromLane.status, fromLane.body.reason], [409, 'not-operator-session']);
    assert.deepEqual(describePushLanding({ merged: true, base: 'main', pushed: true }), { status: 200, body: { ok: true, landedOn: 'main', pushed: true } });
  } finally {
    laneSession.destroy();
    fixture.destroyAll();
  }
});

test('a spawn naming an unknown agent is refused rather than silently handed the default adapter', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff', agent: 'opencode-typo' });
    assert.equal(reply.status, 400);
    assert.equal(reply.body.ok, false);
    assert.match(String(reply.body.error), /unknown agent opencode-typo/);
    assert.equal(fixture.created.length, 0, 'no child process was started');
    assert.equal(fixture.agentSessions.size, 0);
    assert.deepEqual(fixture.parent.agentSpawnBudget(), {
      liveChildren: 0, lifetimeSpawns: 0, inFlight: 0, depth: 0,
    });
  } finally {
    fixture.destroyAll();
  }
});

test('a spawn while memory headroom, less what recent starts hold, is under the session reserve is refused at once with the low-memory reason', async () => {
  const lowFixture = wiringFixture({ headroomBytes: 100 * 1024 * 1024 });
  const roomForOneFixture = wiringFixture({ headroomBytes: 1000 * 1024 * 1024 });
  try {
    const reply = await lowFixture.spawn(lowFixture.parent, { prompt: 'review the diff' });
    assert.equal(reply.status, 503);
    assert.match(String(reply.body.error), /memory is low: 100 MB free, and a new session needs 600 MB/);
    assert.equal(lowFixture.created.length, 0, 'no child process was started');
    assert.deepEqual(lowFixture.parent.agentSpawnBudget(), { liveChildren: 0, lifetimeSpawns: 0, inFlight: 0, depth: 0 });

    const admitted = await roomForOneFixture.spawn(roomForOneFixture.parent, { prompt: 'review the diff' });
    assert.equal(admitted.status, 200);
    const refused = await roomForOneFixture.spawn(roomForOneFixture.parent, { prompt: 'review the tests' });
    assert.equal(refused.status, 503);
    assert.match(String(refused.body.error), /memory is low: 1000 MB free \(600 MB held for recent starts\), and a new session needs 600 MB/);
    assert.equal(roomForOneFixture.created.length, 1, 'the refused spawn started no child process');
  } finally {
    lowFixture.destroyAll();
    roomForOneFixture.destroyAll();
  }
});

test('a child runs through the same session event wiring the operator sessions get', async () => {
  const fixture = wiringFixture();
  try {
    await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    assert.deepEqual(fixture.wired.map((session) => session.id), [fixture.created[0].id]);
  } finally {
    fixture.destroyAll();
  }
});

test('a parent that does not skip permissions never hands the child a skip', async () => {
  const fixture = wiringFixture({ parentSkipsPermissions: false });
  try {
    await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    assert.equal(fixture.childProjects[0].dangerouslySkipPermissions, false);
    assert.equal(fixture.created[0].dangerouslySkipPermissions, false);
  } finally {
    fixture.destroyAll();
  }
});

test('a child the factory refuses frees the slot so the next spawn is admitted', async () => {
  const fixture = wiringFixture({ makeSessionThrowsFirst: true });
  try {
    const refused = await fixture.spawn(fixture.parent, { prompt: 'the factory says no' });
    assert.equal(refused.status, 500);
    assert.deepEqual(fixture.parent.agentSpawnBudget(), {
      liveChildren: 0, lifetimeSpawns: 1, inFlight: 0, depth: 0,
    });
    const admitted = await fixture.spawn(fixture.parent, { prompt: 'the next one works' });
    assert.equal(admitted.status, 200, 'the parent is not locked out by the failed spawn');
  } finally {
    fixture.destroyAll();
  }
});

test('a spawned child reaches the dashboard as one session-added card naming its owner', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const added = fixture.broadcasts.filter((message) => message.type === 'session-added');
    assert.equal(added.length, 1, 'the child card is announced exactly once');
    const { stateSince, ...card } = added[0];
    assert.equal(typeof stateSince, 'number');
    assert.deepEqual(card, {
      type: 'session-added',
      taskTitle: 'review the diff',
      taskTitleIsCustom: false,
      id: reply.body.sessionId,
      session: reply.body.name,
      path: fixture.parent.path,
      agent: fixture.parent.agentId,
      state: STATES.DORMANT,
      skipPerms: true,
      saneYolo: false,
      worktree: fixture.parent.isWorktree,
      resumeSessionId: null,
      ownerId: 'parent',
      ephemeral: true,
    });
    assert.equal(fixture.created[0].toSnapshot().ownerId, 'parent', 'a reconnecting dashboard learns the owner from the snapshot too');
  } finally {
    fixture.destroyAll();
  }
});

test('the child card is withheld until the spawn gate admits the start', async () => {
  const fixture = wiringFixture({ holdSpawnGate: true });
  try {
    const pending = fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    await fixture.untilSpawnGateHolds();
    assert.equal(
      fixture.broadcasts.filter((message) => message.type === 'session-added').length,
      0,
      'a queued spawn leaves no dormant card on the dashboard',
    );
    fixture.releaseSpawnGate();
    const reply = await pending;
    assert.equal(reply.status, 200);
    const added = fixture.broadcasts.filter((message) => message.type === 'session-added');
    assert.equal(added.length, 1);
    assert.equal(added[0].id, reply.body.sessionId);
  } finally {
    fixture.destroyAll();
  }
});

test('a child destroyed while the gate holds it is never carded and is still cleared from the dashboard', async () => {
  const fixture = wiringFixture({ holdSpawnGate: true });
  try {
    const pending = fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    await fixture.untilSpawnGateHolds();
    const queuedChildId = fixture.created[0].id;
    fixture.created[0].destroy();
    fixture.releaseSpawnGate();
    const reply = await pending;
    assert.equal(reply.status, 500, 'the caller is told the child never came up');
    assert.equal(
      fixture.broadcasts.filter((message) => message.type === 'session-added').length,
      0,
      'no card is announced for a child that is already gone',
    );
    assert.deepEqual(
      fixture.broadcasts.filter((message) => message.type === 'session-removed').map((message) => message.id),
      [queuedChildId],
      'the queued child is cleared once, so a snapshot that listed it does not keep a stale card',
    );
    assert.equal(fixture.agentSessions.size, 0, 'the destroyed child left the live map');
    assert.equal(fixture.parent.agentSpawnBudget().liveChildren, 0, 'the slot was released exactly once');
  } finally {
    fixture.destroyAll();
  }
});

test('a parent destroyed while its spawn reads memory headroom never gets an orphaned child', async () => {
  const fixture = wiringFixture({ holdFirstHeadroomRead: true });
  try {
    const pending = fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    await fixture.untilHeadroomReadHolds();
    fixture.parent.destroy();
    fixture.releaseHeadroomRead();
    const reply = await pending;
    assert.equal(reply.status, 409);
    assert.deepEqual([fixture.created.length, fixture.agentSessions.size], [0, 0], 'no child session was ever made');
  } finally {
    fixture.destroyAll();
  }
});

test('the shared session card projection carries exactly the session-added payload fields', () => {
  const source = {
    path: '/repo',
    state: STATES.DORMANT,
    agentId: 'codex',
    stateSince: 1700000000000,
    dangerouslySkipPermissions: true,
    isWorktree: false,
    resumeSessionId: null,
    ephemeral: true,
  };
  const ephemeralCard = projectSessionCard(source, { id: 'child-id', name: 'child name' });
  assert.deepEqual(ephemeralCard, {
    id: 'child-id',
    session: 'child name',
    taskTitle: null,
    taskTitleIsCustom: false,
    path: '/repo',
    agent: 'codex',
    state: STATES.DORMANT,
    stateSince: 1700000000000,
    skipPerms: true,
    saneYolo: false,
    worktree: false,
    resumeSessionId: null,
    ephemeral: true,
  });
  assert.equal(SessionCardFields.safeParse(ephemeralCard).success, true, 'the card satisfies the wire contract');
  const operatorCard = projectSessionCard({ ...source, ephemeral: false }, { id: 'operator-id', name: 'operator name' });
  assert.equal(operatorCard.ephemeral, false, 'an operator card carries the flag its own session owns');
  const flaglessCard = projectSessionCard({ ...source, ephemeral: undefined }, { id: 'plain-id', name: 'plain name' });
  assert.equal('ephemeral' in flaglessCard, false, 'a source without the flag leaves it off the wire');
});

test('limits tells a session which commands answer and its boundary', async () => {
  const fixture = wiringFixture({ coderWorkspaceStatus: (workspace) => (workspace === 'gv-0123456789ab' ? 'running' : null) });
  const guardedLane = new Session({
    id: 'review-lane', name: 'review', path: process.cwd(), ephemeral: true, ptySpawn: () => fakePty(),
    prepareGuardrails: async () => ({ ok: false, reason: 'never launched' }),
  });
  const remote = new Session({ id: 'remote', name: 'remote', path: process.cwd(), ptySpawn: () => fakePty() });
  fixture.config.projects.push({ id: 'remote', name: 'remote', path: process.cwd(), environment: { name: 'dev', workspace: 'gv-0123456789ab', remotePort: 45000, branch: 'main' } });
  const limitsOf = async (session: Session) => {
    const reply = await fixture.wiring.handle(session, 'limits', {});
    assert.equal(reply.status, 200);
    return AgentLimitsReply.parse(reply.body);
  };
  try {
    const operatorLimits = await limitsOf(fixture.parent);
    assert.deepEqual(operatorLimits.commands, [
      { name: 'push', answers: false, reason: 'this session has no worktree of its own, so there is nothing of its own to land' },
      ...['spawn', 'send', 'read', 'close', 'attention', 'board', 'edit', 'show', 'review', 'reviews', 'prs', 'link-pr', 'settings'].map((name) => ({ name, answers: true })),
    ]);
    assert.deepEqual([operatorLimits.boundary, operatorLimits.environment], ['none', null]);
    const laneLimits = await limitsOf(guardedLane);
    assert.deepEqual(laneLimits.commands.map(({ name, answers }) => [name, answers]), [
      ['push', false], ['spawn', false], ['send', false], ['read', false], ['close', false], ['attention', false], ['board', true], ['edit', false], ['show', false],
      ['review', false], ['reviews', false], ['prs', false], ['link-pr', false], ['settings', false],
    ]);
    const refusedCalls: [Session, AgentLimitsReply, string, Record<string, unknown>][] = [
      [fixture.parent, operatorLimits, 'push', {}],
      [guardedLane, laneLimits, 'push', {}],
      [guardedLane, laneLimits, 'spawn', { prompt: 'help me' }],
      [guardedLane, laneLimits, 'send', { words: ['hello'] }],
      [guardedLane, laneLimits, 'read', {}],
      [guardedLane, laneLimits, 'close', { child: 'anyone' }],
      [guardedLane, laneLimits, 'attention', { note: 'look' }],
      [guardedLane, laneLimits, 'edit', { path: 'notes.md' }],
      [guardedLane, laneLimits, 'review', { pr: 'acme/app#12' }],
      [guardedLane, laneLimits, 'reviews', {}],
      [guardedLane, laneLimits, 'link-pr', { pr: 'acme/app#12' }],
      [guardedLane, laneLimits, 'settings', { command: 'list' }],
    ];
    for (const [session, limits, command, payload] of refusedCalls) {
      const refusal = await fixture.wiring.handle(session, command, payload);
      assert.equal(refusal.body.error, limits.commands.find(({ name }) => name === command)?.reason, `${command} is refused for the reason limits gave`);
    }
    const remoteLimits = await limitsOf(remote);
    assert.deepEqual([remoteLimits.boundary, remoteLimits.environment], ['workspace', { name: 'dev', workspace: 'gv-0123456789ab', state: 'running' }]);
    assert.ok(formatSessionLimits(remoteLimits).includes('  environment: dev, workspace gv-0123456789ab, running'));
  } finally {
    guardedLane.destroy();
    remote.destroy();
    fixture.destroyAll();
  }
});

test('a parent and the child it spawned message each other through their own channel, and no other session can reach it', async () => {
  const fixture = wiringFixture();
  const stranger = new Session({ id: 'stranger', name: 'stranger', path: process.cwd(), ptySpawn: () => fakePty() });
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    const childId = String(spawned.body.sessionId);
    const child = fixture.created[0];
    assert.match(String(spawned.body.note), /glimmervoid read/);

    assert.equal((await fixture.wiring.handle(fixture.parent, 'send', { words: [childId, 'fix', 'the', 'HIGH', 'finding'] })).status, 200);
    assert.equal((await fixture.wiring.handle(fixture.parent, 'send', { words: [String(spawned.body.name), 'then', 'push'] })).status, 200);
    const readChannels = async (session: Session, request: Record<string, unknown>) => AgentReadReply.parse((await fixture.wiring.handle(session, 'read', request)).body).channels;
    const childRead = await readChannels(child, {});
    assert.deepEqual(childRead.map(({ sessionId, entries }) => [sessionId, entries.map(({ from, text }) => [from, text])]), [
      ['parent', [['parent', 'fix the HIGH finding'], ['parent', 'then push']]],
    ]);
    assert.deepEqual((await readChannels(child, {}))[0]?.entries, [], 'a read drains what it returned');

    assert.equal((await fixture.wiring.handle(child, 'send', { words: ['fixed', 'and', 'pushed'] })).status, 200);
    const parentRead = await readChannels(fixture.parent, { child: childId });
    assert.deepEqual(parentRead[0]?.entries.map(({ from, text }) => [from, text]), [['child', 'fixed and pushed']]);

    assert.equal((await fixture.wiring.handle(stranger, 'send', { words: [childId, 'hijack'] })).status, 404);
    assert.equal((await fixture.wiring.handle(stranger, 'read', { child: childId })).status, 404);
    assert.equal((await fixture.wiring.handle(stranger, 'close', { child: childId })).status, 404);
    assert.equal((await fixture.wiring.handle(child, 'close', { child: childId })).status, 403);
    assert.equal(fixture.agentSessions.has(childId), true, 'no refused call touched the child');

    assert.deepEqual([(await fixture.wiring.handle(fixture.parent, 'close', { child: childId })).status, fixture.agentSessions.has(childId)], [200, false]);
    assert.equal(fixture.parent.agentSpawnBudget().liveChildren, 0, 'closing a child frees its slot');
    assert.equal((await fixture.wiring.handle(fixture.parent, 'send', { words: [childId, 'still', 'there?'] })).status, 409);
  } finally {
    stranger.destroy();
    fixture.destroyAll();
  }
});

interface StubbedWorktree {
  log: string[];
  finishReap: () => void;
  worktreeDir: string;
  branch: string;
}

function stubChildWorktree(child: Session, { dirty }: { dirty: boolean }): StubbedWorktree {
  const log: string[] = [];
  const worktreeDir = `/worktrees/${child.id}`;
  const branch = `glimmervoid/session/${child.id}`;
  let carry: { worktreeDir: string; branch: string | null; base: string | null } | null = { worktreeDir, branch, base: 'main' };
  let finishReap = () => {};
  const reap = new Promise<void>((resolve) => { finishReap = () => { log.push('reaped'); resolve(); }; });
  child.getWorktreeCarry = () => carry;
  child.hasUnmergedWork = async () => dirty;
  child._awaitPendingReaps = () => reap;
  child.discardWorktree = async () => { log.push('discard'); carry = null; };
  child.discardWorktreeIfClean = async () => {
    if (dirty) return false;
    log.push('discard-if-clean');
    carry = null;
    return true;
  };
  return { log, finishReap: () => finishReap(), worktreeDir, branch };
}

async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function glimmervoidNotes(fixture: ReturnType<typeof wiringFixture>): Promise<string[]> {
  const channels = AgentReadReply.parse((await fixture.wiring.handle(fixture.parent, 'read', {})).body).channels;
  return channels.flatMap(({ entries }) => entries.filter(({ from }) => from === 'glimmervoid').map(({ text }) => text));
}

test('closing a clean child discards its worktree and deletes its guardrails temp folder only after the killed tree is reaped, and posts the closing parent no end note', async () => {
  const fixture = wiringFixture();
  const attentionNotes: string[] = [];
  fixture.parent.noteAttention = (note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    const childId = String(spawned.body.sessionId);
    const worktree = stubChildWorktree(fixture.created[0], { dirty: false });
    const childTempFolder = path.join(glimmervoidHomeDir(), 'guardrails-temp', childId);
    ensureSessionTempFolder(childId);
    fs.mkdirSync(path.join(childTempFolder, 'scratchpad'));
    assert.match(String(spawned.body.note), /--discard/);

    assert.deepEqual([(await fixture.wiring.handle(fixture.parent, 'close', { child: childId })).status, fixture.agentSessions.has(childId)], [200, false]);
    await settleTurns();
    assert.deepEqual(worktree.log, [], 'nothing is discarded while the killed tree may still hold the checkout');
    assert.equal(fs.existsSync(childTempFolder), true, 'the temp folder stays while the killed tree may still write to it');
    worktree.finishReap();
    await settleTurns();
    assert.deepEqual(worktree.log, ['reaped', 'discard-if-clean']);
    await waitFor(() => !fs.existsSync(childTempFolder), 'the temp folder is gone once the tree is reaped');
    assert.deepEqual(await glimmervoidNotes(fixture), []);
    assert.deepEqual(attentionNotes, []);
  } finally {
    fixture.destroyAll();
  }
});

test('closing a child holding unpushed work is refused until --discard, which discards it unconditionally', async () => {
  const fixture = wiringFixture();
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    const childId = String(spawned.body.sessionId);
    const worktree = stubChildWorktree(fixture.created[0], { dirty: true });

    const refused = await fixture.wiring.handle(fixture.parent, 'close', { child: childId });
    assert.equal(refused.status, 409);
    const refusalText = String(refused.body.error);
    for (const fragment of [worktree.branch, worktree.worktreeDir, 'glimmervoid push', `glimmervoid close ${childId} --discard`]) {
      assert.ok(refusalText.includes(fragment), `the refusal names ${fragment}`);
    }
    assert.equal(fixture.agentSessions.has(childId), true, 'a refused close leaves the child running');

    assert.deepEqual([(await fixture.wiring.handle(fixture.parent, 'close', { child: childId, discard: true })).status, fixture.agentSessions.has(childId)], [200, false]);
    worktree.finishReap();
    await settleTurns();
    assert.deepEqual(worktree.log, ['reaped', 'discard']);
    assert.deepEqual(await glimmervoidNotes(fixture), []);
  } finally {
    fixture.destroyAll();
  }
});

test('a parent that ends discards its clean children and keeps a dirty one, flagging the operator with its branch and path', async () => {
  const fixture = wiringFixture();
  const attentionNotes: string[] = [];
  fixture.parent.noteAttention = (note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'clean slice' });
    await fixture.spawn(fixture.parent, { prompt: 'dirty slice' });
    const clean = stubChildWorktree(fixture.created[0], { dirty: false });
    const dirty = stubChildWorktree(fixture.created[1], { dirty: true });

    fixture.parent.emit('exit', { exitCode: 0, signal: null, reason: null });
    assert.equal(fixture.agentSessions.size, 0, 'the parent ending ends its children');
    clean.finishReap();
    dirty.finishReap();
    await settleTurns();
    assert.deepEqual([clean.log, dirty.log], [['reaped', 'discard-if-clean'], ['reaped']]);
    assert.equal(attentionNotes.length, 1);
    assert.ok(attentionNotes[0]?.includes(dirty.branch) && attentionNotes[0]?.includes(dirty.worktreeDir));
    const notes = await glimmervoidNotes(fixture);
    assert.ok(notes.some((text) => text.includes(`its worktree was kept: branch ${dirty.branch} at ${dirty.worktreeDir}`)));
  } finally {
    fixture.destroyAll();
  }
});

test('a child that exits by itself holding unpushed work keeps its worktree, tells the parent and flags the operator', async () => {
  const fixture = wiringFixture();
  const attentionNotes: string[] = [];
  fixture.parent.noteAttention = (note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    const childId = String(spawned.body.sessionId);
    const child = fixture.created[0];
    const worktree = stubChildWorktree(child, { dirty: true });

    child.emit('exit', { exitCode: 0, signal: null, reason: null });
    worktree.finishReap();
    await settleTurns();
    assert.equal(fixture.agentSessions.has(childId), false);
    assert.deepEqual(worktree.log, ['reaped']);
    assert.equal(attentionNotes.length, 1);
    assert.ok((await glimmervoidNotes(fixture)).some((text) => text.includes('so its worktree was kept') && text.includes(worktree.worktreeDir)));
  } finally {
    fixture.destroyAll();
  }
});

test('a parent the operator removes takes a dirty child worktree with it, discarding it unconditionally', async () => {
  const fixture = wiringFixture();
  const attentionResults: unknown[] = [];
  const realNoteAttention = fixture.parent.noteAttention.bind(fixture.parent);
  fixture.parent.noteAttention = (note) => {
    const result = realNoteAttention(note);
    attentionResults.push(result);
    return result;
  };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'dirty slice' });
    const dirty = stubChildWorktree(fixture.created[0], { dirty: true });

    fixture.parent.destroy();
    fixture.registerParent(null);
    dirty.finishReap();
    await settleTurns();
    assert.deepEqual(dirty.log, ['reaped', 'discard']);
    assert.deepEqual(attentionResults, []);
  } finally {
    fixture.destroyAll();
  }
});

test('a parent rebuilt under the same id keeps a dirty child worktree and flags the successor with its branch and path', async () => {
  const fixture = wiringFixture();
  const originalNotes: string[] = [];
  const successorNotes: string[] = [];
  fixture.parent.noteAttention = (note) => { originalNotes.push(note); return { ok: true, pending: false }; };
  const successor = new Session({ id: fixture.parent.id, name: 'parent', path: process.cwd(), ptySpawn: () => fakePty() });
  successor.noteAttention = (note) => { successorNotes.push(note); return { ok: true, pending: false }; };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'dirty slice' });
    const dirty = stubChildWorktree(fixture.created[0], { dirty: true });

    fixture.parent.destroy();
    fixture.registerParent(successor);
    dirty.finishReap();
    await settleTurns();
    assert.deepEqual(dirty.log, ['reaped']);
    assert.deepEqual(originalNotes, []);
    assert.equal(successorNotes.length, 1);
    assert.ok(successorNotes[0]?.includes(dirty.branch) && successorNotes[0]?.includes(dirty.worktreeDir));
  } finally {
    successor.destroy();
    fixture.destroyAll();
  }
});

test('a child closed while its worktree is still being created discards that worktree once its start settles', async () => {
  const calls: string[] = [];
  let releaseCreate = () => {};
  const createHeld = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const unused = async (): Promise<never> => { throw new Error('not used by this test'); };
  const fixture = wiringFixture({
    childGitWorkspace: {
      detectDefaultBranch: async () => { calls.push('detectDefaultBranch'); return 'main'; },
      create: async () => {
        calls.push('create');
        await createHeld;
        calls.push('created');
        return { cwd: '/worktrees/held-child', isGit: true, branch: 'glimmervoid/session/held-child', base: 'main' };
      },
      populate: () => undefined,
      hasUnmergedWork: async () => true,
      discard: async () => { calls.push('discard'); },
      mergeBack: unused,
      mergeKeep: unused,
      rebaseOnly: unused,
    },
  });
  try {
    const spawning = fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    while (!calls.includes('create')) await new Promise((resolve) => setImmediate(resolve));
    const child = fixture.created[0];

    const closed = await fixture.wiring.handle(fixture.parent, 'close', { child: child.id, discard: true });
    releaseCreate();
    const spawned = await spawning;
    await settleTurns();
    assert.deepEqual([closed.status, spawned.status], [200, 500]);
    assert.deepEqual(calls, ['detectDefaultBranch', 'create', 'created', 'discard']);
    assert.equal(child.getWorktreeCarry(), null);
  } finally {
    fixture.destroyAll();
  }
});

for (const ending of [
  { how: 'operator removal', end: (child: Session) => child.destroy(), note: 'ended: closed by the operator, and its worktree was discarded' },
  { how: 'its own exit', end: (child: Session) => child.emit('exit', { exitCode: 0, signal: null, reason: null }), note: 'ended: exited by itself, and its worktree was discarded' },
]) {
  test(`a child ending by ${ending.how} wakes its parent only until the parent has read from it, and says how it ended`, async () => {
    const { clock, advanceBy } = manualClock();
    for (const hasParentRead of [true, false]) {
      const fixture = wiringFixture({ clock });
      const pasted: string[] = [];
      fixture.parent.pasteText = (text) => { pasted.push(text); return { ok: true }; };
      fixture.parent.write = () => {};
      try {
        const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the title screen' });
        const childId = String(spawned.body.sessionId);
        const child = fixture.created[0];
        const worktree = stubChildWorktree(child, { dirty: false });
        fixture.parent.transition('user_start');
        fixture.parent.transition('spawn_success', { spawnCwdExists: true });
        fixture.parent.transition('first_output');
        if (hasParentRead) {
          await fixture.wiring.handle(child, 'send', { words: ['title screen landed'] });
          advanceBy(60_000);
          await fixture.wiring.handle(fixture.parent, 'read', { child: childId });
        }
        pasted.length = 0;

        ending.end(child);
        worktree.finishReap();
        await settleTurns();
        advanceBy(60_000);
        assert.equal(pasted.length, hasParentRead ? 0 : 1, `woken at the end with hasParentRead=${hasParentRead}`);
        fixture.parent.transition('new_output');
        fixture.parent.transition('task_complete');
        assert.equal(fixture.parent.state, STATES.COMPLETE);
        advanceBy(60_000);
        if (hasParentRead) assert.equal(pasted.length, 0, 'the silent note never wakes the parent on a later turn end');
        assert.deepEqual(await glimmervoidNotes(fixture), [`${String(spawned.body.name)} ${ending.note}`]);
      } finally {
        fixture.destroyAll();
      }
    }
  });
}

test('a child that fails wakes its parent even after the parent read its report', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const pasted: string[] = [];
  fixture.parent.pasteText = (text) => { pasted.push(text); return { ok: true }; };
  fixture.parent.write = () => {};
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the title screen' });
    const childId = String(spawned.body.sessionId);
    const child = fixture.created[0];
    fixture.parent.transition('user_start');
    fixture.parent.transition('spawn_success', { spawnCwdExists: true });
    fixture.parent.transition('first_output');
    await fixture.wiring.handle(child, 'send', { words: ['title screen landed'] });
    advanceBy(60_000);
    await fixture.wiring.handle(fixture.parent, 'read', { child: childId });
    pasted.length = 0;

    child.emit('state-change', { from: STATES.RUNNING, to: STATES.DONE });
    advanceBy(60_000);
    assert.equal(pasted.length, 0, 'a clean exit after the report is silent');
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.FAILED });
    advanceBy(60_000);
    assert.equal(pasted.length, 1, 'a failure wakes');
  } finally {
    fixture.destroyAll();
  }
});

test('a spawned child that stops wakes its idle parent with one submitted line, up to the cap, then again once the operator has typed', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const pasted: string[] = [];
  const written: string[] = [];
  const attentionNotes: string[] = [];
  fixture.parent.pasteText = (text) => { pasted.push(text); return { ok: true }; };
  fixture.parent.write = (text) => { written.push(text); };
  fixture.parent.noteAttention = (note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const childId = String(spawned.body.sessionId);
    const child = fixture.created[0];
    fixture.parent.transition('user_start');
    fixture.parent.transition('spawn_success', { spawnCwdExists: true });
    fixture.parent.transition('first_output');
    assert.equal(fixture.parent.state, STATES.IDLE);
    const endChildTurn = () => {
      child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
      advanceBy(1000);
    };

    child.emit('hook-event', { event: 'Stop', payload: { last_assistant_message: 'held U2 over a HIGH finding' } });
    endChildTurn();
    assert.deepEqual(pasted, [`Glimmervoid: ${String(spawned.body.name)}, the session you spawned, has news. Run glimmervoid read ${childId} and act on it.`]);
    assert.deepEqual(written, ['\r']);
    const notes = AgentReadReply.parse((await fixture.wiring.handle(fixture.parent, 'read', {})).body).channels[0]?.entries ?? [];
    assert.deepEqual(notes.map(({ from }) => from), ['glimmervoid']);
    assert.match(notes[0]?.text ?? '', /finished a turn and is Idle\. Its last message:\nheld U2 over a HIGH finding$/);

    for (let turn = 0; turn < 10; turn += 1) endChildTurn();
    assert.deepEqual([pasted.length, written.length, attentionNotes.length], [10, 10, 1], 'the eleventh wake flags the operator instead of typing');

    fixture.parent.emit('operator-input');
    endChildTurn();
    assert.equal(pasted.length, 10, 'no wake while the operator typed in the last 30 seconds');
    advanceBy(30_000);
    advanceBy(1000);
    assert.deepEqual([pasted.length, written.length], [11, 11], 'operator input resets the cap and the held wake fires after the hold-off');

    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(50);
    fixture.parent.noteOperatorInput('r');
    advanceBy(1000);
    assert.deepEqual([pasted.length, written.length], [12, 11], 'a keystroke between the paste and the Enter leaves the wake line unsubmitted');
  } finally {
    fixture.destroyAll();
  }
});

test('a draft the operator stages at an idle parent holds off the wake so a stopping child never submits it', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const wakePastes: string[] = [];
  const written: string[] = [];
  fixture.parent.pasteText = (text) => { wakePastes.push(text); return { ok: true }; };
  fixture.parent.write = (text) => { written.push(text); };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await fixture.parent.start();
    fixture.parent.transition('first_output');
    assert.equal(fixture.parent.state, STATES.IDLE);
    assert.equal(fixture.parent.pasteTextWhenReady('half done').ok, true);
    fixture.parent.noteOperatorDraft();
    advanceBy(1000);
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    assert.match(written.join(''), /^\x1b\[200~half done/);
    assert.deepEqual([wakePastes.length, written.filter((text) => text === '\r').length], [0, 0]);
  } finally {
    fixture.destroyAll();
  }
});

test('the fourth live child is refused and a child exiting frees its slot', async () => {
  const fixture = wiringFixture();
  try {
    for (let index = 0; index < MAX_LIVE_CHILDREN; index += 1) {
      const reply = await fixture.spawn(fixture.parent, { prompt: `slice ${index}` });
      assert.equal(reply.status, 200, `child ${index}`);
    }
    const refused = await fixture.spawn(fixture.parent, { prompt: 'one too many' });
    assert.equal(refused.status, 429);
    assert.equal(fixture.created.length, MAX_LIVE_CHILDREN);

    fixture.created[0].emit('exit');
    assert.equal(fixture.parent.agentSpawnBudget().liveChildren, MAX_LIVE_CHILDREN - 1);
    const admitted = await fixture.spawn(fixture.parent, { prompt: 'refilling the slot' });
    assert.equal(admitted.status, 200);
    assert.equal(fixture.parent.agentSpawnBudget().lifetimeSpawns, MAX_LIVE_CHILDREN + 1);
  } finally {
    fixture.destroyAll();
  }
});

test('branch GC reads a live child id back out of the branch git-workspace names for it', { skip: !GIT }, async () => {
  const fixture = wiringFixture();
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agent-branch-'));
  const worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agent-worktree-'));
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const childId = String(reply.body.sessionId);
    try { git(['init', '-b', 'main'], projectPath); } catch { git(['init'], projectPath); }
    git(['config', 'user.email', 'test@example.com'], projectPath);
    git(['config', 'user.name', 'Glimmervoid Test'], projectPath);
    git(['config', 'commit.gpgsign', 'false'], projectPath);
    fs.writeFileSync(path.join(projectPath, 'message.txt'), 'base\n', 'utf8');
    git(['add', '-A'], projectPath);
    git(['commit', '-m', 'initial'], projectPath);

    const workspace = createGitWorkspace();
    const handle = await workspace.create({ owner: 'lane:test', projectPath, teamId: 'session', label: childId, worktreeBase });
    assert.ok(handle.branch, handle.reason || handle.error || 'the worktree carries a branch');
    assert.equal(sessionIdFromBranch(handle.branch), childId, 'the live child id survives the branch name');
  } finally {
    fixture.destroyAll();
    fs.rmSync(worktreeBase, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

interface SnapshotFrame {
  type: string;
  sessions?: { id: string }[];
}

test('removing a spawned child from the dashboard destroys it and clears its card exactly once', async () => {
  const fixture = wiringFixture();
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const childId = String(spawned.body.sessionId);
    const server = createControlServer(controlDeps({ ...DEFAULT_CONFIG, projects: [] }, {
      agentSessions: fixture.agentSessions,
      broadcastControl: (message) => { fixture.broadcasts.push(message); },
    }));
    const connection = connectControl<SnapshotFrame>(server);
    await connection.send({ type: 'remove-session', id: childId });
    assert.equal(fixture.agentSessions.size, 0, 'the child is gone from the live map');
    assert.equal(fixture.created[0]._destroyed, true, 'the child process was torn down');
    assert.deepEqual(
      fixture.broadcasts.filter((message) => message.type === 'session-removed'),
      [{ type: 'session-removed', id: childId, session: spawned.body.name }],
    );
  } finally {
    fixture.destroyAll();
  }
});

test('renaming a spawned child is refused and writes no config', () => {
  const child = new Session({
    id: 'agent-spawn-renamable', name: 'parent agent', path: '/repo', ephemeral: true, ptySpawn: () => fakePty(),
  });
  const agentSessions = new Map<string, Session>([[child.id, child]]);
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, projects: [] };
  let saveCount = 0;
  try {
    const server = createControlServer(controlDeps(config, {
      agentSessions,
      configStore: testConfigStore(config, { onSave: () => { saveCount += 1; } }),
    }));
    const connection = connectControl<{ type: string; message?: string }>(server);
    connection.send({ type: 'rename-session', id: child.id, newName: 'operator chosen name' });
    assert.equal(saveCount, 0, 'no config write for a session that is not in cfg.projects');
    assert.equal(child.name, 'parent agent');
    assert.equal(connection.sent.filter((frame) => frame.type === 'error').length, 1, 'the dashboard is told why');
  } finally {
    child.destroy();
  }
});

test('a live agent child is on the control snapshot and a kill reaches it', () => {
  const child = plainSession('agent-spawn-child', 'parent agent');
  const killed: string[] = [];
  child.killSession = () => { killed.push(child.id); return true; };
  const agentSessions = new Map<string, Session>([[child.id, child]]);
  try {
    const server = createControlServer(controlDeps({ projects: [] }, { agentSessions }));
    const connection = connectControl<SnapshotFrame>(server);
    const snapshot = connection.sent.find((frame) => frame.type === 'snapshot');
    assert.ok(snapshot, 'the dashboard gets a snapshot on connect');
    assert.deepEqual(snapshot.sessions?.map((row) => row.id), [child.id]);
    connection.send({ type: 'kill', id: child.id });
    assert.deepEqual(killed, [child.id], 'the kill reached the spawned sibling');
  } finally {
    child.destroy();
  }
});

test('a start-session for an agent child is refused so it cannot race the spawn gate', () => {
  const child = plainSession('agent-spawn-tapped', 'parent agent');
  let startAttempts = 0;
  child.start = () => { startAttempts += 1; return Promise.resolve(); };
  const agentSessions = new Map<string, Session>([[child.id, child]]);
  try {
    const server = createControlServer(controlDeps({ projects: [] }, { agentSessions }));
    const connection = connectControl<{ type: string; message?: string }>(server);
    connection.send({ type: 'start-session', id: child.id });
    assert.equal(startAttempts, 0, 'the dashboard tap never starts a child its parent owns');
    assert.equal(connection.sent.filter((frame) => frame.type === 'error').length, 1, 'the dashboard is told why');
  } finally {
    child.destroy();
  }
});

function notificationWiring(triggered: { category: string; message: string }[]) {
  return createSessionEventWiring({
    configStore: { save: () => null },
    config: { projects: [] },
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: {
      acknowledge: () => {},
      trigger: (_id, category, message) => { triggered.push({ category, message }); },
      noteOperatorActivity: () => {},
    },
    attachSessionPrLink: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
}

test('an attention note sent while the session is still STARTING is held, then fires once it reaches IDLE', async () => {
  const session = plainSession('attention-starting-session', 'booting lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  const fixture = wiringFixture();
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    assert.equal(session.state, STATES.STARTING);
    const reply = await fixture.wiring.handle(session, 'attention', { note: 'pick a base branch before I rebase' });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { ok: true, pending: true });
    assert.equal(session.state, STATES.STARTING, 'a held note never moves a session the machine table cannot move');
    assert.deepEqual(triggered, [], 'nothing is notified while the note is held');
    session.transition('first_output');
    assert.equal(session.state, STATES.WAITING, 'the held note fires as soon as the session can accept it');
    assert.equal(session.toSnapshot().pendingPromptKind, 'agent');
    assert.deepEqual(triggered, [{
      category: 'waiting',
      message: 'booting lane: pick a base branch before I rebase',
    }], 'the operator is notified exactly once');
  } finally {
    fixture.destroyAll();
    session.destroy();
  }
});

test('two notes held during startup reach the operator in one notification, in order', () => {
  const session = plainSession('attention-queue-notify-session', 'queued notify lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    assert.deepEqual(session.noteAttention('pick a base branch'), { ok: true, pending: true });
    assert.deepEqual(session.noteAttention('then confirm the force push'), { ok: true, pending: true });
    assert.deepEqual(triggered, [], 'nothing is notified while the notes are held');
    session.transition('first_output');
    assert.deepEqual(triggered, [{
      category: 'waiting',
      message: 'queued notify lane: pick a base branch | then confirm the force push',
    }], 'the single notification carries every held note');
  } finally {
    session.destroy();
  }
});

test('a note raised while the session already waits folds into the next notification, without the delivered one', async () => {
  const session = plainSession('attention-fold-session', 'folding lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    assert.deepEqual(session.noteAttention('pick a base branch'), { ok: true, pending: false });
    assert.equal(session.state, STATES.WAITING);
    assert.deepEqual(session.noteAttention('then confirm the force push'), { ok: true, pending: false });
    session.transition('user_dismiss');
    await setTimeoutPromise(600);
    assert.deepEqual(session.noteAttention('and pick a reviewer'), { ok: true, pending: false });
    assert.equal(session.state, STATES.WAITING);
    assert.deepEqual(triggered.map((entry) => entry.message), [
      'folding lane: pick a base branch',
      'folding lane: then confirm the force push | and pick a reviewer',
    ], 'the undelivered note is folded in and the delivered one is not repeated');
  } finally {
    session.destroy();
  }
});

test('a sixth held note is refused rather than silently dropping an earlier one', async () => {
  const session = plainSession('attention-queue-full-session', 'crowded lane');
  const raised: string[] = [];
  const fixture = wiringFixture();
  try {
    session.on('agent-attention', ({ note }: { note: string }) => { raised.push(note); });
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    for (let index = 0; index < 5; index += 1) {
      assert.deepEqual(session.noteAttention(`note ${index}`), { ok: true, pending: true });
    }
    const refused = await fixture.wiring.handle(session, 'attention', { note: 'note 5' });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.ok, false);
    assert.match(String(refused.body.error), /5 attention notes/);
    session.transition('first_output');
    assert.deepEqual(raised, ['note 0 | note 1 | note 2 | note 3 | note 4'], 'the refused note is the one that never reaches the operator');
  } finally {
    fixture.destroyAll();
    session.destroy();
  }
});

test('a held attention note is dropped when the session exits before it can fire', async () => {
  const session = plainSession('attention-exit-session', 'dying lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    assert.deepEqual(session.noteAttention('pick a base branch before I rebase'), { ok: true, pending: true });
    await session._handlePtyExit(1, null);
    session.transition('user_restart');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    assert.equal(session.state, STATES.IDLE, 'a restarted session is not bounced into WAITING by a dead note');
    assert.deepEqual(triggered.filter((entry) => entry.category === 'waiting'), []);
  } finally {
    session.destroy();
  }
});

test('reviews with a pull request hands a session the whole Reviews tab draft, or the state of a review still on its way', async () => {
  const head = 'a'.repeat(40);
  const identity = (number: number) => ({ key: `acme/app#${number}`, repo: 'acme/app', number, title: `Change ${number}`, url: `https://github.com/acme/app/pull/${number}`, author: 'teammate' });
  const teamReviewStatus = TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null,
    drafts: [{
      ...identity(12), tier: 'full', reasons: ['big'], reviewedHead: head, verdict: 'REQUEST CHANGES', summary: 'null deref', body: 'Fix it.', status: 'ready',
      assessment: { goal: 'g', change: 'c', checked: ['ran it'], gaps: ['no test'], handChecks: [] },
      comments: [{ path: 'src/app.ts', line: 3, side: 'RIGHT', body: 'this is null on a cold start', severity: 'HIGH', excerpt: [{ line: 3, kind: 'add', text: '+ start()' }] }],
    }],
    inFlight: [{ ...identity(13), tier: 'stamp', reasons: [], head, phase: 'checkout', startedAt: 1, deadlineAt: null, toolCalls: 0, recentSteps: [] }],
    queued: [identity(14)],
  });
  const fixture = wiringFixture({ teamReviewStatus });
  try {
    const reviewOf = (pr?: string) => fixture.wiring.handle(fixture.parent, 'reviews', pr === undefined ? {} : { pr });
    const listed = await reviewOf();
    assert.deepEqual(AgentReviewsReply.parse(listed.body).drafts.map(({ key }) => key), ['acme/app#12']);

    const drafted = await reviewOf('https://github.com/acme/app/pull/12');
    assert.equal(drafted.status, 200);
    const detail = AgentReviewDetailReply.parse(drafted.body);
    assert.equal(detail.state, 'drafted');
    assert.deepEqual(detail.draft, teamReviewStatus.drafts[0]);
    assert.match(detail.note ?? '', /untrusted pull request/);

    assert.deepEqual(AgentReviewDetailReply.parse((await reviewOf('acme/app#13')).body), { ok: true, key: 'acme/app#13', state: 'reviewing', phase: 'checkout', note: null, draft: null });
    assert.deepEqual(AgentReviewDetailReply.parse((await reviewOf('Acme/App#14')).body), { ok: true, key: 'acme/app#14', state: 'queued', phase: null, note: null, draft: null });

    const missing = await reviewOf('acme/app#99');
    assert.equal(missing.status, 404);
    assert.match(String(missing.body.error), /glimmervoid review acme\/app#99/);
    assert.equal((await reviewOf('not a pull request')).status, 400);
  } finally {
    fixture.destroyAll();
  }
});

test('a reply that breaks its verb contract reaches the session as a 500 and never as the unchecked body', async () => {
  const valid = TeamReviewStatus.parse({
    type: 'team-review-status', ts: 1, configured: true, reason: null, inFlight: [], queued: [],
    drafts: [{
      key: 'acme/app#12', repo: 'acme/app', number: 12, title: 'Change', url: 'https://github.com/acme/app/pull/12', author: 'teammate',
      tier: 'stamp', reasons: [], reviewedHead: 'a'.repeat(40), verdict: 'APPROVE', summary: 's', body: 'b', comments: [], status: 'ready',
    }],
  });
  const teamReviewStatus: TeamReviewStatus = { ...valid, drafts: valid.drafts.map((draft) => ({ ...draft, reviewedHead: 'not a commit' })) };
  const fixture = wiringFixture({ teamReviewStatus });
  try {
    const reply = await fixture.wiring.handle(fixture.parent, 'reviews', { pr: 'acme/app#12' });
    assert.deepEqual(reply, { status: 500, body: { ok: false, error: 'glimmervoid built a reviews reply that breaks its contract' } });
  } finally {
    fixture.destroyAll();
  }
});
