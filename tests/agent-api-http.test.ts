import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { sessionIdFromBranch } from '../server/core/branch-gc-core.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { MAX_LIVE_CHILDREN, REFUSAL_REASON } from '../server/core/agent-api-core.ts';
import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { SessionCardFields } from '../shared/contracts/index.ts';
import { createConfigStore, DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { STATES } from '../shared/states.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { plainSession } from './helpers/fake-session.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { hasGit, git } from './helpers/git-fixture.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'agent-api-session';
const GIT = hasGit();

interface BootedBackend {
  tmpDir: string;
  server: Server;
  backend: Backend;
  base: string;
  token: string;
}

const booted: { enabled: BootedBackend | null; disabled: BootedBackend | null; prevEnv: string | undefined } = {
  enabled: null,
  disabled: null,
  prevEnv: undefined,
};

function enabledBackend(): BootedBackend {
  if (!booted.enabled) throw new Error('the enabled backend was never booted');
  return booted.enabled;
}

function disabledBackend(): BootedBackend {
  if (!booted.disabled) throw new Error('the disabled backend was never booted');
  return booted.disabled;
}

async function boot(prefix: string, agentApiEnabled: boolean): Promise<BootedBackend> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'agent api', path: projectDir }],
    repoRoots: [],
    millEnabled: false,
    autoResume: false,
    agentApi: { enabled: agentApiEnabled },
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
  context.backend.shutdown();
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
  booted.enabled = await boot('glimmervoid-agentapi-on-', true);
  booted.disabled = await boot('glimmervoid-agentapi-off-', false);
});

