import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { SessionCardFields } from '../shared/contracts/control/control-fields.ts';
import { SessionSnapshot } from '../shared/contracts/session.ts';
import type { Session } from '../session/sessions.ts';

test('a child session its parent owns and an arena contestant never notify the operator and tell the dashboard who attends them, while a plain session notifies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-handled-notify-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  const sessions: Session[] = [];
  let configStore: ReturnType<typeof createConfigStore> | null = null;
  const raceId = '7f0c5a52-3f4e-4b55-9d7e-0c1d6b0b1a11';
  try {
    await writeFile(configPath, JSON.stringify({
      recordSignals: false,
      projects: [
        { id: 'plain-session', name: 'plain', path: directory },
        { id: 'owned-child', name: 'child', path: directory },
        { id: 'arena-contestant', name: 'contestant', path: directory, raceId },
      ],
    }));
    configStore = createConfigStore();
    const makeSession = createSessionFactory({
      configStore: { configPath }, hookRouter: null, getHookPort: () => null,
      getGitWorkspace: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    const triggered: { id: string; category: string }[] = [];
    const wire = createSessionEventWiring({
      configStore, config: configStore.config, recordLane: () => {},
      usage: { refreshSessions: () => {}, nudgeSession: () => {} },
      broadcastControl: () => {},
      telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
      notificationManager: { acknowledge: () => {}, trigger: (id, category) => { triggered.push({ id, category }); }, noteOperatorActivity: () => {} },
      attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
      logger: { error: () => {}, log: () => {}, warn: () => {} },
    });
    const [plainProject, childProject, contestantProject] = configStore.config.projects;
    assert.ok(plainProject && childProject && contestantProject);
    const startWired = (session: Session) => {
      sessions.push(session);
      wire(session);
      session.transition('user_start');
      session.transition('spawn_success', { spawnCwdExists: true });
      session.transition('first_output');
      session.transition('prompt_detected');
      session.transition('user_input');
      session.transition('task_complete');
      session.emit('attention-notes', { notes: [{ origin: 'child-kept', note: 'look at this', at: Date.now() }] });
    };
    startWired(makeSession(plainProject, configStore.config));
    startWired(makeSession(childProject, configStore.config, { ownerId: 'plain-session' }));
    startWired(makeSession(contestantProject, configStore.config));

    assert.deepEqual([...new Set(triggered.map(({ id }) => id))], ['plain-session']);
    assert.deepEqual(triggered.map(({ category }) => category), ['waiting', 'complete', 'note']);
    const ownersOnTheWire = sessions.map((session) => ({
      snapshot: SessionSnapshot.parse(session.toSnapshot()).attentionOwner,
      card: SessionCardFields.parse({ ...projectSessionCard(session, { id: session.id, name: session.name }) }).attentionOwner ?? 'operator',
    }));
    assert.deepEqual(ownersOnTheWire, [
      { snapshot: 'operator', card: 'operator' },
      { snapshot: 'parent', card: 'parent' },
      { snapshot: 'race', card: 'race' },
    ]);
  } finally {
    for (const session of sessions) session.destroy();
    await configStore?.idle();
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});
