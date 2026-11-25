import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchPlanFor } from '../shared/agent-models-core.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend/backend.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { stableLauncherPath } from '../server/runtime-paths.ts';
import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { createFileClaims } from '../server/file-claims.ts';
import { AgentClaimReply } from '../shared/contracts/file-claims.ts';
import type { AgentApiWiringOptions } from '../server/agent-api/agent-api-context.ts';
import { createRaceLauncher } from '../server/race/race-launch.ts';
import { createWargamesLauncher } from '../server/wargames/wargames-launch.ts';
import { createReviewWiring } from '../server/review/review-wiring.ts';
import { RaceRecord } from '../shared/contracts/race.ts';
import type { RaceSpec } from '../shared/contracts/race.ts';
import { WARGAMES_SEAT_IDS, WargamesMatchSummary } from '../shared/contracts/wargames.ts';
import type { WargamesMatchSpec } from '../shared/contracts/wargames.ts';
import { ensureSessionTempFolder } from '../server/session-temp/session-temp.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../server/spawn-gate.ts';
import { memoryReserveBytes } from '../server/core/memory-admission-core.ts';
import { sessionIdFromBranch } from '../server/core/branch-gc-core.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { describePushLanding, REFUSAL_REASON } from '../server/core/agent-api-core.ts';
import { SPAWNED_SESSIONS_DEFAULT } from '../shared/settings-ranges.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV, AgentLimitsReply, AgentReadReply, AgentReviewDetailReply, AgentReviewsReply } from '../shared/contracts/session.ts';
import { AgentWakeReply } from '../shared/contracts/wakes.ts';
import { TeamReviewStatus } from '../shared/contracts/team-review.ts';
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
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { agentIngressBase, settleBackendShutdown } from './helpers/lanes.ts';
import { waitFor } from './helpers/wait-for.ts';
import { SUBMIT_DELAY_MS } from '../session/core/input-delivery-core.ts';
import { WAKE_TURN_START_TIMEOUT_MS } from '../server/core/child-channel-core.ts';

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
    secrets: { byProject: { [projectDir]: { RUN_TOKEN: { isAllowed: true }, UNWRITTEN_TOKEN: { isAllowed: true }, DENIED_TOKEN: { isAllowed: false } } } },
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

  return { tmpDir, server, backend, base: await agentIngressBase(backend), token };
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

test('secrets run hands the command only the allowed values in the env file, and exits with its code', async () => {
  const { base, token, tmpDir } = enabledBackend();
  const projectDir = path.join(tmpDir, 'project');
  fs.writeFileSync(path.join(projectDir, '.env.local'), 'RUN_TOKEN=run-value\nDENIED_TOKEN=denied-value\nUNLISTED_TOKEN=unlisted-value\n', 'utf8');
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  process.env[AGENT_URL_ENV] = `${base}/agent/${SESSION_ID}?t=${token}`;
  const seenPath = path.join(tmpDir, 'seen.json');
  const reportEnvironment = `require('node:fs').writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify([process.env.RUN_TOKEN, process.env.DENIED_TOKEN, process.env.UNLISTED_TOKEN, process.env.UNWRITTEN_TOKEN])); process.exit(7)`;
  try {
    assert.equal(await runAgentApiCli(['secrets', 'run', '--', stableLauncherPath(), '-e', reportEnvironment]), 7);
    assert.deepEqual(JSON.parse(fs.readFileSync(seenPath, 'utf8')), ['run-value', null, null, null]);
    const reply = await post(base, 'secrets', {}, token);
    assert.deepEqual(await reply.json(), { ok: true, valuesByName: { RUN_TOKEN: 'run-value' }, missingNames: ['UNWRITTEN_TOKEN'] });
  } finally {
    if (previousAgentUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousAgentUrl !== undefined) process.env[AGENT_URL_ENV] = previousAgentUrl;
    fs.rmSync(path.join(projectDir, '.env.local'), { force: true });
  }
});

test('one Ctrl-C to the terminal reaches a command under secrets run once, so it can stop cleanly', { skip: process.platform === 'win32' }, async () => {
  const { base, token } = enabledBackend();
  const countInterrupts = "let interrupts = 0; process.on('SIGINT', () => { interrupts += 1; if (interrupts > 1) process.exit(130); setTimeout(() => process.exit(0), 300); }); console.log('ready'); setInterval(() => {}, 1000);";
  const wrapper = spawn(stableLauncherPath(), [path.join(import.meta.dirname, '..', 'bin', 'glimmervoid.ts'), 'secrets', 'run', '--', stableLauncherPath(), '-e', countInterrupts], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, [AGENT_URL_ENV]: `${base}/agent/${SESSION_ID}?t=${token}` },
  });
  const [readyChunk] = await once(wrapper.stdout, 'data');
  assert.match(String(readyChunk), /ready/);
  assert.ok(wrapper.pid);
  process.kill(-wrapper.pid, 'SIGINT');
  const [exitCode] = await once(wrapper, 'exit');
  assert.equal(exitCode, 0, 'the command got one SIGINT and exited on its own');
});

