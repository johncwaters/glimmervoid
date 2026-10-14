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
import { mergeSessionPrLink, seedSessionPrLinks } from '../session/core/session-pr-links-core.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';
import { SESSION_PR_LINKS_MAX } from '../shared/contracts/my-prs.ts';
import type { LinkedPr } from '../shared/contracts/my-prs.ts';
import type { Session } from '../session/sessions.ts';

function linkedPr(number: number, linkedAt: number, source: LinkedPr['source'] = 'hook'): LinkedPr {
  return { repo: 'PostHog/glimmervoid', number, url: `https://github.com/PostHog/glimmervoid/pull/${number}`, source, linkedAt };
}

test('one link per repo#number where the first source keeps its linkedAt', () => {
  const firstLinked = mergeSessionPrLink(seedSessionPrLinks(undefined), linkedPr(7, 100, 'hook'));
  const relinked = mergeSessionPrLink(firstLinked, linkedPr(7, 500, 'sha'));
  assert.equal(relinked, firstLinked);
  assert.deepEqual(relinked.links, [linkedPr(7, 100, 'hook')]);
  assert.equal(mergeSessionPrLink(firstLinked, { ...linkedPr(7, 600, 'manual'), repo: 'posthog/glimmervoid' }), firstLinked);
});

test('an unlinked key is refused so it is never auto relinked', () => {
  const unlinked = { links: [], unlinkedKeys: ['PostHog/glimmervoid#7'] };
  assert.equal(mergeSessionPrLink(unlinked, linkedPr(7, 100)), unlinked);
  assert.equal(mergeSessionPrLink({ links: [], unlinkedKeys: ['posthog/glimmervoid#7'] }, linkedPr(7, 100)).links.length, 0);
});

test('the stored list keeps only the newest links, newest first', () => {
  let state = seedSessionPrLinks(undefined);
  for (let number = 1; number <= SESSION_PR_LINKS_MAX + 5; number++) state = mergeSessionPrLink(state, linkedPr(number, number * 10));
  assert.equal(state.links.length, SESSION_PR_LINKS_MAX);
  assert.equal(state.links[0].number, SESSION_PR_LINKS_MAX + 5);
  assert.equal(state.links.at(-1)?.number, 6);
  assert.equal(mergeSessionPrLink(state, linkedPr(99, 1)), state);
});

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
        notificationManager: { acknowledge: () => {}, trigger: () => {} },
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
