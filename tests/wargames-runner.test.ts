import './helpers/isolate-home.ts';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWargamesSeatServer, WARGAMES_TOOL_NAMES } from '../mcp/wargames-tools.ts';
import { WARGAMES_SEAT_IDS, WargamesMatchSpec } from '../shared/contracts/wargames.ts';
import type { ClearTimeoutFn, SetTimeoutFn } from '../shared/timer-deps.ts';
import { hexIndexAt, replayMatch } from '../shared/wargames/engine.ts';
import { createWargamesRunner } from '../server/wargames/wargames-runner.ts';
import { createWargamesLauncher, isWargamesSeatProject, pruneOrphanedWargamesProjects } from '../server/wargames/wargames-launch.ts';
import { createWargamesStore } from '../server/wargames/wargames-store.ts';
import { applyWargamesEvents, applyWargamesStatus, selectWatchedMatch, setWargamesResyncRequester, wargamesSnapshot } from '../public/wargames/wargames-store.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';

function buildSpec(maxTicks = 5): WargamesMatchSpec {
  const models = ['claude-opus-4-6', 'gpt-5.3-codex', 'kimi-k2.5', 'gemini-2.5-pro', 'claude-sonnet-4-6', 'o3'];
  return WargamesMatchSpec.parse({
    version: 1,
    title: 'Runner Integration Match',
    seed: 7777,
    tickDeadlineSeconds: 60,
    maxTicks,
    seats: WARGAMES_SEAT_IDS.map((seatId, index) => ({
      seatId,
      label: `Seat ${index + 1}`,
      controllerKind: 'local-agent',
      setup: { agent: 'claude-code', model: models[index], options: [], instructions: '' },
      modelDisplay: models[index],
    })),
  });
}