test('the board answers a session presenting its own agent token', async () => {
  const { base, token } = enabledBackend();
  const response = await post(base, 'sessions', {}, token);
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
    const response = await post(base, 'sessions', {}, token);
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
  const after = await post(base, 'sessions', {}, token);
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
  childGitWorkspace?: SessionOptions['gitWorkspace'];
  teamReviewStatus?: TeamReviewStatus;
  arena?: Pick<AgentApiWiringOptions, 'races' | 'startRace'>;
  wargames?: Pick<AgentApiWiringOptions, 'wargames' | 'startWargames'>;
  reviewComments?: AgentApiWiringOptions['reviewComments'];
  parentIsStudioMain?: boolean;
  budgetHoldReason?: () => string | null;
}

interface ManualClock {
  now: () => number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
}

function settleDeliveriesOnClock(session: Session, clock: ManualClock, onPaste: (text: string) => void): void {
  session.deliver = (text, { submit, onSettled }) => {
    onPaste(text);
    let hasOperatorTyped = false;
    const noteOperatorTyping = () => { hasOperatorTyped = true; };
    session.once('operator-input', noteOperatorTyping);
    clock.setTimeoutFn(() => {
      session.off('operator-input', noteOperatorTyping);
      if (!submit || hasOperatorTyped) {
        onSettled?.(submit ? 'withheld' : 'pasted');
        return;
      }
      session.write('\r');
      onSettled?.('submitted');
    }, SUBMIT_DELAY_MS);
    return { ok: true, kind: 'pasted' };
  };
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
  clock, childGitWorkspace, teamReviewStatus, arena, wargames, reviewComments, parentIsStudioMain = false, budgetHoldReason = () => null,
}: WiringFixtureOptions = {}) {
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, projects: [] };
  const agentSessions = new Map<string, Session>();
  const parent = new Session({
    id: 'parent',
    name: 'parent',
    path: process.cwd(),
    dangerouslySkipPermissions: parentSkipsPermissions,
    isStudioMain: parentIsStudioMain,
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
    fileClaims: createFileClaims({ findLiveSession: (sessionId) => [parent, ...agentSessions.values()].find((session) => session.id === sessionId) ?? null }),
    ...(teamReviewStatus ? {
      operatorState: {
        requestReview: async () => ({ ok: false as const, error: 'not in this fixture' }),
        teamReviewStatus: () => teamReviewStatus,
        myPrsStatus: () => null,
        readSettings: () => ({ ok: false as const, error: 'not in this fixture' }),
        readPacks: async () => ({ text: 'not in this fixture', hasProblem: true }),
        previewPackPage: async () => ({ ok: false as const, error: 'not in this fixture' }),
      },
    } : {}),
    ...arena,
    ...wargames,
    reviewComments,
    budgetHoldReason,
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

test('the Studio Orchestrator starts no agent child: its spawn needs a repo and a box, and a session outside Studio may name neither', async () => {
  const fixture = wiringFixture({ parentIsStudioMain: true });
  const focusFixture = wiringFixture();
  try {
    const unplaced = await fixture.spawn(fixture.parent, { prompt: 'fix the api' });
    assert.equal(unplaced.status, 400);
    const placed = await fixture.spawn(fixture.parent, { prompt: 'fix the api', repo: 'api', about: 'server' });
    assert.equal(placed.status, 503, 'with no branch wiring the placed spawn is refused, never run as an agent child');
    assert.equal(fixture.created.length, 0);
    const fromFocus = await focusFixture.spawn(focusFixture.parent, { prompt: 'fix the api', repo: 'api', about: 'server' });
    assert.equal(fromFocus.status, 400);
    assert.equal(focusFixture.created.length, 0);
  } finally {
    fixture.destroyAll();
    focusFixture.destroyAll();
  }
});

test('a spawn naming a model and effort launches the child on them, and a command-line-unsafe model is refused', async () => {
  const fixture = wiringFixture();
  try {
    const reply = await fixture.spawn(fixture.parent, { prompt: 'plan the change', agent: 'claude-code', model: 'opus', effort: 'high' });
    assert.equal(reply.status, 200);
    assert.deepEqual(fixture.childProjects[0].agentSetup, { agent: 'claude-code', model: 'opus', options: [{ id: 'effort', value: 'high' }], instructions: '' });
    assert.ok(launchPlanFor('claude-code', fixture.childProjects[0].agentSetup ?? null, process.platform).args.includes('opus'));
    const unsafe = await fixture.spawn(fixture.parent, { prompt: 'x', model: 'opus --dangerously-skip-permissions' });
    assert.equal(unsafe.status, 400);
    assert.equal(fixture.childProjects.length, 1);
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
    assert.deepEqual(describePushLanding({ merged: true, base: 'main', pushed: false, warning: 'Merged into main, but origin refused the push (fatal: could not read Username), so origin/main does not have it yet.' }).body, { ok: true, landedOn: 'main', pushed: false, note: 'landed locally and nothing was pushed: Merged into main, but origin refused the push (fatal: could not read Username), so origin/main does not have it yet.' });
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
      workingDirectory: fixture.parent.path,
      agent: fixture.parent.agentId,
      agentDrawsAlternateScreen: true,
      state: STATES.DORMANT,
      skipPerms: true,
      saneYolo: false,
      worktree: fixture.parent.isWorktree,
      resumeSessionId: null,
      parent: { sessionId: 'parent', box: null },
      attentionOwner: 'parent',
      ephemeral: true,
    });
    assert.deepEqual(fixture.created[0].toSnapshot().parent, { sessionId: 'parent', box: null }, 'a reconnecting dashboard learns the owner from the snapshot too');
    assert.equal(fixture.created[0].toSnapshot().attentionOwner, 'parent', 'a reconnecting dashboard learns the parent attends the child');
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
    agentDrawsAlternateScreen: true,
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
    agentDrawsAlternateScreen: true,
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
  const pickedModelCard = projectSessionCard({ ...source, agentSetup: { agent: 'codex', model: 'gpt-5', options: [], instructions: 'Keep diffs small' } }, { id: 'picked-id', name: 'picked name' });
  assert.deepEqual(pickedModelCard.modelSelection, { agent: 'codex', model: 'gpt-5', options: [] }, 'a session started on a picked model tells Chat which one, without its instructions');
});

test('limits tells a session which commands answer', async () => {
  const fixture = wiringFixture();
  const ephemeralLane = new Session({ id: 'review-lane', name: 'review', path: process.cwd(), ephemeral: true, ptySpawn: () => fakePty() });
  const contestant = new Session({ id: 'contestant', name: 'race c1', path: process.cwd(), ptySpawn: () => fakePty() });
  fixture.config.projects.push({ id: 'contestant', name: 'race c1', path: process.cwd(), raceId: 'race-1' });
  const limitsOf = async (session: Session) => {
    const reply = await fixture.wiring.handle(session, 'limits', {});
    assert.equal(reply.status, 200);
    return AgentLimitsReply.parse(reply.body);
  };
  try {
    const operatorLimits = await limitsOf(fixture.parent);
    assert.deepEqual(operatorLimits.commands, [
      { name: 'push', answers: false, reason: 'this session has no worktree of its own, so there is nothing of its own to land' },
      ...['spawn', 'send', 'read', 'close', 'attention', 'sessions', 'edit', 'review', 'reviews', 'prs', 'link-pr', 'settings', 'why', 'whiteboard', 'checkout', 'packs', 'need', 'secrets', 'arena', 'wargames', 'comments', 'wake', 'memory', 'claim', 'preview', 'done', 'check', 'codemap', 'show'].map((name) => ({ name, answers: true })),
    ]);
    const laneLimits = await limitsOf(ephemeralLane);
    assert.deepEqual(laneLimits.commands.map(({ name, answers }) => [name, answers]), [
      ['push', false], ['spawn', false], ['send', false], ['read', false], ['close', false], ['attention', false], ['sessions', true], ['edit', false],
      ['review', false], ['reviews', false], ['prs', false], ['link-pr', false], ['settings', false], ['why', true], ['whiteboard', false], ['checkout', false], ['packs', false], ['need', false], ['secrets', false], ['arena', false], ['wargames', false], ['comments', false], ['wake', false], ['memory', false], ['claim', false], ['preview', false], ['done', false], ['check', false], ['codemap', true], ['show', false],
    ]);
    const refusedCalls: [Session, AgentLimitsReply, string, Record<string, unknown>][] = [
      [fixture.parent, operatorLimits, 'push', {}],
      [ephemeralLane, laneLimits, 'push', {}],
      [ephemeralLane, laneLimits, 'spawn', { prompt: 'help me' }],
      [ephemeralLane, laneLimits, 'send', { words: ['hello'] }],
      [ephemeralLane, laneLimits, 'read', {}],
      [ephemeralLane, laneLimits, 'close', { child: 'anyone' }],
      [ephemeralLane, laneLimits, 'attention', { note: 'look' }],
      [ephemeralLane, laneLimits, 'edit', { path: 'notes.md' }],
      [ephemeralLane, laneLimits, 'review', { pr: 'acme/app#12' }],
      [ephemeralLane, laneLimits, 'reviews', {}],
      [ephemeralLane, laneLimits, 'link-pr', { pr: 'acme/app#12' }],
      [ephemeralLane, laneLimits, 'settings', { command: 'list' }],
      [ephemeralLane, laneLimits, 'checkout', { repo: 'dotfiles' }],
      [ephemeralLane, laneLimits, 'arena', { sub: 'races' }],
      [ephemeralLane, laneLimits, 'wargames', { sub: 'matches' }],
      [ephemeralLane, laneLimits, 'comments', { command: 'list' }],
      [contestant, await limitsOf(contestant), 'arena', { sub: 'diff', race: 'race-1', contestant: 'c2' }],
      [contestant, await limitsOf(contestant), 'wargames', { sub: 'matches' }],
    ];
    await fixture.spawn(contestant, { prompt: 'read the other diffs' });
    const contestantChild = fixture.created.at(-1);
    assert.ok(contestantChild);
    refusedCalls.push([contestantChild, await limitsOf(contestantChild), 'arena', { sub: 'judge', race: 'race-1' }]);
    for (const [session, limits, command, payload] of refusedCalls) {
      const refusal = await fixture.wiring.handle(session, command, payload);
      assert.equal(refusal.body.error, limits.commands.find(({ name }) => name === command)?.reason, `${command} is refused for the reason limits gave`);
    }
  } finally {
    ephemeralLane.destroy();
    contestant.destroy();
    fixture.destroyAll();
  }
});

test('an agent lists, answers and resolves the review comments the operator sent it, and a resolved comment takes no reply', async () => {
  const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-reviews-'));
  const pastedTexts: string[] = [];
  const reviews = createReviewWiring({
    reviewsRoot,
    broadcastControl: () => {},
    findSession: (sessionId) => (sessionId === 'parent' ? { noteOperatorDraft: () => {}, deliver: (text) => { pastedTexts.push(text); return { ok: true, kind: 'pasted' }; } } : null),
  });
  const fixture = wiringFixture({ reviewComments: reviews });
  try {
    assert.deepEqual(await reviews.sendComment('parent', { path: 'a.ts', side: 'new', line: 3, lineText: 'const a = 1;', text: 'Name this after what it holds' }), { ok: true });
    const listed = await fixture.wiring.handle(fixture.parent, 'comments', { command: 'list' });
    assert.equal(listed.status, 200);
    const listedBody = AGENT_REPLY_SCHEMAS.comments.parse(listed.body);
    const [comment] = 'comments' in listedBody ? listedBody.comments : [];
    assert.deepEqual(comment && { ...comment, id: 'id' }, { id: 'id', path: 'a.ts', line: 3, side: 'new', text: 'Name this after what it holds' });
    assert.ok(pastedTexts[0]?.includes(comment.id), 'the pasted comment names the id the agent answers with');
    assert.deepEqual((await fixture.wiring.handle(fixture.parent, 'comments', { command: 'reply', commentId: comment.id, text: 'Renamed it to totalCards' })).body, { ok: true });
    assert.deepEqual((await fixture.wiring.handle(fixture.parent, 'comments', { command: 'resolve', commentId: comment.id })).body, { ok: true });
    assert.deepEqual((await fixture.wiring.handle(fixture.parent, 'comments', { command: 'list' })).body, { ok: true, comments: [] });
    const stored = await reviews.read('parent');
    assert.deepEqual(stored?.comments.map(({ status, resolvedBy, replies }) => [status, resolvedBy, replies.map(({ text }) => text)]), [['resolved', 'agent', ['Renamed it to totalCards']]]);
    const lateReply = await fixture.wiring.handle(fixture.parent, 'comments', { command: 'reply', commentId: comment.id, text: 'one more thing' });
    assert.equal(lateReply.body.ok, false);
    assert.equal((await fixture.wiring.handle(fixture.parent, 'comments', { command: 'reply', commentId: comment.id })).body.ok, false, 'a reply needs its text');
  } finally {
    fixture.destroyAll();
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
  }
});

test('arena start races in the caller\'s project with the caller\'s permissions, one race with open contestants and no winner at a time, refusing what the Arena tab refuses, an agent check, clean home or command-line-unsafe model, and any spawned child', async () => {
  const startedSpecs: RaceSpec[] = [];
  const contestantPermissions: [boolean | undefined, boolean | undefined][] = [];
  const loadedRaces: RaceRecord[] = [];
  const launcher = createRaceLauncher({
    races: {
      start: async (spec, launch) => {
        startedSpecs.push(spec);
        for (const contestant of spec.contestants) launch(contestant, { raceId: 'race-7', startSha: 'a'.repeat(40) });
        loadedRaces.push(RaceRecord.parse({ id: 'race-7', spec, startSha: 'a'.repeat(40), baseBranch: 'main', createdAt: 0, sessionIdByContestant: { c1: 'parent' } }));
        return { ok: true, raceId: 'race-7', error: null };
      },
    },
    sessions: new Map(),
    config: { ...DEFAULT_CONFIG, skipPermissionsByDefault: true, projects: [] },
    createProjectSession: ({ dangerouslySkipPermissions, saneYolo }) => {
      contestantPermissions.push([dangerouslySkipPermissions, saneYolo]);
      return { ok: false, error: 'not in this fixture' };
    },
    isExistingDirectory: (folderPath) => {
      try {
        return fs.statSync(folderPath).isDirectory();
      } catch {
        return false;
      }
    },
    missingFolderError: (folderPath) => `Folder not found: ${folderPath}`,
  });
  const races = { status: () => ({ type: 'race-status' as const, races: loadedRaces }), judge: async () => ({ ok: true as const }), contestantDiffText: async () => ({ ok: true as const, diff: '' }) };
  const fixture = wiringFixture({ parentSkipsPermissions: false, arena: { races, startRace: launcher.start } });
  const setup = (agent: string) => ({ agent, model: null, options: [], instructions: '' });
  const spec = { title: 'fix it', prompt: 'fix the bug', repoPath: '/elsewhere', contestants: [{ id: 'c1', label: 'one', setup: setup('claude-code') }, { id: 'c2', label: 'two', setup: setup('codex') }] };
  const start = async (session: Session, raceSpec: Record<string, unknown>) => {
    const reply = await fixture.wiring.handle(session, 'arena', { sub: 'start', spec: raceSpec });
    return [reply.status, reply.body.error ?? reply.body];
  };
  try {
    assert.deepEqual(await start(fixture.parent, { ...spec, contestants: [spec.contestants[0], { id: 'c2', label: 'two', setup: setup('shell') }] }), [409, '"shell" cannot race: a contestant must be a coding agent']);
    assert.deepEqual(await start(fixture.parent, { ...spec, check: { program: 'cat', args: ['secret'] } }), [403, "an agent cannot set a race check, because Glimmervoid runs it outside every session's permission prompts; the operator can add one in the Arena tab"]);
    assert.deepEqual(await start(fixture.parent, { ...spec, contestants: [spec.contestants[0], { ...spec.contestants[1], home: 'clean' }] }), [403, "an agent cannot race a contestant in a clean home, because a clean home drops the operator's own denied tools and hooks; the operator can choose one in the Arena tab"]);
    assert.deepEqual(await start(fixture.parent, { ...spec, judge: { setup: { ...setup('codex'), options: [{ id: 'effort', value: 'high&calc.exe' }] } } }), [400, 'an agent cannot race the model or option value "high&calc.exe", because it reaches the agent\'s command line; use letters, digits and . _ : / [ ] -']);
    assert.deepEqual(await start(fixture.parent, spec), [200, { ok: true, raceId: 'race-7', warning: null }]);
    assert.deepEqual(startedSpecs.map(({ version, repoPath, judges, check }) => [version, repoPath, judges, check]), [[1, fixture.parent.path, [], null]]);
    assert.deepEqual(contestantPermissions, [[false, false], [false, false]], 'contestants keep the calling session\'s permissions, not the machine default');
    const stillOpen = [409, 'race race-7 still has contestant sessions open and no winner, and an agent may start a race only when none is unfinished'];
    assert.deepEqual(await start(fixture.parent, spec), stillOpen);
    loadedRaces[0] = { ...loadedRaces[0], phase: 'judged' };
    assert.deepEqual(await start(fixture.parent, spec), stillOpen, 'judging a race does not close its contestants, so it stays unfinished');
    await fixture.spawn(fixture.parent, { prompt: 'start a race' });
    const child = fixture.created.at(-1);
    assert.ok(child);
    assert.equal((await start(child, spec))[0], 403);
    assert.equal(startedSpecs.length, 1, 'a refused start never reaches the race lane');
    loadedRaces[0] = { ...loadedRaces[0], phase: 'running', winnerContestantId: 'c1' };
    assert.equal((await start(fixture.parent, spec))[0], 200, 'a race with a picked winner is finished even while its phase stays running');
  } finally {
    fixture.destroyAll();
  }
});

test('wargames agent verb starts, lists, inspects, aborts, and reads history with caller permissions and safety guards', async () => {
  const startedSpecs: WargamesMatchSpec[] = [];
  const seatPermissions: [boolean | undefined, boolean | undefined][] = [];
  const loadedMatches: WargamesMatchSummary[] = [];
  const abortedReasons: [string, string][] = [];
  const launcher = createWargamesLauncher({
    wargames: {
      seatSessionEnded: () => {},
      startMatch: async (spec, launchSeat) => {
        startedSpecs.push(spec);
        if (launchSeat) {
          for (const seat of spec.seats) {
            await launchSeat('wg-match-1', seat, () => {});
          }
        }
        loadedMatches.push(WargamesMatchSummary.parse({
          matchId: 'wg-match-1',
          rules: 'r5',
          title: spec.title,
          seed: spec.seed,
          createdAtMs: 1_000,
          finishedAtMs: null,
          status: 'seating',
          tick: 0,
          maxTicks: spec.maxTicks,
          phase: 'talk',
          winnerSeatId: null,
          winnerModelDisplay: null,
          eventCount: 2,
          seats: spec.seats.map((seat) => ({
            seatId: seat.seatId,
            label: seat.label,
            modelDisplay: seat.modelDisplay,
            status: 'disconnected',
            villagesHeld: 3,
          })),
        }));
        return { ok: true, matchId: 'wg-match-1', error: null };
      },
    },
    sessions: new Map(),
    config: { ...DEFAULT_CONFIG, skipPermissionsByDefault: true, projects: [] },
    createProjectSession: ({ dangerouslySkipPermissions, saneYolo }) => {
      seatPermissions.push([dangerouslySkipPermissions, saneYolo]);
      return { ok: false, error: 'not in this fixture' };
    },
  });
  const openSeatIds = new Set<string>();
  const seatSession = new Session({ id: 'wg-seat-s1', name: 'Wargames - s1', path: process.cwd(), ptySpawn: () => fakePty() });
  const wargames = {
    statusFrame: () => ({ type: 'wargames-status' as const, matches: loadedMatches }),
    historyFrame: () => ({
      type: 'wargames-history' as const,
      history: { eloByModel: [], matches: loadedMatches },
    }),
    isWargamesSession: (sessionId: string) => openSeatIds.has(sessionId),
    abortMatch: async (matchId: string, reason: string) => {
      const target = loadedMatches.find((candidate) => candidate.matchId === matchId);
      if (!target || target.status === 'aborted' || target.status === 'finished') {
        return { ok: false as const, error: `Match ${matchId} is not active` };
      }
      abortedReasons.push([matchId, reason]);
      target.status = 'aborted';
      return { ok: true as const };
    },
  };
  const fixture = wiringFixture({ parentSkipsPermissions: false, laneSessions: [seatSession], wargames: { wargames, startWargames: launcher.start } });
  const makeSeats = (overrides: Record<number, Partial<{ agent: string; options: { id: string; value: string }[] }>> = {}) =>
    WARGAMES_SEAT_IDS.map((seatId, index) => ({
      seatId,
      label: `Seat ${index + 1}`,
      setup: { agent: overrides[index]?.agent ?? 'claude-code', model: null, options: overrides[index]?.options ?? [], instructions: '' },
      modelDisplay: 'claude-default',
    }));
  const spec = { title: 'Agent Match', seed: 42, seats: makeSeats() };
  try {
    const shellRefusal = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec: { ...spec, seats: makeSeats({ 0: { agent: 'shell' } }) } });
    assert.equal(shellRefusal.status, 409);
    assert.equal(shellRefusal.body.error, '"shell" cannot play Wargames: a seat must be a coding agent');

    const unsafeRefusal = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec: { ...spec, seats: makeSeats({ 1: { options: [{ id: 'effort', value: 'high&calc.exe' }] } }) } });
    assert.equal(unsafeRefusal.status, 400);
    assert.match(String(unsafeRefusal.body.error), /high&calc\.exe/);

    const started = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec });
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { ok: true, matchId: 'wg-match-1', warning: null });
    assert.equal(startedSpecs.length, 1);
    assert.equal(startedSpecs[0]?.version, 1);
    assert.equal(seatPermissions.length, 6);
    assert.ok(seatPermissions.every(([skip, sane]) => skip === false && sane === false));

    const concurrentRefusal = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec });
    assert.equal(concurrentRefusal.status, 409);
    assert.match(String(concurrentRefusal.body.error), /still seating/);

    const listed = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'matches' });
    assert.equal(listed.status, 200);
    assert.equal(Array.isArray(listed.body.matches) ? listed.body.matches.length : 0, 1);

    const inspected = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'match', match: 'wg-match-1' });
    assert.equal(inspected.status, 200);
    assert.equal((inspected.body.match as { matchId?: string }).matchId, 'wg-match-1');

    const missing = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'match', match: 'wg-missing' });
    assert.equal(missing.status, 404);

    await fixture.spawn(fixture.parent, { prompt: 'start a wargames match' });
    const child = fixture.created.at(-1);
    assert.ok(child);
    const childStart = await fixture.wiring.handle(child, 'wargames', { sub: 'start', spec });
    assert.equal(childStart.status, 403);
    const childAbort = await fixture.wiring.handle(child, 'wargames', { sub: 'abort', match: 'wg-match-1' });
    assert.equal(childAbort.status, 403);

    openSeatIds.add(seatSession.id);
    const aborted = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'abort', match: 'wg-match-1', reason: 'test complete' });
    assert.equal(aborted.status, 200);
    assert.deepEqual(abortedReasons, [['wg-match-1', 'test complete']]);

    const openSeatRefusal = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec });
    assert.equal(openSeatRefusal.status, 409);
    assert.match(String(openSeatRefusal.body.error), /still open/);

    const history = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'history' });
    assert.equal(history.status, 200);
    assert.equal(Array.isArray((history.body.history as { matches?: unknown[] }).matches) ? (history.body.history as { matches: unknown[] }).matches.length : 0, 1);

    seatSession.destroy();
    const restarted = await fixture.wiring.handle(fixture.parent, 'wargames', { sub: 'start', spec });
    assert.equal(restarted.status, 200);
  } finally {
    seatSession.destroy();
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

test('a Studio branch and its main message each other on a channel opened from the branch link, which a replaced main takes over with one copy of each note, neither starts a session, the branch reaches no other session, and close leaves a branch alone', async () => {
  const branch = new Session({ id: 'branch-server', name: 'parent server', path: process.cwd(), ptySpawn: () => fakePty(), parent: { sessionId: 'parent', box: { id: 'box-server', title: 'server', repoName: 'glimmervoid' } } });
  const fixture = wiringFixture({ parentIsStudioMain: true, laneSessions: [branch] });
  try {
    fixture.wiring.linkBranchSession(fixture.parent);
    assert.equal((await fixture.spawn(fixture.parent, { prompt: 'build the ui' })).status, 400, 'the Orchestrator starts no session without a repo and a box');
    assert.equal((await fixture.wiring.handle(branch, 'send', { words: ['need', 'a', 'shared', 'type'] })).status, 200);
    const mainRead = AgentReadReply.parse((await fixture.wiring.handle(fixture.parent, 'read', {})).body).channels;
    assert.deepEqual(mainRead.flatMap(({ sessionId, entries }) => entries.map(({ from, text }) => [sessionId, from, text])), [['branch-server', 'child', 'need a shared type']]);
    assert.equal((await fixture.wiring.handle(fixture.parent, 'send', { words: ['branch-server', 'add', 'it', 'in', 'server'] })).status, 200);
    const branchRead = AgentReadReply.parse((await fixture.wiring.handle(branch, 'read', {})).body).channels;
    assert.deepEqual(branchRead.flatMap(({ entries }) => entries.map(({ from, text }) => [from, text])), [['parent', 'add it in server']]);
    assert.equal((await fixture.spawn(branch, { prompt: 'write the migration' })).status, 403, 'a branch starts no session of its own');
    const branchToOther = await fixture.wiring.handle(branch, 'send', { words: ['hello'], to: 'someone-else' });
    assert.equal(branchToOther.status, 404);
    assert.match(String((branchToOther.body as { error?: string }).error), /messages only its main/);
    assert.equal((await fixture.wiring.handle(fixture.parent, 'close', { child: 'branch-server' })).status, 409);
    assert.equal(branch._destroyed, false);

    const replacedMain = new Session({ id: 'parent', name: 'parent', path: process.cwd(), isStudioMain: true, ptySpawn: () => fakePty() });
    assert.equal((await fixture.wiring.handle(branch, 'send', { words: ['sent', 'before', 'the', 'replace'] })).status, 200);
    fixture.parent.destroy('replaced');
    fixture.registerParent(replacedMain);
    fixture.wiring.linkBranchSession(replacedMain);
    branch.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    const replacedRead = AgentReadReply.parse((await fixture.wiring.handle(replacedMain, 'read', {})).body).channels;
    assert.equal(replacedRead.flatMap(({ entries }) => entries).filter(({ text }) => /finished a turn/.test(text)).length, 1);
    assert.ok(replacedRead.flatMap(({ entries }) => entries).some(({ text }) => text === 'sent before the replace'), 'unread mail survives the replace');
    replacedMain.destroy();
  } finally {
    branch.destroy();
    fixture.destroyAll();
  }
});

test('siblings the same parent spawned message each other and see each other\'s file claims, and no other session can', async () => {
  const fixture = wiringFixture();
  const stranger = new Session({ id: 'stranger', name: 'stranger', path: process.cwd(), ptySpawn: () => fakePty() });
  try {
    const first = await fixture.spawn(fixture.parent, { prompt: 'build the api' });
    const second = await fixture.spawn(fixture.parent, { prompt: 'build the ui' });
    const [firstChild, secondChild] = fixture.created;
    const firstId = String(first.body.sessionId);
    const secondId = String(second.body.sessionId);
    assert.equal((await fixture.wiring.handle(firstChild, 'send', { words: ['the', 'api', 'shape', 'changed'], to: secondId })).status, 200);
    const secondRead = AgentReadReply.parse((await fixture.wiring.handle(secondChild, 'read', {})).body).channels;
    assert.deepEqual(secondRead.flatMap(({ entries }) => entries.map(({ from, text }) => [from, text])), [['sibling', `${firstChild.name} (${firstId}): the api shape changed`]]);
    assert.equal((await fixture.wiring.handle(stranger, 'send', { words: ['hijack'], to: secondId })).status, 404);
    assert.equal((await fixture.wiring.handle(fixture.parent, 'send', { words: ['hello'], to: secondId })).status, 404);

    const firstClaim = AgentClaimReply.parse((await fixture.wiring.handle(firstChild, 'claim', { sub: 'add', path: 'server/api.ts' })).body);
    assert.ok('claimed' in firstClaim && /until it ends/.test(firstClaim.note));
    const secondClaim = AgentClaimReply.parse((await fixture.wiring.handle(secondChild, 'claim', { sub: 'add', path: 'server/api.ts' })).body);
    assert.ok('claimed' in secondClaim);
    assert.match(secondClaim.note, new RegExp(`already claimed server/api.ts`));
    assert.equal((await fixture.wiring.handle(secondChild, 'claim', { sub: 'add', path: '../outside.ts' })).status, 400);
    assert.equal((await fixture.wiring.handle(secondChild, 'claim', { sub: 'release', path: 'server/api.ts' })).status, 404);
    fixture.agentSessions.delete(firstId);
    const listed = AgentClaimReply.parse((await fixture.wiring.handle(secondChild, 'claim', { sub: 'list' })).body);
    assert.deepEqual('claims' in listed ? listed.claims : null, [], 'a claim ends with its session');
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

test('closing a clean child discards its worktree and deletes its Sane YOLO temp folder only after the killed tree is reaped, and posts the closing parent no end note', async () => {
  let worktree: StubbedWorktree | null = null;
  const fixture = wiringFixture();
  const attentionNotes: string[] = [];
  fixture.parent.raiseAttention = (_origin, note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build the slice' });
    const childId = String(spawned.body.sessionId);
    worktree = stubChildWorktree(fixture.created[0], { dirty: false });
    const childTempFolder = path.join(glimmervoidHomeDir(), 'sane-yolo-temp', childId);
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
    for (const fragment of [worktree.branch, worktree.worktreeDir, 'push', `session send to child ${childId}`, 'discard']) {
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
  fixture.parent.raiseAttention = (_origin, note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
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
  fixture.parent.raiseAttention = (_origin, note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
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
  const realRaiseAttention = fixture.parent.raiseAttention.bind(fixture.parent);
  fixture.parent.raiseAttention = (_origin, note) => {
    const result = realRaiseAttention(_origin, note);
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
  fixture.parent.raiseAttention = (_origin, note) => { originalNotes.push(note); return { ok: true, pending: false }; };
  const successor = new Session({ id: fixture.parent.id, name: 'parent', path: process.cwd(), ptySpawn: () => fakePty() });
  successor.raiseAttention = (_origin, note) => { successorNotes.push(note); return { ok: true, pending: false }; };
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
      settleDeliveriesOnClock(fixture.parent, clock, (text) => pasted.push(text));
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
  settleDeliveriesOnClock(fixture.parent, clock, (text) => pasted.push(text));
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
  const written: string[] = [];
  const attentionNotes: string[] = [];
  fixture.parent.write = (text) => { written.push(text); };
  fixture.parent.raiseAttention = (_origin, note) => { attentionNotes.push(note); return { ok: true, pending: false }; };
  const pasted = () => written.filter((text) => text.startsWith('\x1b[200~')).map((text) => text.slice(6, -6));
  const enters = () => written.filter((text) => text === '\r');
  const waitForSubmitDelay = () => new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS + 50));
  try {
    const spawned = await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const childId = String(spawned.body.sessionId);
    const child = fixture.created[0];
    await fixture.parent.start();
    fixture.parent.transition('first_output');
    assert.equal(fixture.parent.state, STATES.IDLE);
    const endChildTurn = async () => {
      child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
      advanceBy(1000);
      await waitForSubmitDelay();
    };

    child.emit('hook-event', { event: 'Stop', payload: { last_assistant_message: 'held U2 over a HIGH finding' } });
    await endChildTurn();
    assert.deepEqual(pasted(), [`Glimmervoid: ${String(spawned.body.name)}, the session you spawned, has news. Run glimmervoid read ${childId} and act on it.`]);
    assert.deepEqual(enters(), ['\r']);
    const notes = AgentReadReply.parse((await fixture.wiring.handle(fixture.parent, 'read', {})).body).channels[0]?.entries ?? [];
    assert.deepEqual(notes.map(({ from }) => from), ['glimmervoid']);
    assert.match(notes[0]?.text ?? '', /finished a turn and is Idle\. Its last message:\nheld U2 over a HIGH finding$/);

    for (let turn = 0; turn < 10; turn += 1) {
      advanceBy(WAKE_TURN_START_TIMEOUT_MS);
      await endChildTurn();
    }
    assert.deepEqual([pasted().length, enters().length, attentionNotes.length], [10, 10, 1], 'the eleventh wake flags the operator instead of typing');

    fixture.parent.emit('operator-input');
    await endChildTurn();
    assert.equal(pasted().length, 10, 'no wake while the operator typed in the last 30 seconds');
    advanceBy(30_000);
    advanceBy(1000);
    await waitForSubmitDelay();
    assert.deepEqual([pasted().length, enters().length], [11, 11], 'operator input resets the cap and the held wake fires after the hold-off');

    advanceBy(WAKE_TURN_START_TIMEOUT_MS);
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    fixture.parent.noteOperatorInput('r');
    await waitForSubmitDelay();
    assert.deepEqual([pasted().length, enters().length], [12, 11], 'a keystroke between the paste and the Enter leaves the wake line unsubmitted');
  } finally {
    fixture.destroyAll();
  }
});

test('a child that stops while its parent works wakes the parent once the parent turn ends with a background shell still running', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const written: string[] = [];
  fixture.parent.write = (text) => { written.push(text); };
  const wakeLines = () => written.filter((text) => text.includes('has news'));
  const waitForSubmitDelay = () => new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS + 50));
  try {
    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await fixture.parent.start();
    fixture.parent.transition('first_output');
    fixture.parent.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'watch the match in the background' } });
    fixture.parent.transition('new_output');
    assert.equal(fixture.parent.state, STATES.RUNNING);

    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    await waitForSubmitDelay();
    assert.equal(wakeLines().length, 0, 'no wake while the parent is mid-turn');

    fixture.parent.ingestHookSignal({ event: 'Stop', signal: 'ready', source: 'hook', ts: 2, payload: { background_tasks: [{ id: 'match-watch', type: 'shell', status: 'running' }] } });
    for (let waitedMs = 0; waitedMs < 3000 && !fixture.parent.isBetweenTurns(); waitedMs += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fixture.parent.state, STATES.RUNNING);
    assert.equal(fixture.parent.isBetweenTurns(), true);
    advanceBy(1000);
    await waitForSubmitDelay();
    assert.deepEqual([wakeLines().length, written.filter((text) => text === '\r').length], [1, 1]);
  } finally {
    fixture.destroyAll();
  }
});

test('a child resuming after the parent wake line was submitted, before the parent has started its turn, types no second wake line', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const written: string[] = [];
  fixture.parent.write = (text) => { written.push(text); };
  const wakeLines = () => written.filter((text) => text.includes('has news'));
  try {
    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await fixture.parent.start();
    fixture.parent.transition('first_output');
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.COMPLETE });
    advanceBy(1000);
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS + 50));
    assert.deepEqual([wakeLines().length, written.filter((text) => text === '\r').length], [1, 1]);
    assert.equal(fixture.parent.state, STATES.IDLE);
    child.emit('state-change', { from: STATES.COMPLETE, to: STATES.RUNNING });
    advanceBy(1000);
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS + 50));
    assert.equal(wakeLines().length, 1);
  } finally {
    fixture.destroyAll();
  }
});

