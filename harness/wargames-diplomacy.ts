import './support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import WebSocket from 'ws';
import { z } from 'zod';

import { ImprovementKind } from '../shared/contracts/wargames.ts';
import type { WargamesEvent } from '../shared/contracts/wargames.ts';
import { diplomacyMetrics } from '../shared/wargames/analytics.ts';
import type { DiplomacyMetrics } from '../shared/wargames/analytics.ts';
import { replayMatch, replayMatchAtTick, territoryCountOf } from '../shared/wargames/engine.ts';
import type { MatchState } from '../shared/wargames/engine.ts';
import { createWargamesStore, wargamesDirectoryOf } from '../server/wargames/wargames-store.ts';
import { prepareIsolatedEnvironment } from './support/backend-harness.ts';

const LAB_DIRECTORY = path.join(os.homedir(), '.glimmervoid', 'wargames-lab');
const POLL_INTERVAL_MS = 15_000;
const MATCH_TIMEOUT_MS = 3 * 60 * 60 * 1000;

const LabSeat = z.strictObject({ label: z.string().min(1), agent: z.string().min(1), model: z.string().min(1), modelDisplay: z.string().min(1) });
const LabSeats = z.array(LabSeat).min(4).max(6);
type LabSeat = z.infer<typeof LabSeat>;

function readLabSeats(seatsPath: string): LabSeat[] {
  return LabSeats.parse(JSON.parse(fs.readFileSync(seatsPath, 'utf8')));
}

function readMatchLog(logPath: string): Promise<WargamesEvent[]> {
  const store = createWargamesStore({ directory: path.dirname(logPath), log: console });
  return store.readEvents(path.basename(logPath, '.jsonl'));
}

