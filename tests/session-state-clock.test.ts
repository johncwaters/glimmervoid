import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';

test('the dashboard clock of a starting session runs on through its first working turn, live and on reload', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-state-clock-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [{ id: 'clock', name: 'project', path: directory }] }));
  const store = createConfigStore();
  const makeSession = createSessionFactory({
    configStore: { configPath }, hookRouter: null, getHookPort: () => null,
    getGitWorkspace: () => null,
    resolveHookTools: () => [], getUserHooks: () => [],
  });
  const session = makeSession(store.config.projects[0], store.config);
  const liveStateSinceByState = new Map<string, unknown>();
  createSessionEventWiring({
    configStore: store, config: store.config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: (message) => {
      const parsed = ServerMessage.safeParse(message);
      if (parsed.success && parsed.data.type === 'session-status' && parsed.data.transition) liveStateSinceByState.set(parsed.data.transition.to, parsed.data.stateSince);
    },
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  t.after(async () => {
    session.destroy();
    await store.idle();
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  });

  const flushStatus = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  session.transition('user_start');
  await flushStatus();
  const startedAt = session.stateSince;
  for (const [event, detail] of [['spawn_success', { spawnCwdExists: true }], ['first_output', undefined], ['new_output', undefined]] as const) {
    t.mock.timers.tick(5_000);
    session.transition(event, detail);
    await flushStatus();
  }

  assert.equal(session.state, 'RUNNING');
  assert.equal(session.toSnapshot().stateSince, startedAt);
  assert.equal(liveStateSinceByState.get('STARTING'), startedAt);
  assert.equal(liveStateSinceByState.get('RUNNING'), startedAt);
});