test('a child wake refused while a prompt is still queued for its parent is typed once that prompt has landed', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const written: string[] = [];
  fixture.parent.write = (text) => { written.push(text); };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await fixture.parent.start();
    assert.equal(fixture.parent.deliver('radar fix prompt', { when: 'ready', submit: false }).kind, 'queued');
    child.emit('hook-event', { event: 'Stop', payload: { last_assistant_message: 'done' } });
    fixture.parent.transition('first_output');
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    advanceBy(1000);
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS + 50));
    assert.equal(written[0], '\x1b[200~radar fix prompt\x1b[201~');
    assert.match(written[1] ?? '', /has news/);
    assert.equal(written[2], '\r');
  } finally {
    fixture.destroyAll();
  }
});

test('a session wakes itself through the wake verb, malformed wakes are refused with nothing stored, and self-wakes share the child-wake cap', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const pasted: string[] = [];
  const written: string[] = [];
  const attentionOrigins: string[] = [];
  const inputOrder: string[] = [];
  settleDeliveriesOnClock(fixture.parent, clock, (text) => { pasted.push(text); inputOrder.push('paste'); });
  fixture.parent.write = (text) => { written.push(text); inputOrder.push('enter'); };
  fixture.parent.raiseAttention = (origin) => { attentionOrigins.push(origin); return { ok: true, pending: false }; };
  const wake = (payload: Record<string, unknown>) => fixture.wiring.handle(fixture.parent, 'wake', payload);
  const listedWakes = async () => {
    const listed = AgentWakeReply.parse((await wake({ sub: 'list' })).body);
    return 'wakes' in listed ? listed.wakes.map(({ id }) => id) : null;
  };
  try {
    fixture.parent.transition('user_start');
    fixture.parent.transition('spawn_success', { spawnCwdExists: true });
    fixture.parent.transition('first_output');
    for (const malformed of [{ sub: 'in', when: 'soon', text: 'x' }, { sub: 'at', when: '25:00', text: 'x' }, { sub: 'cron', when: 'every day', text: 'x' }, { sub: 'cron', when: '* * * * * *', text: 'x' }, { sub: 'in', when: '5m', text: ' ' }]) {
      const refused = await wake(malformed);
      assert.equal(refused.status, 400, JSON.stringify(malformed));
      assert.match(String(refused.body.error), /\w/);
    }
    assert.deepEqual(await listedWakes(), []);

    assert.equal((await wake({ sub: 'in', when: '1m', text: 'check the rollout' })).status, 200);
    assert.equal((await wake({ sub: 'cron', when: '*/5 * * * *', text: 'poll' })).status, 200);
    assert.deepEqual(await listedWakes(), ['w1', 'w2']);
    assert.deepEqual((await wake({ sub: 'cancel', wake: 'w2' })).body, { ok: true, cancelled: 'w2' });
    assert.equal((await wake({ sub: 'cancel', wake: 'w2' })).status, 404);
    advanceBy(60_000);
    advanceBy(300);
    assert.equal(pasted.length, 1);
    assert.match(pasted[0] ?? '', /^Glimmervoid wake w1 \(you set it at \d\d:\d\d\): check the rollout$/);
    assert.deepEqual(written, ['\r']);
    assert.deepEqual(await listedWakes(), []);

    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await wake({ sub: 'in', when: '1m', text: 'race the child' });
    advanceBy(60_000);
    advanceBy(50);
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    advanceBy(WAKE_TURN_START_TIMEOUT_MS);
    advanceBy(1000);
    assert.deepEqual(inputOrder.slice(-4), ['paste', 'enter', 'paste', 'enter'], 'a child stopping while a self-wake line awaits its turn types its own line only once that wake is released');
    for (let turn = 0; turn < 7; turn += 1) {
      advanceBy(WAKE_TURN_START_TIMEOUT_MS);
      child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
      advanceBy(1000);
    }
    assert.equal(written.length, 10);
    await wake({ sub: 'in', when: '30s', text: 'one more' });
    advanceBy(30_000);
    advanceBy(1000);
    assert.deepEqual([pasted.length, attentionOrigins], [10, ['self-wake-cap']], 'two self-wakes and eight child wakes spend the shared cap of ten');
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    assert.equal(pasted.length, 10, 'a child wake stays stopped once a self-wake flagged the operator');
  } finally {
    fixture.destroyAll();
  }
});

