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
        attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
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
