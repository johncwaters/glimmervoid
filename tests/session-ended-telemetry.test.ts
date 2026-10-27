import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import type { SessionEndCause } from '../shared/contracts/telemetry.ts';
import type { Session } from '../session/sessions.ts';

test('a running session that Glimmervoid destroys reports session_ended once with why it ended', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-session-ended-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const sessions: Session[] = [];
  const stores: ConfigStore[] = [];
  const capturedEvents: { event: string; properties: Record<string, unknown> }[] = [];
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [{ id: 'ended-session', name: 'project', path: directory }] }));
    const makeSession = createSessionFactory({
      configStore: { configPath }, hookRouter: null, getHookPort: () => null,
      getGitWorkspace: () => null, getPlanReviewPort: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    const startRunningWiredSession = () => {
      const store = createConfigStore();
      stores.push(store);
      const session = makeSession(store.config.projects[0], store.config);
      sessions.push(session);
      createSessionEventWiring({
        configStore: store, config: store.config, recordLane: () => {},
        usage: { refreshSessions: () => {}, nudgeSession: () => {} },
        broadcastControl: () => {},
        telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
        notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
        getIngestLane: () => null, tapIngestForSession: () => {}, closeSessionDataClients: () => {},
        logger: { error: () => {}, log: () => {}, warn: () => {} },
        telemetry: {
          capture: (event: string, properties: Record<string, unknown>) => { capturedEvents.push({ event, properties }); },
          captureException: () => {},
        },
      })(session);
      session.transition('user_start');
      session.transition('spawn_success', { spawnCwdExists: true });
      return session;
    };
    const causes: SessionEndCause[] = ['removed', 'replaced', 'server_stopped'];
    for (const cause of causes) startRunningWiredSession().destroy(cause);
    startRunningWiredSession().destroy();

    const endedKinds = capturedEvents.filter(({ event }) => event === 'session_ended').map(({ properties }) => properties.exit_kind);
    assert.deepEqual(endedKinds, ['removed', 'replaced', 'server_stopped', 'removed']);
  } finally {
    for (const session of sessions) session.destroy();
    await Promise.all(stores.map((store) => store.idle()));
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('an agent that quits on its own removes its configured session, and a kill does not', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-session-quit-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const sessions: Session[] = [];
  const stores: ConfigStore[] = [];
  const removedSessionIds: string[] = [];
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [{ id: 'quitting-session', name: 'project', path: directory }] }));
    const makeSession = createSessionFactory({
      configStore: { configPath }, hookRouter: null, getHookPort: () => null,
      getGitWorkspace: () => null, getPlanReviewPort: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    const startIdleWiredSession = () => {
      const store = createConfigStore();
      stores.push(store);
      const session = makeSession(store.config.projects[0], store.config);
      sessions.push(session);
      createSessionEventWiring({
        configStore: store, config: store.config, recordLane: () => {},
        usage: { refreshSessions: () => {}, nudgeSession: () => {} },
        broadcastControl: () => {},
        telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
        notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
        getIngestLane: () => null, tapIngestForSession: () => {}, closeSessionDataClients: () => {},
        removeExitedSession: (id: string) => { removedSessionIds.push(id); },
        logger: { error: () => {}, log: () => {}, warn: () => {} },
      })(session);
      session.transition('user_start');
      session.transition('spawn_success', { spawnCwdExists: true });
      session.transition('first_output');
      return session;
    };

    const killedSession = startIdleWiredSession();
    killedSession.killSession();
    await killedSession._handlePtyExit(0, null);
    assert.deepEqual(removedSessionIds, []);

    const failedSession = startIdleWiredSession();
    await failedSession._handlePtyExit(1, null);
    assert.deepEqual(removedSessionIds, []);

    const signalKilledSession = startIdleWiredSession();
    await signalKilledSession._handlePtyExit(0, 9);
    assert.deepEqual(removedSessionIds, []);

    const restartedDuringSettleSession = startIdleWiredSession();
    let releaseSettle = () => {};
    restartedDuringSettleSession._settleWorktreeOnExit = () => new Promise<void>((resolve) => { releaseSettle = resolve; });
    restartedDuringSettleSession.start = async () => {};
    const exitHandled = restartedDuringSettleSession._handlePtyExit(0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restartedDuringSettleSession.restart(), true);
    releaseSettle();
    await exitHandled;
    assert.deepEqual(removedSessionIds, []);

    await startIdleWiredSession()._handlePtyExit(0, null);
    assert.deepEqual(removedSessionIds, ['quitting-session']);
  } finally {
    for (const session of sessions) session.destroy();
    await Promise.all(stores.map((store) => store.idle()));
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a session spawned by a parent session never notifies the operator, and an operator session still does', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-child-muted-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const sessions: Session[] = [];
  const stores: ConfigStore[] = [];
  const triggeredCategoriesBySessionId = new Map<string, string[]>();
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [{ id: 'notifying-session', name: 'project', path: directory }] }));
    const makeSession = createSessionFactory({
      configStore: { configPath }, hookRouter: null, getHookPort: () => null,
      getGitWorkspace: () => null, getPlanReviewPort: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    const startIdleWiredSession = (id: string, ownerId: string | null) => {
      const store = createConfigStore();
      stores.push(store);
      const session = makeSession({ ...store.config.projects[0], id }, store.config, { ownerId });
      sessions.push(session);
      triggeredCategoriesBySessionId.set(id, []);
      createSessionEventWiring({
        configStore: store, config: store.config, recordLane: () => {},
        usage: { refreshSessions: () => {}, nudgeSession: () => {} },
        broadcastControl: () => {},
        telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
        notificationManager: {
          acknowledge: () => {},
          trigger: (sessionId: string, category: string) => { triggeredCategoriesBySessionId.get(sessionId)?.push(category); return true; },
          noteOperatorActivity: () => {},
        },
        getIngestLane: () => null, tapIngestForSession: () => {}, closeSessionDataClients: () => {},
        logger: { error: () => {}, log: () => {}, warn: () => {} },
      })(session);
      session.transition('user_start');
      session.transition('spawn_success', { spawnCwdExists: true });
      session.transition('first_output');
      return session;
    };

    const operatorSession = startIdleWiredSession('operator-session', null);
    const childSession = startIdleWiredSession('child-session', 'operator-session');
    for (const session of [operatorSession, childSession]) session.noteAttention('the agent needs a decision');

    assert.equal(childSession.state, 'WAITING');
    assert.deepEqual(triggeredCategoriesBySessionId.get('operator-session'), ['waiting']);
    assert.deepEqual(triggeredCategoriesBySessionId.get('child-session'), []);
  } finally {
    for (const session of sessions) session.destroy();
    await Promise.all(stores.map((store) => store.idle()));
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});