function formatNumber(value: number | null): string {
  if (value === null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function tableRows(metricsList: readonly DiplomacyMetrics[]): string[] {
  const header = '| match | ticks | msgs/seat/tick | public | proposed | accepted | kept | broken | support | coalitions | coalition mean | solo mean | betrayal swings | winner |';
  const divider = `|${'---|'.repeat(14)}`;
  const rows = metricsList.map((metrics) => {
    const winner = metrics.seats.find((seat) => seat.seatId === metrics.winnerSeatId);
    const winnerText = winner ? `${winner.seatId} ${winner.modelDisplay}${winner.isCoalitionMember ? ' (coalition)' : ''}` : '-';
    return `| ${metrics.matchId} | ${metrics.ticksPlayed} | ${formatNumber(metrics.messagesPerSeatPerTick)} | ${metrics.publicMessages} | ${metrics.contractsProposed} | ${metrics.contractsAccepted} | ${metrics.contractsKept} | ${metrics.contractsBroken} | ${metrics.supportMarches} | ${metrics.coalitions.join(' ') || '-'} | ${formatNumber(metrics.coalitionMeanStanding)} | ${formatNumber(metrics.soloMeanStanding)} | ${metrics.betrayalSwings} | ${winnerText} |`;
  });
  return [header, divider, ...rows];
}

const LAND_CHECK_TICK = 8;

function landRows(events: readonly WargamesEvent[]): string[] {
  const state = replayMatch(events);
  const atCheck: MatchState | null = state.tick >= LAND_CHECK_TICK ? replayMatchAtTick(events, LAND_CHECK_TICK) : null;
  const header = `| ${state.matchId} seat | marches to open hexes | improvement builds | first claim tick | land at tick ${LAND_CHECK_TICK} | land at end | improvement levels at end |`;
  const rows = state.seats.map(({ config: { seatId, modelDisplay } }) => {
    const orders = Object.values(state.ordersByTick).flatMap((ordersBySeat) => ordersBySeat[seatId] ?? []);
    const openMarches = orders.filter((order) => order.kind === 'march' && state.villages[order.toHexIndex] === null).length;
    const improvementBuilds = orders.filter((order) => order.kind === 'build' && ImprovementKind.safeParse(order.building).success).length;
    const claimTicks = state.reportsBySeat[seatId].flatMap((report) => (report.payload.kind === 'land' && report.payload.claimer === seatId ? [report.payload.tick] : []));
    const improvementLevels = [...state.territory.values()].filter((tile) => tile.owner === seatId).reduce((sum, tile) => sum + tile.level, 0);
    const landAtCheck = atCheck === null ? '-' : String(territoryCountOf(atCheck, seatId));
    return `| ${seatId} ${modelDisplay} | ${openMarches} | ${improvementBuilds} | ${claimTicks.length === 0 ? '-' : Math.min(...claimTicks)} | ${landAtCheck} | ${territoryCountOf(state, seatId)} | ${improvementLevels} |`;
  });
  return [header, `|${'---|'.repeat(7)}`, ...rows];
}

async function printReport(logPaths: readonly string[]): Promise<void> {
  const eventLists = (await Promise.all(logPaths.map(readMatchLog))).filter((events) => events.length > 0);
  const metricsList = eventLists.map((events) => diplomacyMetrics(replayMatch(events)));
  console.log(tableRows(metricsList).join('\n'));
  for (const events of eventLists) console.log(['', ...landRows(events)].join('\n'));
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function buildSpec(seats: readonly LabSeat[], seed: number, mapRadius: number, maxTicks: number) {
  return {
    version: 1,
    title: `Diplomacy lab ${seed}`,
    seed,
    mapRadius,
    maxTicks,
    tickDeadlineSeconds: 150,
    seats: seats.map((seat, index) => ({
      seatId: `s${index + 1}`,
      label: seat.label,
      setup: { agent: seat.agent, model: seat.model, options: [], instructions: '' },
      modelDisplay: seat.modelDisplay,
    })),
  };
}

interface ControlFrame {
  type?: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  matchId?: string;
}

async function runLiveMatch(seats: readonly LabSeat[], seed: number, mapRadius: number, maxTicks: number): Promise<string> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-wargames-lab-'));
  const isolated = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });
  const { createBackend } = await import('../server/backend/backend.ts');
  const httpServer = http.createServer();
  const backend = createBackend(httpServer, { staticDir: null });
  httpServer.on('request', backend.app);
  await new Promise<void>((resolve) => { httpServer.listen(isolated.port, '127.0.0.1', () => resolve()); });
  const { token } = await (await fetch(`http://127.0.0.1:${isolated.port}/control-token`)).json() as { token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${isolated.port}/control?token=${token}`, { origin: `http://127.0.0.1:${isolated.port}` });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const startReply = new Promise<ControlFrame>((resolve) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ControlFrame;
      if (frame.type === 'wargames-start-result') resolve(frame);
    });
  });
  socket.send(JSON.stringify({ type: 'wargames-start', requestId: 'lab-start', spec: buildSpec(seats, seed, mapRadius, maxTicks) }));
  const started = await startReply;
  if (!started.ok || !started.matchId) throw new Error(`match did not start: ${started.error ?? 'no match id'}`);
  console.log(`[lab] match ${started.matchId} started on port ${isolated.port}`);
  const logPath = path.join(wargamesDirectoryOf(isolated.isolatedHome), `${started.matchId}.jsonl`);
  const deadlineMs = Date.now() + MATCH_TIMEOUT_MS;
  let lastLine = '';
  while (Date.now() < deadlineMs) {
    await delay(POLL_INTERVAL_MS);
    const events = await readMatchLog(logPath);
    const lastEvent = events[events.length - 1];
    const state = replayMatch(events);
    const line = `[lab] tick ${state.tick} ${state.phase} ${state.status} events ${events.length}`;
    if (line !== lastLine) console.log(line);
    lastLine = line;
    if (state.status === 'finished' || lastEvent.type === 'match_aborted') break;
  }
  fs.mkdirSync(LAB_DIRECTORY, { recursive: true });
  const keptPath = path.join(LAB_DIRECTORY, `${started.matchId}.jsonl`);
  fs.copyFileSync(logPath, keptPath);
  socket.close();
  await backend.shutdown();
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  fs.rmSync(tempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return keptPath;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'report-only': { type: 'boolean', default: false },
      seed: { type: 'string', default: '20261124' },
      'map-radius': { type: 'string', default: '4' },
      'max-ticks': { type: 'string', default: '12' },
      seats: { type: 'string', default: path.join(LAB_DIRECTORY, 'seats.json') },
    },
  });
  if (values['report-only']) {
    fs.mkdirSync(LAB_DIRECTORY, { recursive: true });
    const logPaths = positionals.length > 0
      ? positionals
      : fs.readdirSync(LAB_DIRECTORY).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(LAB_DIRECTORY, name));
    await printReport(logPaths);
    return;
  }
  const keptPath = await runLiveMatch(readLabSeats(values.seats), Number(values.seed), Number(values['map-radius']), Number(values['max-ticks']));
  console.log(`[lab] log kept at ${keptPath}`);
  await printReport([keptPath]);
  process.exit(0);
}

await main();