test.after(async () => {
  await teardown(booted.enabled);
  await teardown(booted.disabled);
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

test('with agentApi off the ingress is inert even for the right token', async () => {
  const { base, token } = disabledBackend();
  const response = await post(base, 'board', {}, token);
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
}

function wiringFixture({
  parentSkipsPermissions = true, spawnFails = false, makeSessionThrowsFirst = false, laneSessions = [],
  holdSpawnGate = false,
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
      ...overrides,
    });
    created.push(child);
    return child;
  };
  const wiring = createAgentApiWiring({
    config,
    agentSessions,
    listAllSessions: () => [parent, ...laneSessions, ...agentSessions.values()],
    listBoardSessions: () => [parent, ...agentSessions.values()],
    makeSession,
    wireSessionEvents: (session: Session) => { wired.push(session); },
    closeSessionDataClients: () => {},
    broadcastControl: (message) => { broadcasts.push(message); },
    spawnGate: {
      run: (task: () => unknown) => (holdSpawnGate
        ? new Promise<unknown>((resolve) => { heldGateTasks.push(() => { resolve(task()); }); })
        : Promise.resolve(task())),
    },
    logger: { warn: () => {} },
  });
  const releaseSpawnGate = () => {
    for (const admit of heldGateTasks.splice(0)) admit();
  };
  const spawn = (session: Session, request: Record<string, unknown>) => wiring.handle(session, 'spawn', request);
  const destroyAll = () => {
    for (const session of created) session.destroy();
    parent.destroy();
  };
  return {
    wiring, spawn, parent, agentSessions, created, childProjects, wired, broadcasts, releaseSpawnGate, destroyAll,
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

test('a parent that skips permissions passes that same setting down', async () => {
  const fixture = wiringFixture({ parentSkipsPermissions: true });
  try {
    await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    assert.equal(fixture.childProjects[0].dangerouslySkipPermissions, true);
    assert.equal(fixture.created[0].dangerouslySkipPermissions, true);
  } finally {
    fixture.destroyAll();
  }
});

test('a child that never reaches a terminal is refused, dropped and frees its slot', async () => {
  const fixture = wiringFixture({ spawnFails: true });
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    assert.equal(reply.status, 500);
    assert.equal(reply.body.ok, false);
    assert.equal(fixture.agentSessions.size, 0, 'the dead child is not left in the map');
    assert.deepEqual(fixture.parent.agentSpawnBudget(), {
      liveChildren: 0, lifetimeSpawns: 1, inFlight: 0, depth: 0,
    });
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

test('the board carries the operator sessions only, never an internal lane session', async () => {
  const lane = plainSession('pr-review-lane', 'pr review');
  const fixture = wiringFixture({ laneSessions: [lane] });
  try {
    await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const reply = await fixture.wiring.handle(fixture.parent, 'board', {});
    const rows = reply.body.sessions as { id: string }[];
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      [fixture.created[0].id, 'parent'].sort(),
    );
  } finally {
    fixture.destroyAll();
    lane.destroy();
  }
});

test('a spawned child reaches the dashboard as one session-added card', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const added = fixture.broadcasts.filter((message) => message.type === 'session-added');
    assert.equal(added.length, 1, 'the child card is announced exactly once');
    const { stateSince, ...card } = added[0];
    assert.equal(typeof stateSince, 'number');
    assert.deepEqual(card, {
      type: 'session-added',
      id: reply.body.sessionId,
      session: reply.body.name,
      path: fixture.parent.path,
      state: STATES.DORMANT,
      skipPerms: true,
      worktree: fixture.parent.isWorktree,
      resumeSessionId: null,
      ephemeral: true,
    });
  } finally {
    fixture.destroyAll();
  }
});

test('the child card is withheld until the spawn gate admits the start', async () => {
  const fixture = wiringFixture({ holdSpawnGate: true });
  try {
    const pending = fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    await Promise.resolve();
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
    await Promise.resolve();
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

test('the shared session card projection carries exactly the session-added payload fields', () => {
  const source = {
    path: '/repo',
    state: STATES.DORMANT,
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
    path: '/repo',
    state: STATES.DORMANT,
    stateSince: 1700000000000,
    skipPerms: true,
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

test('a child exiting tells the dashboard its card is gone', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    fixture.created[0].emit('exit');
    assert.deepEqual(fixture.broadcasts.filter((message) => message.type === 'session-removed'), [
      { type: 'session-removed', id: reply.body.sessionId, session: reply.body.name },
    ]);
  } finally {
    fixture.destroyAll();
  }
});

test('a second spawn while one is in flight is refused', async () => {
  const fixture = wiringFixture();
  try {
    const first = fixture.spawn(fixture.parent, { prompt: 'one' });
    const second = await fixture.spawn(fixture.parent, { prompt: 'two' });
    assert.equal(second.status, 429);
    assert.equal((await first).status, 200);
    assert.equal(fixture.parent.agentSpawnBudget().inFlight, 0, 'the in-flight counter drains');
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
    const handle = await workspace.create({ projectPath, teamId: 'session', label: childId, worktreeBase });
    assert.ok(handle.branch, handle.reason || handle.error || 'the worktree carries a branch');
    assert.equal(sessionIdFromBranch(handle.branch), childId, 'the live child id survives the branch name');
  } finally {
    fixture.destroyAll();
    fs.rmSync(worktreeBase, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('sibling names never collide', async () => {
  const fixture = wiringFixture();
  try {
    const first = await fixture.spawn(fixture.parent, { prompt: 'one' });
    const second = await fixture.spawn(fixture.parent, { prompt: 'two' });
    assert.notEqual(first.body.name, second.body.name);
  } finally {
    fixture.destroyAll();
  }
});

test('a config edit that turns agentApi off switches the endpoint off', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agentapi-toggle-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], agentApi: { enabled: true } }), 'utf8');
  const previous = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = cfgPath;
  try {
    const configStore = createConfigStore();
    const wiring = createAgentApiWiring({
      config: configStore.config,
      agentSessions: new Map(),
      listAllSessions: () => [],
      listBoardSessions: () => [],
      makeSession: () => { throw new Error('the toggle test never spawns'); },
      wireSessionEvents: () => {},
      closeSessionDataClients: () => {},
      broadcastControl: () => {},
      spawnGate: { run: (task: () => unknown) => Promise.resolve(task()) },
    });
    assert.equal(wiring.enabled(), true);
    configStore.applySettings({ ...configStore.config, agentApi: { enabled: false } });
    assert.equal(wiring.enabled(), false, 'the watcher reload reaches the endpoint');
  } finally {
    if (previous == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previous != null) process.env.GLIMMERVOID_CONFIG = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    connection.send({ type: 'remove-session', id: childId });
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

test('removing a child through the dashboard frees the parent slot for the next spawn', async () => {
  const fixture = wiringFixture();
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'review the diff' });
    const childId = String(spawned.body.sessionId);
    const server = createControlServer(controlDeps({ ...DEFAULT_CONFIG, projects: [] }, {
      agentSessions: fixture.agentSessions,
    }));
    const connection = connectControl<SnapshotFrame>(server);
    connection.send({ type: 'remove-session', id: childId });
    assert.equal(fixture.created[0]._destroyed, true, 'the remove path tore the child down');
    assert.equal(fixture.parent.agentSpawnBudget().liveChildren, 0, 'the destroyed child released its slot');
    const admitted = await fixture.spawn(fixture.parent, { prompt: 'the next slice' });
    assert.equal(admitted.status, 200, 'the parent is not pinned by a child it never saw exit');
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
    },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
}

test('the attention note becomes the notification body the operator reads', () => {
  const session = plainSession('attention-note-session', 'worktree lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    assert.equal(session.state, STATES.IDLE);
    assert.deepEqual(session.noteAttention('pick a base branch before I rebase'), { ok: true, pending: false });
    assert.equal(session.state, STATES.WAITING);
    assert.deepEqual(triggered, [{
      category: 'waiting',
      message: 'worktree lane: pick a base branch before I rebase',
    }]);
  } finally {
    session.destroy();
  }
});

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

test('two notes held during startup release as one raise carrying both, in the order they arrived', () => {
  const session = plainSession('attention-queue-session', 'queued lane');
  const raised: string[] = [];
  try {
    session.on('agent-attention', ({ note }: { note: string }) => { raised.push(note); });
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    assert.deepEqual(session.noteAttention('pick a base branch'), { ok: true, pending: true });
    assert.deepEqual(session.noteAttention('then confirm the force push'), { ok: true, pending: true });
    assert.deepEqual(raised, [], 'neither note fires while the session cannot accept one');
    session.transition('first_output');
    assert.deepEqual(raised, ['pick a base branch | then confirm the force push']);
    assert.equal(session.state, STATES.WAITING);
  } finally {
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

test('a note held at exit cannot bounce a session restarted before the exit settles', async () => {
  const session = plainSession('attention-exit-race-session', 'racing lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    assert.deepEqual(session.noteAttention('pick a base branch before I rebase'), { ok: true, pending: true });
    const exiting = session._handlePtyExit(1, null);
    session.transition('user_restart');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    await exiting;
    assert.equal(session.state, STATES.IDLE, 'the restart outruns the exit settle and still sees no dead note');
    assert.deepEqual(triggered.filter((entry) => entry.category === 'waiting'), []);
  } finally {
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