test('a draft the operator stages at an idle parent holds off the wake so a stopping child never submits it', async () => {
  const { clock, advanceBy } = manualClock();
  const fixture = wiringFixture({ clock });
  const written: string[] = [];
  fixture.parent.write = (text) => { written.push(text); };
  try {
    await fixture.spawn(fixture.parent, { prompt: 'build U2' });
    const child = fixture.created[0];
    await fixture.parent.start();
    fixture.parent.transition('first_output');
    assert.equal(fixture.parent.state, STATES.IDLE);
    assert.equal(fixture.parent.deliver('half done', { when: 'ready', submit: false }).ok, true);
    fixture.parent.noteOperatorDraft();
    advanceBy(1000);
    child.emit('state-change', { from: STATES.RUNNING, to: STATES.IDLE });
    advanceBy(1000);
    assert.match(written.join(''), /^\x1b\[200~half done/);
    assert.deepEqual([written.filter((text) => text.includes('has news')).length, written.filter((text) => text === '\r').length], [0, 0]);
  } finally {
    fixture.destroyAll();
  }
});

test('the fourth live child is refused and a child exiting frees its slot', async () => {
  const fixture = wiringFixture();
  try {
    for (let index = 0; index < SPAWNED_SESSIONS_DEFAULT; index += 1) {
      const reply = await fixture.spawn(fixture.parent, { prompt: `slice ${index}` });
      assert.equal(reply.status, 200, `child ${index}`);
    }
    const refused = await fixture.spawn(fixture.parent, { prompt: 'one too many' });
    assert.equal(refused.status, 429);
    assert.equal(fixture.created.length, SPAWNED_SESSIONS_DEFAULT);

    fixture.created[0].emit('exit');
    assert.equal(fixture.parent.agentSpawnBudget().liveChildren, SPAWNED_SESSIONS_DEFAULT - 1);
    const admitted = await fixture.spawn(fixture.parent, { prompt: 'refilling the slot' });
    assert.equal(admitted.status, 200);
    assert.equal(fixture.parent.agentSpawnBudget().lifetimeSpawns, SPAWNED_SESSIONS_DEFAULT + 1);
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
    assert.deepEqual(session.raiseAttention('agent', 'pick a base branch'), { ok: true, pending: true });
    assert.deepEqual(session.raiseAttention('agent', 'then confirm the force push'), { ok: true, pending: true });
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
    assert.deepEqual(session.raiseAttention('agent', 'pick a base branch'), { ok: true, pending: false });
    assert.equal(session.state, STATES.WAITING);
    assert.deepEqual(session.raiseAttention('agent', 'then confirm the force push'), { ok: true, pending: false });
    session.transition('user_dismiss');
    await setTimeoutPromise(600);
    assert.deepEqual(session.raiseAttention('agent', 'and pick a reviewer'), { ok: true, pending: false });
    assert.equal(session.state, STATES.WAITING);
    assert.deepEqual(triggered.map((entry) => entry.message), [
      'folding lane: pick a base branch',
      'folding lane: then confirm the force push | and pick a reviewer',
    ], 'the undelivered note is folded in and the delivered one is not repeated');
  } finally {
    session.destroy();
  }
});

test('an attention note raised after the turn ends leaves the finished session complete and records its origin', () => {
  const session = plainSession('attention-note-session', 'finished lane');
  const triggered: { category: string; message: string }[] = [];
  const wireSessionEvents = notificationWiring(triggered);
  try {
    wireSessionEvents(session);
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    session.transition('task_complete');
    assert.deepEqual(session.raiseAttention('child-kept', 'the child worktree was kept'), { ok: true, pending: false });
    assert.equal(session.state, STATES.COMPLETE);
    assert.deepEqual(triggered.filter((entry) => entry.category !== 'complete'), [{ category: 'note', message: 'finished lane: the child worktree was kept' }]);
    assert.deepEqual(session.attentionNotes.map(({ origin, note }) => ({ origin, note })), [{ origin: 'child-kept', note: 'the child worktree was kept' }]);
    const attentionRecords = session._observability.decisionTail(15).filter((entry) => entry.kind === 'attention');
    assert.deepEqual(attentionRecords.map(({ origin, disposition, note }) => ({ origin, disposition, note })), [{ origin: 'child-kept', disposition: 'flagged', note: 'the child worktree was kept' }]);
    session.dismiss();
    assert.deepEqual(session.attentionNotes, [], 'dismissing the card clears its notes');
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
      assert.deepEqual(session.raiseAttention('agent', `note ${index}`), { ok: true, pending: true });
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
    assert.deepEqual(session.raiseAttention('agent', 'pick a base branch before I rebase'), { ok: true, pending: true });
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
    assert.match(String(missing.body.error), /review action review for pr acme\/app#99/);
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

test('checkout gives a session its own worktree of a project kept as a bare repository', { skip: !GIT }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-checkout-bare-')));
  const fixture = wiringFixture();
  const checkoutOwner = new Session({ id: fixture.parent.id, name: 'parent', path: root, ptySpawn: () => fakePty(), gitWorkspace: createGitWorkspace() });
  try {
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    const bare = path.join(root, 'project.git');
    fs.mkdirSync(origin);
    git(['init', '--bare', '-b', 'main'], origin);
    git(['clone', origin, seed], root);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Checkout Test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'], seed);
    git(['push', 'origin', 'HEAD:main'], seed);
    git(['clone', '--bare', origin, bare], root);
    fixture.registerParent(checkoutOwner);

    const reply = await fixture.wiring.handle(checkoutOwner, 'checkout', { repo: bare });
    assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], String(reply.body.path)).trim(), 'true');
  } finally {
    checkoutOwner.destroy();
    fixture.destroyAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
