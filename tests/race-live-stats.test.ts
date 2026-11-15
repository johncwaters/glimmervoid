import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { DiffStats, RaceRecord } from '../shared/contracts/race.ts';
import { createRaceStore } from '../server/race/race-store.ts';
import { createRaceWiring } from '../server/race/race-wiring.ts';

const quietLog = { log: () => {}, warn: () => {} };
const setup = { agent: 'claude-code', model: null, options: [], instructions: '' };

function runningRace(id: string): RaceRecord {
  return {
    id,
    spec: { version: 1, title: 'Fix add', prompt: 'Fix add.', repoPath: '/repo', judges: [], timeLimitMinutes: null, rounds: 1, reviewCase: null, check: null, contestants: [{ id: 'one', label: 'One', setup, home: 'operator' }, { id: 'two', label: 'Two', setup, home: 'operator' }] },
    startSha: 'a'.repeat(40), baseBranch: 'main', createdAt: 1, phase: 'running', diffStatsByContestant: {}, checkByContestant: {}, metricsByContestant: {}, finishByContestant: {}, judge: null, panel: null, judgeError: null, recallByContestant: {}, winnerContestantId: null, series: null,
    sessionIdByContestant: { one: 'session-one', two: 'session-two' },
  };
}

async function wiringWith(record: RaceRecord, statsOf: (args: { worktreeDir: string; startSha: string }) => Promise<{ ok: true; stats: DiffStats } | { ok: false; reason: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'race-live-stats-'));
  const store = createRaceStore({ directory: path.join(root, 'races'), log: quietLog });
  await store.write(record);
  const broadcasts: RaceRecord[][] = [];
  const wiring = createRaceWiring({
    store, git: { fetchOrigin: async () => ({ ok: true }), listIntegrationTips: async () => ({ ok: false }) },
    integrationBranch: () => null, broadcast: (frame) => { if (frame.type === 'race-status') broadcasts.push(frame.races); }, log: quietLog,
    worktreeOf: (sessionId) => (sessionId === 'session-two' ? null : `/worktrees/${sessionId}`),
    statsOf, judgeRoot: path.join(root, 'judges'),
  });
  await wiring.loadRaces([record.id]);
  return { wiring, broadcasts };
}

test('a running race shows each live contestant diff size, and broadcasts only when it changes', async () => {
  let linesAdded = 3;
  const { wiring, broadcasts } = await wiringWith(runningRace('race-live'), async ({ worktreeDir, startSha }) => {
    assert.equal(worktreeDir, '/worktrees/session-one');
    assert.equal(startSha, 'a'.repeat(40));
    return { ok: true, stats: { filesChanged: 1, linesAdded, linesRemoved: 1 } };
  });
  const before = broadcasts.length;
  await wiring.refreshLiveStats();
  assert.deepEqual(wiring.status().races[0]?.diffStatsByContestant, { one: { filesChanged: 1, linesAdded: 3, linesRemoved: 1 } }, 'a contestant without a checkout gets no live stats');
  assert.equal(broadcasts.length, before + 1);
  await wiring.refreshLiveStats();
  assert.equal(broadcasts.length, before + 1, 'unchanged stats send no frame');
  linesAdded = 9;
  await wiring.refreshLiveStats();
  assert.equal(wiring.status().races[0]?.diffStatsByContestant.one?.linesAdded, 9);
  assert.equal(broadcasts.length, before + 2);
});

test('live stats never overwrite a race that began judging while they were measured', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { wiring } = await wiringWith({ ...runningRace('race-judging'), spec: { ...runningRace('race-judging').spec } }, async () => {
    await gate;
    return { ok: true, stats: { filesChanged: 5, linesAdded: 50, linesRemoved: 5 } };
  });
  const refreshing = wiring.refreshLiveStats();
  await wiring.judge('race-judging');
  release();
  await refreshing;
  assert.deepEqual(wiring.status().races[0]?.diffStatsByContestant.one, undefined);
});

test('a race with a winner is not measured', async () => {
  let calls = 0;
  const { wiring } = await wiringWith({ ...runningRace('race-won'), winnerContestantId: 'one' }, async () => {
    calls += 1;
    return { ok: true, stats: { filesChanged: 1, linesAdded: 1, linesRemoved: 0 } };
  });
  await wiring.refreshLiveStats();
  assert.equal(calls, 0);
});
