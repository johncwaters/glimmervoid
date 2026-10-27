import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { LinkedPr } from '../shared/contracts/my-prs.ts';
import type { Session } from '../session/sessions.ts';

function linkedPr(number: number, linkedAt: number, source: LinkedPr['source'] = 'hook'): LinkedPr {
  return { repo: 'PostHog/glimmervoid', number, url: `https://github.com/PostHog/glimmervoid/pull/${number}`, source, linkedAt };
}

test('linked PRs persist on the project entry, broadcast on change and survive a restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-pr-links-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const sessions: Session[] = [];
  const stores: ConfigStore[] = [];
  const broadcasts: ControlMessageRecord[] = [];
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    await writeFile(configPath, JSON.stringify({ recordSignals: false, projects: [{ id: 'pr-links-session', name: 'project', path: directory }] }));
    const makeSession = createSessionFactory({
      configStore: { configPath }, hookRouter: null, getHookPort: () => null,
      getGitWorkspace: () => null, getPlanReviewPort: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    const startWiredSession = () => {
      const store = createConfigStore();
      stores.push(store);
      const session = makeSession(store.config.projects[0], store.config);
      sessions.push(session);
      createSessionEventWiring({
        configStore: store, config: store.config, recordLane: () => {},
        usage: { refreshSessions: () => {}, nudgeSession: () => {} },
        broadcastControl: (message) => { broadcasts.push(message); },
        telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
        notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
        getIngestLane: () => null, tapIngestForSession: () => {}, closeSessionDataClients: () => {},
        logger: { error: () => {}, log: () => {}, warn: () => {} },
      })(session);
      return { store, session };
    };
    const first = startWiredSession();
    first.session.linkPr(linkedPr(42, 1000));
    first.session.linkPr(linkedPr(42, 2000, 'sha'));
    const prBroadcasts = broadcasts.filter((message) => message.type === 'session-prs');
    assert.equal(prBroadcasts.length, 1);
    assert.equal(ServerMessage.safeParse(prBroadcasts[0]).success, true);
    await first.store.idle();
    first.session.destroy();

    const restored = startWiredSession();
    assert.deepEqual(restored.session.linkedPrs, [linkedPr(42, 1000)]);
    assert.deepEqual(projectSessionCard(restored.session, { id: 'pr-links-session', name: 'project' }).linkedPrs, [linkedPr(42, 1000)]);
  } finally {
    for (const session of sessions) session.destroy();
    await Promise.all(stores.map((store) => store.idle()));
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});
