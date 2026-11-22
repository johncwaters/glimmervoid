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
import { createWargamesStore } from '../server/wargames/wargames-store.ts';

function buildSpec(): WargamesMatchSpec {
  const models = ['claude-opus-4-6', 'gpt-5.3-codex', 'kimi-k2.5', 'gemini-2.5-pro', 'claude-sonnet-4-6', 'o3'];
  return WargamesMatchSpec.parse({
    version: 1,
    title: 'Runner Integration Match',
    seed: 7777,
    tickDeadlineSeconds: 60,
    maxTicks: 5,
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
    const runner = createWargamesRunner({
      store,
      broadcast: (frame) => frames.push(frame),
      log: { log: () => {}, warn: () => {} },
      now: () => 1_700_000_100_000,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
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
    assert.equal(WARGAMES_TOOL_NAMES.length, 10);

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
    const propose = await runner.callTool(matchId, 's1', 'propose_contract', {
      terms: { kind: 'escrow', counterparty: 's2', proposerGives: { grain: 20, ore: 0 }, counterpartyGives: { grain: 0, ore: 20 } },
    });
    assert.equal(propose.ok, true);
    if (propose.ok) {
      const accept = await runner.callTool(matchId, 's2', 'accept_contract', { id: String(propose.payload.contractId) });
      assert.equal(accept.ok, true);
    }

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
      const reports = reportsReply.payload.reports as { payload: Record<string, unknown>; signature: string }[];
      assert.equal(reports.length, 1);
      const verified = await runner.callTool(matchId, 's1', 'verify_report', { report: reports[0] });
      assert.equal(verified.ok, true);
      if (verified.ok) assert.equal(verified.payload.valid, true);
      const forged = await runner.callTool(matchId, 's1', 'verify_report', {
        report: { payload: reports[0].payload, signature: 'tampered_signature' },
      });
      assert.equal(forged.ok, true);
      if (forged.ok) assert.equal(forged.payload.valid, false);
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

test('wargames runner fast-advances talk and contracts when all seats pass ready, wakes wait_for_change, and invokes lifecycle hooks', async () => {
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

    const waitingSeat = runner.callTool(matchId, 's1', 'get_state', { ready: true, wait_for_change: true });
    for (const seatId of ['s2', 's3', 's4', 's5', 's6'] as const) {
      await runner.callTool(matchId, seatId, 'get_state', { ready: true });
    }
    const woke = await waitingSeat;
    assert.equal(woke.ok, true);
    if (woke.ok) {
      const state = woke.payload.state as { tick: number; phase: string };
      assert.equal(state.tick, 1);
      assert.equal(state.phase, 'contracts');
    }
    assert.deepEqual(phaseEvents, ['1:talk', '1:contracts']);

    for (const seatId of WARGAMES_SEAT_IDS) {
      await runner.callTool(matchId, seatId, 'get_state', { ready: true });
    }
    assert.deepEqual(phaseEvents, ['1:talk', '1:contracts', '1:orders']);

    await runner.abortMatch(matchId, 'finished check');
    assert.equal(endedSessions.length, 6);
    runner.dispose();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
