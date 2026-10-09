import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session-factory.ts';
import { Session } from '../session/sessions.ts';
import type { Server } from 'node:http';
import { createSessionRegistry } from '../server/session-registry.ts';

import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';

function wiredSession(session = plainSession('resume-persist-session'), configStore?: ConfigStore) {
  const recordedLanes: string[] = [];
  const config = configStore?.config ?? { projects: [{ id: 'resume-persist-session' } as Record<string, unknown>] };
  const wireSessionEvents = createSessionEventWiring({
    configStore: configStore ?? {
      save: (mutator: (candidate: typeof config) => void) => {
        mutator(config);
        return config;
      },
    },
    config,
    recordLane: (claudeSessionId: string) => { recordedLanes.push(claudeSessionId); },
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {} },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  const savedField = () => config.projects[0]?.resumeSessionId ?? null;
  wireSessionEvents(session);
  return { session, recordedLanes, savedField };
}

test('a live id that is not the resume target is never written to config', () => {
  const { session, recordedLanes, savedField } = wiredSession();
  session.emit('claude-session-id', {
    id: 'bbbb2222-0000-0000-0000-bbbbbbbbbbbb',
    vendor: 'claude',
    isResumeTarget: false,
  });
  assert.equal(savedField(), null, 'a blank spawn cannot overwrite a saved conversation');
  assert.deepEqual(recordedLanes, ['bbbb2222-0000-0000-0000-bbbbbbbbbbbb'], 'usage attribution still follows the live id');
  session.destroy();
});

test('a live id that is the resume target is written to config', () => {
  const { session, recordedLanes, savedField } = wiredSession();
  session.emit('claude-session-id', {
    id: 'aaaa1111-0000-0000-0000-aaaaaaaaaaaa',
    vendor: 'claude',
    isResumeTarget: true,
  });
  assert.equal(savedField(), 'aaaa1111-0000-0000-0000-aaaaaaaaaaaa');
  assert.deepEqual(recordedLanes, ['aaaa1111-0000-0000-0000-aaaaaaaaaaaa']);
  session.destroy();
});


for (const titleKind of ['automatic', 'pending', 'custom'] as const) {
  test(`session factory restart round trip preserves ${titleKind} titles and persists /clear`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-title-persistence-'));
    const configPath = path.join(directory, 'config.json');
    const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
    const sessions: Session[] = [];
    const stores: ConfigStore[] = [];
    process.env.GLIMMERVOID_CONFIG = configPath;
    try {
      await writeFile(configPath, JSON.stringify({
        recordSignals: false,
        projects: [{ id: 'resume-persist-session', name: 'project', path: directory, wasActive: true, resumeSessionId: 'aaaa1111-0000-0000-0000-aaaaaaaaaaaa' }],
      }));
      const makeSession = createSessionFactory({
        configStore: { configPath }, hookRouter: null, getHookPort: () => null,
        getGitWorkspace: () => null, getPlanReviewPort: () => null,
        resolveHookTools: () => [], getUserHooks: () => [],
      });
      const firstStore = createConfigStore();
      stores.push(firstStore);
      const firstSession = makeSession(firstStore.config.projects[0], firstStore.config);
      sessions.push(firstSession);
      wiredSession(firstSession, firstStore);
      firstSession.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'Fix the original task' } });
      firstSession.applyTaskTitleRefinement({ action: 'replace', title: 'Refined task' });
      if (titleKind === 'custom') {
        firstStore.save((config) => { config.projects[0].customTitle = 'Custom task'; });
        firstStore.config.projects[0].customTitle = 'Custom task';
        firstSession.setCustomTitle('Custom task');
        firstSession.applyTaskTitleRefinement({ action: 'replace', title: 'Hidden refined task' });
      }
      if (titleKind === 'pending') firstSession.setPendingTaskTitle('Latest substantive task prompt');
      const expectedTitle = firstSession.settledTaskTitle;
      await firstStore.idle();
      firstSession.destroy();
      const secondStore = createConfigStore();
      stores.push(secondStore);
      const restoredSession = makeSession(secondStore.config.projects[0], secondStore.config);
      sessions.push(restoredSession);
      wiredSession(restoredSession, secondStore);
      assert.equal(restoredSession.toSnapshot().taskTitle, expectedTitle);
      assert.equal(restoredSession.toSnapshot().taskTitleIsCustom, titleKind === 'custom');
      assert.equal(restoredSession.settledTaskTitle, titleKind === 'custom' ? 'Custom task' : 'Refined task');
      assert.equal(restoredSession.refocusTaskTitle, titleKind === 'custom' ? 'Custom task' : 'Fix the original task');
      restoredSession.applyTaskTitleRefinement({ action: 'keep' });
      assert.equal(restoredSession.taskTitle, titleKind === 'custom' ? 'Custom task' : 'Refined task');
      restoredSession.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 2, payload: { prompt: 'Fix another task now' } });
      assert.equal(restoredSession.taskTitle, titleKind === 'custom' ? 'Custom task' : 'Refined task');
      restoredSession.ingestHookSignal({ event: 'SessionStart', signal: 'session-start', source: 'hook', ts: 3, payload: { source: 'clear' } });
      await secondStore.idle();
      const clearedProject = createConfigStore().config.projects[0];
      assert.equal(restoredSession.taskTitle, titleKind === 'custom' ? 'Custom task' : null);
      assert.equal(clearedProject.taskTitleState?.taskTitle, titleKind === 'custom' ? 'Custom task' : undefined);
      assert.deepEqual(clearedProject.taskTitleState?.sources, titleKind === 'custom' ? { customTitle: 'Custom task' } : undefined);
      restoredSession.setCustomTitle(null);
      assert.equal(restoredSession.taskTitle, null);
      restoredSession.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 4, payload: { prompt: 'Brand new task prompt' } });
      assert.equal(restoredSession.taskTitle, 'Brand new task prompt');
      await secondStore.idle();
      assert.equal(secondStore.config.projects[0].taskTitleState?.taskTitle, 'Brand new task prompt');
      const diskConfig = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(diskConfig.projects[0].taskTitleState.taskTitle, 'Brand new task prompt');
    } finally {
      for (const session of sessions) session.destroy();
      await Promise.all(stores.map((store) => store.idle()));
      if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
      if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('a session added by a config reload persists its seeded title state to disk', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-reload-title-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const sessions = new Map<string, Session>();
  process.env.GLIMMERVOID_CONFIG = configPath;
  await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [] }));
  const store = createConfigStore();
  try {
    const wireSessionEvents = createSessionEventWiring({
      configStore: store,
      config: store.config,
      recordLane: () => {},
      usage: { refreshSessions: () => {}, nudgeSession: () => {} },
      broadcastControl: () => {},
      telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
      notificationManager: { acknowledge: () => {}, trigger: () => {} },
      getIngestLane: () => null,
      tapIngestForSession: () => {},
      closeSessionDataClients: () => {},
      logger: { error: () => {}, log: () => {}, warn: () => {} },
    });
    const registry = createSessionRegistry({
      httpServer: { listening: true } as Server,
      sessions,
      config: store.config,
      configStore: store,
      makeSession: (project) => {
        const session = new Session({ id: project.id, name: project.name, path: project.path, customTitle: project.customTitle });
        session.start = () => Promise.resolve();
        return session;
      },
      wireSessionEvents,
      closeSessionDataClients: () => {},
      notificationManager: { acknowledge: () => {} },
      getIngestLane: () => null,
      broadcastControl: () => {},
      applySettingsReload: () => {},
      spawnGate: { run: (callback) => Promise.resolve(callback()) },
      gitWorkspaceSync: { listSessionWorktrees: () => [], removeWorktreeByPath: () => {} },
      reconcileSessionWorktrees: () => {},
      carryWorktreeAcrossRecreate: () => undefined,
      ensureProjectIds: () => false,
      resolveAgentId: (agent) => agent ?? 'claude-code',
      logger: { log: () => {}, warn: () => {} },
    });
    await writeFile(configPath, JSON.stringify({
      recordSignals: false,
      projects: [{ id: 'reload-added-session', name: 'reloaded', path: directory, customTitle: 'Reloaded custom title' }],
    }));
    registry.applyConfigReload(createConfigStore().config);
    await store.idle();
    const diskConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(diskConfig.projects[0].taskTitleState.taskTitle, 'Reloaded custom title');
    assert.equal(store.config.projects[0].taskTitleState?.taskTitle, 'Reloaded custom title');
  } finally {
    for (const session of sessions.values()) session.destroy();
    await store.idle();
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});