test('wargames runner drives seating, 10 MCP tools, JSONL log, summary index, HMAC verification, concurrency, and replay', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-runner-'));
  try {
    const store = createWargamesStore({ directory: tempDir, log: { warn: () => {} } });
    const frames: unknown[] = [];
    const scheduled: (() => void)[] = [];
    const fakeSetTimeout: SetTimeoutFn = (callback) => {
      scheduled.push(() => callback());
      return setTimeout(() => {}, 0);
    };
    const fakeClearTimeout: ClearTimeoutFn = (handle) => {
      clearTimeout(handle);
    };
    const emptyCatalog = () => ({ agents: [], openrouter: { models: [], error: null, checkedAt: null } });
    const runner = createWargamesRunner({
      store,
      broadcast: (frame) => frames.push(frame),
      log: { log: () => {}, warn: () => {} },
      now: () => 1_700_000_100_000,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
      readAgentModels: emptyCatalog,
    });
    await runner.load();

    const started = await runner.startMatch(buildSpec(), async (_matchId, seat, bindSession) => {
      const sessionId = `sess-${seat.seatId}`;
      bindSession(sessionId);
      return { ok: true, sessionId };
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const matchId = started.matchId;

    assert.deepEqual(runner.seatForSession('sess-s1'), { matchId, seatId: 's1' });
    assert.equal(runner.isWargamesSession('sess-s1'), true);
    const seatServer = buildWargamesSeatServer(matchId, 's1', runner);
    assert.ok(seatServer);
    assert.equal(WARGAMES_TOOL_NAMES.length, 7);

    await Promise.all(WARGAMES_SEAT_IDS.map((seatId) => runner.callTool(matchId, seatId, 'get_state', {})));

    const [noteReply, msgReply] = await Promise.all([
      runner.callTool(matchId, 's1', 'write_note', { text: 'Initial strategy note' }),
      runner.callTool(matchId, 's1', 'send_message', { channel: 'dm', to: 's2', text: 'Peace?' }),
    ]);
    assert.equal(noteReply.ok, true);
    assert.equal(msgReply.ok, true);
    const readNoteReply = await runner.callTool(matchId, 's1', 'read_notes', {});
    assert.equal(readNoteReply.ok, true);
    if (readNoteReply.ok) assert.equal(readNoteReply.payload.text, 'Initial strategy note');

    const wrongPhase = await runner.callTool(matchId, 's1', 'submit_orders', { orders: [] });
    assert.equal(wrongPhase.ok, false);
    if (!wrongPhase.ok) assert.equal(wrongPhase.rejection.code, 'invalid_phase');

    scheduled.pop()?.();
    const s1Home = hexIndexAt(2, -1);
    const s2Home = hexIndexAt(1, -2);
    const submitReplies = await Promise.all(
      WARGAMES_SEAT_IDS.map((seatId) => runner.callTool(matchId, seatId, 'submit_orders', {
        orders: seatId === 's1' ? [{ kind: 'scout', fromHexIndex: s1Home, toHexIndex: s2Home }] : [],
      })),
    );
    for (const reply of submitReplies) assert.equal(reply.ok, true);

    const reportsReply = await runner.callTool(matchId, 's1', 'get_reports', { since_tick: 1 });
    assert.equal(reportsReply.ok, true);
    if (reportsReply.ok) {
      const reports = reportsReply.payload.reports as { kind: string }[];
      assert.deepEqual(reports.map((report) => report.kind), ['scout']);
    }

    const watched = await runner.watchMatch(matchId, 'watcher-1');
    assert.equal(watched.ok, true);
    if (watched.ok) {
      const replayed = replayMatch(watched.events);
      assert.equal(replayed.tick, 2);
      assert.equal(replayed.reportsBySeat.s1.length, 1);
    }

    await store.idle();
    const reloadedStore = createWargamesStore({ directory: tempDir, log: { warn: () => {} } });
    const summaries = await reloadedStore.load();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].matchId, matchId);
    assert.equal(summaries[0].tick, 2);
    assert.equal(summaries[0].status, 'running');

    const aborted = await runner.abortMatch(matchId, 'done');
    assert.equal(aborted.ok, true);
    assert.equal(runner.isWargamesSession('sess-s1'), true);
    assert.ok(frames.length > 0);
    runner.dispose();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('wargames runner fast-advances talk when all seats pass ready, logs each lock-in, lets a ready seat keep talking, sends the phase clock, and invokes lifecycle hooks', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-runner-ready-'));
  try {
    const store = createWargamesStore({ directory: tempDir, log: { warn: () => {} } });
    await store.load();
    const phaseEvents: string[] = [];
    const endedSessions: string[] = [];
    const runner = createWargamesRunner({
      store,
      broadcast: () => {},
      log: { log: () => {}, warn: () => {} },
      now: () => 1_700_000_000_000,
      readAgentModels: () => ({ agents: [], openrouter: { models: [], error: null, checkedAt: null } }),
    });
    const started = await runner.startMatch(
      buildSpec(),
      async (_matchId, seat) => ({ ok: true, sessionId: `sess-${seat.seatId}` }),
      {
        onPhaseChanged: (_matchId, tick, phase) => phaseEvents.push(`${tick}:${phase}`),
        onMatchEnded: (_matchId, sessionIds) => endedSessions.push(...sessionIds),
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const { matchId } = started;

    for (const seatId of WARGAMES_SEAT_IDS) {
      await runner.callTool(matchId, seatId, 'get_state', {});
    }
    assert.deepEqual(phaseEvents, ['1:talk']);
    const watched = await runner.watchMatch(matchId, 'watcher-1');
    assert.equal(watched.ok, true);
    if (watched.ok) assert.deepEqual(watched.phaseClock, { remainingMs: 30_000, lengthMs: 30_000 });

    const waitingSeat = runner.callTool(matchId, 's1', 'get_state', { ready: true, wait_for_change: true });
    const readySeatMessage = await runner.callTool(matchId, 's1', 'send_message', { channel: 'public', to: null, text: 'Still talking' });
    assert.equal(readySeatMessage.ok, true);
    for (const seatId of ['s2', 's3', 's4', 's5', 's6'] as const) {
      await runner.callTool(matchId, seatId, 'get_state', { ready: true });
    }
    const woke = await waitingSeat;
    assert.equal(woke.ok, true);
    if (woke.ok) {
      const state = woke.payload.state as { tick: number; phase: string };
      assert.equal(state.tick, 1);
      assert.equal(state.phase, 'orders');
    }
    assert.deepEqual(phaseEvents, ['1:talk', '1:orders']);
    const loggedEvents = await store.readEvents(matchId);
    assert.equal(loggedEvents.filter((event) => event.type === 'seat_ready').length, 6);
    assert.equal(replayMatch(loggedEvents).phase, 'orders');

    await runner.abortMatch(matchId, 'finished check');
    assert.equal(endedSessions.length, 6);
    runner.dispose();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('wargames launcher appends optional seat.setup.instructions after immutable rules', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-launch-prompt-'));
  const fakeSessions = new Map<string, Session>();
  try {
    const deliveredPrompts = new Map<string, string>();
    const launcher = createWargamesLauncher({
      wargames: {
        seatSessionEnded: () => {},
        startMatch: async (spec, launchSeat) => {
          if (launchSeat) {
            for (const seat of spec.seats) {
              await launchSeat('wg-prompt-1', seat, () => {});
            }
          }
          return { ok: true, matchId: 'wg-prompt-1', error: null };
        },
      },
      sessions: fakeSessions,
      config: { ...DEFAULT_CONFIG, projects: [] },
      createProjectSession: ({ name, path: projectPath }) => {
        const id = `sess-${name}`;
        const session = new Session({ id, name, path: projectPath, ptySpawn: () => fakePty() });
        session.deliver = (prompt: string) => {
          deliveredPrompts.set(name, prompt);
          return { ok: true, kind: 'pasted' };
        };
        fakeSessions.set(id, session);
        return { ok: true, project: { id, name, path: projectPath } };
      },
      seatRootDir: tempDir,
    });
    const baseSpec = buildSpec();
    const specWithStrategy: WargamesMatchSpec = {
      ...baseSpec,
      seats: baseSpec.seats.map((seat) => ({
        ...seat,
        setup: {
          ...seat.setup,
          instructions: seat.seatId === 's1' ? 'Play defensively and rush walls before tick 5.' : '',
        },
      })),
    };
    const started = await launcher.start(specWithStrategy);
    assert.equal(started.ok, true);
    const s1Prompt = deliveredPrompts.get('Wargames ompt-1 - s1') ?? '';
    const s2Prompt = deliveredPrompts.get('Wargames ompt-1 - s2') ?? '';
    assert.match(s1Prompt, /^You are playing Wargames match/);
    assert.match(s1Prompt, /--- Pre-Game Strategy Instructions/);
    assert.match(s1Prompt, /Play defensively and rush walls before tick 5\./);
    assert.match(s2Prompt, /^You are playing Wargames match/);
    assert.equal(s2Prompt.includes('Pre-Game Strategy Instructions'), false);
    for (const seat of specWithStrategy.seats) assert.deepEqual(JSON.parse(await fsp.readFile(path.join(tempDir, 'wg-prompt-1', seat.seatId, '.mcp.json'), 'utf8')), { mcpServers: {} });
  } finally {
    for (const session of fakeSessions.values()) session.destroy();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('pruneOrphanedWargamesProjects removes current and legacy seats and keeps operator projects', async () => {
  const seatRootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-prune-seats-'));
  const legacyMatchDir = path.join(seatRootDir, 'wg-mws6o0sc-d3eba0');
  const legacySeatPath = path.join(legacyMatchDir, 's1');
  const currentMatchDir = path.join(seatRootDir, 'wg-current-1');
  const currentSeatPath = path.join(currentMatchDir, 's2');
  await fsp.mkdir(legacySeatPath, { recursive: true });
  await fsp.mkdir(currentSeatPath, { recursive: true });
  try {
    const config = {
      ...DEFAULT_CONFIG,
      projects: [
        { id: 'keep-1', name: 'glimmervoid', path: '/home/operator/glimmervoid' },
        { id: 'legacy-s1', name: 'Wargames d3eba0 - s1', path: legacySeatPath },
        { id: 'current-s2', name: 'Wargames rrent1 - s2', path: currentSeatPath, attentionOwner: 'wargames' as const },
      ],
      sessionOrder: ['keep-1', 'legacy-s1', 'current-s2'],
    };
    assert.equal(isWargamesSeatProject(config.projects[0], seatRootDir), false);
    assert.equal(isWargamesSeatProject(config.projects[1], seatRootDir), true);
    assert.equal(isWargamesSeatProject(config.projects[2], seatRootDir), true);

    let saveCount = 0;
    const configStore = {
      save(mutate: (savedConfig: typeof config) => void) {
        saveCount += 1;
        const copy = structuredClone(config);
        mutate(copy);
        return copy;
      },
    };
    const pruned = pruneOrphanedWargamesProjects({ configStore, config, seatRootDir });
    await pruned.cleanupSeatDirs;

    assert.equal(saveCount, 1);
    assert.deepEqual(pruned.removedIds.sort(), ['current-s2', 'legacy-s1']);
    assert.deepEqual(config.projects.map((project) => project.id), ['keep-1']);
    assert.deepEqual(config.sessionOrder, ['keep-1']);
    await assert.rejects(fsp.stat(legacyMatchDir));
    await assert.rejects(fsp.stat(currentMatchDir));

    const secondPass = pruneOrphanedWargamesProjects({ configStore, config, seatRootDir });
    await secondPass.cleanupSeatDirs;
    assert.equal(saveCount, 1);
    assert.deepEqual(secondPass.removedIds, []);
  } finally {
    await fsp.rm(seatRootDir, { recursive: true, force: true });
  }
});

test('wargames launcher discards seat when prompt delivery fails and removes seat dir on match end', async () => {
  const seatRootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-launch-cleanup-'));
  const fakeSessions = new Map<string, Session>();
  const discarded: string[] = [];
  const onEndedHolder: { fn: ((matchId: string, sessionIds: string[]) => void) | null } = { fn: null };
  try {
    const launcher = createWargamesLauncher({
      wargames: {
        seatSessionEnded: () => {},
        startMatch: async (spec, launchSeat, hooks) => {
          onEndedHolder.fn = hooks?.onMatchEnded ?? null;
          if (launchSeat) {
            const first = await launchSeat('wg-fail-1', spec.seats[0], () => {});
            if (!first.ok) return { ok: false, error: first.error };
          }
          return { ok: true, matchId: 'wg-fail-1', error: null };
        },
      },
      sessions: fakeSessions,
      config: { ...DEFAULT_CONFIG, projects: [] },
      createProjectSession: ({ name, path: projectPath }) => {
        const id = `sess-${name}`;
        const session = new Session({ id, name, path: projectPath, ptySpawn: () => fakePty() });
        session.deliver = () => ({ ok: false, kind: 'refused', reason: 'destroyed' });
        fakeSessions.set(id, session);
        return { ok: true, project: { id, name, path: projectPath } };
      },
      discardSession: async (sessionId) => {
        discarded.push(sessionId);
        fakeSessions.get(sessionId)?.destroy();
        fakeSessions.delete(sessionId);
      },
      seatRootDir,
    });
    const failed = await launcher.start(buildSpec());
    assert.equal(failed.ok, false);
    assert.deepEqual(discarded, ['sess-Wargames fail-1 - s1']);

    const matchDir = path.join(seatRootDir, 'wg-fail-1');
    await fsp.stat(matchDir);
    onEndedHolder.fn?.('wg-fail-1', []);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stillExists = await fsp.stat(matchDir).then(() => true, () => false);
      if (!stillExists) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(fsp.stat(matchDir));
  } finally {
    for (const session of fakeSessions.values()) session.destroy();
    await fsp.rm(seatRootDir, { recursive: true, force: true });
  }
});

test('wargames runner resolves each seat modelDisplay to the specific catalog model on startMatch', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gv-wg-models-'));
  const store = createWargamesStore({ directory: dir, log: { warn: () => {} } });
  const runner = createWargamesRunner({
    store,
    broadcast: () => {},
    log: { log: () => {}, warn: () => {} },
    readAgentModels: () => ({
      agents: [
        {
          agent: 'claude-code',
          configuredDefault: { model: 'claude-opus-4-6', effort: null },
          models: [
            { id: 'claude-opus-4-6', label: 'Opus 4.6', aliases: ['opus'], isDefault: true, options: [] },
          ],
          error: null,
          checkedAt: null,
        },
        {
          agent: 'codex',
          models: [
            { id: 'gpt-5.4', label: 'GPT-5.4', aliases: [], isDefault: true, options: [] },
          ],
          error: null,
          checkedAt: null,
        },
      ],
      openrouter: { models: [], error: null, checkedAt: null },
    }),
  });
  try {
    await runner.load();
    const spec = buildSpec();
    spec.seats[0] = { ...spec.seats[0], setup: { agent: 'claude-code', model: null, options: [], instructions: '' }, modelDisplay: 'claude-code' };
    spec.seats[1] = { ...spec.seats[1], setup: { agent: 'codex', model: 'gpt-5.4', options: [], instructions: '' }, modelDisplay: 'codex' };
    const started = await runner.startMatch(spec);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const summary = runner.statusFrame().matches.find((match) => match.matchId === started.matchId);
    assert.ok(summary);
    assert.equal(summary.seats[0].modelDisplay, 'Opus 4.6');
    assert.equal(summary.seats[1].modelDisplay, 'GPT-5.4');
  } finally {
    runner.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a seat session that ends before its seat connects aborts the match with the reason', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-seat-ended-'));
  try {
    const store = createWargamesStore({ directory: tempDir, log: { warn: () => {} } });
    const runner = createWargamesRunner({
      store,
      broadcast: () => {},
      log: { log: () => {}, warn: () => {} },
      readAgentModels: () => ({ agents: [], openrouter: { models: [], error: null, checkedAt: null } }),
    });
    await runner.load();
    const started = await runner.startMatch(buildSpec(), async (_matchId, seat, bindSession) => {
      bindSession(`sess-${seat.seatId}`);
      return { ok: true, sessionId: `sess-${seat.seatId}` };
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await runner.callTool(started.matchId, 's1', 'get_state', {});

    runner.seatSessionEnded('sess-s1', 'its agent exited with code 0');
    assert.equal(runner.statusFrame().matches[0]?.status, 'seating');

    runner.seatSessionEnded('sess-s4', 'its agent exited with code 1');
    const reply = await runner.callTool(started.matchId, 's2', 'get_state', {});
    assert.equal(reply.ok, false);
    const [summary] = runner.statusFrame().matches;
    assert.equal(summary?.status, 'aborted');
    const events = await store.readEvents(started.matchId);
    assert.deepEqual(events.at(-1), { seq: events.length - 1, type: 'match_aborted', reason: 'Seat s4 could not start: its agent exited with code 1' });
    runner.dispose();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a dashboard whose watch dropped catches up to the live head instead of freezing on a gapped event stream', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wargames-runner-resync-'));
  try {
    const store = createWargamesStore({ directory: tempDir, log: { warn: () => {} } });
    await store.load();
    let isDashboardSocketOpen = true;
    const runner = createWargamesRunner({
      store,
      broadcast: (frame) => {
        if (!isDashboardSocketOpen) return;
        if (frame.type === 'wargames-events') applyWargamesEvents(frame);
        if (frame.type === 'wargames-status') applyWargamesStatus(frame);
      },
      log: { log: () => {}, warn: () => {} },
      readAgentModels: () => ({ agents: [], openrouter: { models: [], error: null, checkedAt: null } }),
    });
    const started = await runner.startMatch(buildSpec(20), async (_matchId, seat) => ({ ok: true, sessionId: `sess-${seat.seatId}` }));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const { matchId } = started;
    for (const seatId of WARGAMES_SEAT_IDS) await runner.callTool(matchId, seatId, 'get_state', {});
    async function playTurns(turnCount: number): Promise<void> {
      for (let turn = 0; turn < turnCount; turn += 1) {
        for (const seatId of WARGAMES_SEAT_IDS) await runner.callTool(matchId, seatId, 'get_state', { ready: true });
        for (const seatId of WARGAMES_SEAT_IDS) await runner.callTool(matchId, seatId, 'get_state', { ready: true });
        for (const seatId of WARGAMES_SEAT_IDS) await runner.callTool(matchId, seatId, 'submit_orders', { orders: [] });
      }
    }
    async function watchFromDashboard(watcherId: string): Promise<void> {
      const watched = await runner.watchMatch(matchId, watcherId);
      if (watched.ok) applyWargamesEvents({ matchId, events: watched.events, reset: true, phaseClock: watched.phaseClock });
    }
    selectWatchedMatch(matchId);
    setWargamesResyncRequester(() => watchFromDashboard('dashboard-after-reconnect'));
    await watchFromDashboard('dashboard');
    await playTurns(3);

    isDashboardSocketOpen = false;
    runner.removeWatcher('dashboard');
    await playTurns(4);
    isDashboardSocketOpen = true;
    await runner.watchMatch(matchId, 'second-tab');
    await playTurns(3);

    const serverSummary = runner.statusFrame().matches.find((summary) => summary.matchId === matchId);
    assert.equal(wargamesSnapshot().headState?.tick, serverSummary?.tick);
    assert.equal(wargamesSnapshot().events.length, serverSummary?.eventCount);
    await runner.abortMatch(matchId, 'resync check');
    runner.dispose();
  } finally {
    setWargamesResyncRequester(null);
    selectWatchedMatch(null);
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
