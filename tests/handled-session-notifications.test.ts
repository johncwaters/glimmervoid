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
import { STATES } from '../shared/states.ts';
import { countAttentionByKind, jumpTargetCount, orderAttentionLine } from '../public/attention-core.ts';
import { Session } from '../session/sessions.ts';

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
        { id: 'wargames-seat', name: 'Wargames - s1', path: directory, attentionOwner: 'wargames' },
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
    const [plainProject, childProject, contestantProject, wargamesProject] = configStore.config.projects;
    assert.ok(plainProject && childProject && contestantProject && wargamesProject);
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
    startWired(makeSession(childProject, configStore.config, { parent: { sessionId: 'plain-session', box: null } }));
    startWired(makeSession(contestantProject, configStore.config));
    startWired(makeSession(wargamesProject, configStore.config));

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
      { snapshot: 'wargames', card: 'wargames' },
    ]);
    const focusRows = sessions.map((session) => ({
      id: session.id,
      name: session.name,
      state: STATES.WAITING,
      unseenOutcome: null,
      attentionOwner: session.attentionOwner,
    }));
    assert.deepEqual(orderAttentionLine(focusRows, null).map(({ id }) => id), ['plain-session']);
    assert.equal(jumpTargetCount(countAttentionByKind(focusRows)), 1);
  } finally {
    for (const session of sessions) session.destroy();
    await configStore?.idle();
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a finished turn keeps its notification through an idle compaction whose PreCompact arrives long after the title turns working', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const config = { projects: [] };
  const acknowledged: string[] = [];
  const session = new Session({ id: 'late-compaction', name: 'late-compaction', path: process.cwd(), statusConflictMs: 20, statusDedupMs: 10 });
  context.after(() => session.destroy());
  createSessionEventWiring({
    configStore: { save: (mutate) => { mutate(config); return config; } }, config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: (id) => { acknowledged.push(id); }, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  session._hooksReportPrompts = true;
  session.state = STATES.IDLE;
  session.ingestHookSignal({ signal: 'resume', source: 'hook', event: 'UserPromptSubmit', payload: {}, ts: Date.now() });
  session.ingestHookSignal({ signal: 'ready', source: 'hook', event: 'Stop', payload: {}, ts: Date.now() });
  context.mock.timers.tick(1_000);
  assert.equal(session.state, STATES.COMPLETE);
  acknowledged.length = 0;

  session._titleSource.feed('\x1b]0;⠂ Claude Code\x07');
  context.mock.timers.tick(15_000);
  session.ingestHookSignal({ signal: 'compaction-start', source: 'hook', event: 'PreCompact', payload: {}, ts: Date.now() });
  context.mock.timers.tick(1_000);
  session.ingestHookSignal({ signal: 'compaction-end', source: 'hook', event: 'PostCompact', payload: {}, ts: Date.now() });
  context.mock.timers.tick(1_000);

  assert.equal(session.state, STATES.COMPLETE);
  assert.deepEqual(acknowledged, []);
});
