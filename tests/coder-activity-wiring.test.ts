import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoderActivityPoller } from '../server/coder-activity-poller.ts';
import type { CoderActivityPoller, CoderActivityReport } from '../server/coder-activity-poller.ts';
import { createCoderActivityReporter, createCoderActivityWiring } from '../server/coder-activity-wiring.ts';
import {
  CODER_ACTIVITY_HEARTBEAT_MS, CODER_ACTIVITY_RETRY_MAX_WAIT_MS, CODER_ACTIVITY_STOPPED_MESSAGE, CODER_ACTIVITY_TICK_INTERVAL_MS,
} from '../server/core/coder-activity-core.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { waitFor } from './helpers/wait-for.ts';

function createTimers() {
  const scheduled: { callback: () => void; delayMs: number; handle: NodeJS.Timeout }[] = [];
  const cleared: NodeJS.Timeout[] = [];
  const schedule = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const handle = setTimeout(() => {}, 3_600_000);
    handle.unref();
    scheduled.push({ callback, delayMs, handle });
    return handle;
  };
  const clear = (handle: NodeJS.Timeout) => {
    clearTimeout(handle);
    cleared.push(handle);
  };
  return { scheduled, cleared, setIntervalFn: schedule, setTimeoutFn: schedule, clearIntervalFn: clear, clearTimeoutFn: clear };
}

async function createCoderServer() {
  const requests: { method: string | undefined; url: string | undefined; token: string | string[] | undefined; contentType: string | undefined; body: unknown }[] = [];
  const response = { status: 200, message: '' };
  const server = http.createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method, url: request.url, token: request.headers['coder-session-token'], contentType: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    reply.writeHead(response.status, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify({ message: response.message }));
  });
  const port = await listenOnLoopback(server);
  return { requests, response, agentUrl: `http://127.0.0.1:${port}/ignored-base`, close: () => closeServer(server) };
}

test('real activity reports use the agent PATCH contract and heartbeat cadence', async (context) => {
  const coder = await createCoderServer();
  context.after(coder.close);
  let currentTime = 0;
  let runningSessionCount = 1;
  const timers = createTimers();
  const lines: string[] = [];
  const poller = createCoderActivityPoller({
    ...timers,
    now: () => currentTime,
    countRunningSessions: () => runningSessionCount,
    reportStatus: createCoderActivityReporter({ appSlug: 'glimmervoid', env: { CODER_AGENT_URL: coder.agentUrl, CODER_AGENT_TOKEN: 'agent-secret' } }),
    log: { warn: (line: string) => lines.push(line) },
  });
  context.after(poller.stop);
  await poller.start();
  assert.equal(timers.scheduled[0]?.delayMs, CODER_ACTIVITY_TICK_INTERVAL_MS);
  assert.deepEqual(coder.requests[0], {
    method: 'PATCH', url: '/api/v2/workspaceagents/me/app-status', token: 'agent-secret', contentType: 'application/json',
    body: { app_slug: 'glimmervoid', state: 'working', message: '1 Glimmervoid session running' },
  });
  currentTime = CODER_ACTIVITY_HEARTBEAT_MS - 1;
  await poller.tick();
  assert.equal(coder.requests.length, 1);
  currentTime += 1;
  runningSessionCount = 3;
  await poller.tick();
  assert.deepEqual(coder.requests[1]?.body, { app_slug: 'glimmervoid', state: 'working', message: '3 Glimmervoid sessions running' });
  runningSessionCount = 0;
  await poller.tick();
  await poller.tick();
  assert.deepEqual(coder.requests[2]?.body, { app_slug: 'glimmervoid', state: 'idle', message: 'No Glimmervoid sessions running' });
  assert.equal(coder.requests.length, 3);
  assert.deepEqual(lines, []);
  await poller.stop();
  assert.deepEqual(timers.cleared, timers.scheduled.map((entry) => entry.handle));
});

test('a rejected report backs off without advancing the last successful state or exposing the token', async (context) => {
  const coder = await createCoderServer();
  context.after(coder.close);
  const agentToken = 'private-agent-token';
  const reporter = createCoderActivityReporter({ appSlug: 'missing-app', env: { CODER_AGENT_URL: coder.agentUrl, CODER_AGENT_TOKEN: agentToken } });
  coder.response.status = 400;
  coder.response.message = `No app found with slug ${agentToken}`;
  await assert.rejects(reporter({ state: 'working', message: '1 Glimmervoid session running' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /400.*No app found with slug/);
    assert.equal(error.message.includes(agentToken), false);
    return true;
  });
  let currentTime = 0;
  let runningSessionCount = 1;
  const lines: string[] = [];
  const poller = createCoderActivityPoller({
    ...createTimers(), now: () => currentTime, countRunningSessions: () => runningSessionCount,
    reportStatus: reporter, log: { warn: (line: string) => lines.push(line) },
  });
  context.after(poller.stop);
  await poller.start();
  assert.match(lines[0] ?? '', /working report failed: Coder activity report failed \(400\)/);
  assert.match(lines[1] ?? '', /poll failed.*backing off/);
  currentTime = -1;
  await poller.tick();
  assert.equal(coder.requests.length, 2);
  currentTime = 120_000;
  coder.response.status = 200;
  await poller.tick();
  assert.equal(coder.requests.length, 3);
  runningSessionCount = 0;
  coder.response.status = 400;
  await poller.tick();
  currentTime += 120_000;
  coder.response.status = 200;
  await poller.tick();
  assert.equal(coder.requests.length, 5);
  assert.equal(lines.some((line) => line.includes(agentToken)), false);
});

test('the token file is trimmed and the environment token takes precedence', async (context) => {
  const coder = await createCoderServer();
  context.after(coder.close);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coder-activity-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token');
  await writeFile(tokenFile, ' file-secret\n');
  const env = { CODER_AGENT_URL: coder.agentUrl, CODER_AGENT_TOKEN_FILE: tokenFile };
  const report = { state: 'working' as const, message: '1 Glimmervoid session running' };
  await createCoderActivityReporter({ appSlug: 'glimmervoid', env })(report);
  assert.equal(coder.requests[0]?.token, 'file-secret');
  await createCoderActivityReporter({ appSlug: 'glimmervoid', env: { ...env, CODER_AGENT_TOKEN: 'env-secret' } })(report);
  assert.equal(coder.requests[1]?.token, 'env-secret');
});

test('missing and empty token files fail safely without making requests', async (context) => {
  const coder = await createCoderServer();
  context.after(coder.close);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coder-activity-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token');
  const reporter = createCoderActivityReporter({ appSlug: 'glimmervoid', env: { CODER_AGENT_URL: coder.agentUrl, CODER_AGENT_TOKEN_FILE: tokenFile } });
  await assert.rejects(reporter({ state: 'idle', message: 'No Glimmervoid sessions running' }), { message: 'Could not read CODER_AGENT_TOKEN_FILE' });
  await writeFile(tokenFile, ' \n');
  await assert.rejects(reporter({ state: 'idle', message: 'No Glimmervoid sessions running' }), /empty CODER_AGENT_TOKEN_FILE/);
  assert.equal(coder.requests.length, 0);
});

test('wiring staggers startup and restarts only when coder config changes', async (context) => {
  const coder = await createCoderServer();
  context.after(coder.close);
  const timers = createTimers();
  const config = { coder: { appSlug: 'first-app' } };
  const pollers: CoderActivityPoller[] = [];
  const wiring = createCoderActivityWiring({
    ...timers, config, env: { CODER_AGENT_URL: coder.agentUrl, CODER_AGENT_TOKEN: 'secret' },
    now: () => 0, countRunningSessions: () => 1, firstTickDelayMs: () => 123,
    createPoller: (deps) => {
      const poller = createCoderActivityPoller(deps);
      pollers.push(poller);
      return poller;
    },
  });
  context.after(wiring.stop);
  wiring.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.scheduled[0]?.delayMs, 123);
  assert.equal(coder.requests.length, 0);
  await pollers[0]?.tick();
  wiring.restartIfConfigChanged();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pollers.length, 1);
  config.coder.appSlug = 'second-app';
  wiring.restartIfConfigChanged();
  await waitFor(() => pollers.length === 2, 'a changed slug restarts the poller');
  await pollers[1]?.tick();
  await wiring.stop();
  assert.deepEqual(coder.requests.map((request) => request.body), [
    { app_slug: 'first-app', state: 'working', message: '1 Glimmervoid session running' },
    { app_slug: 'first-app', state: 'idle', message: CODER_ACTIVITY_STOPPED_MESSAGE },
    { app_slug: 'second-app', state: 'working', message: '1 Glimmervoid session running' },
    { app_slug: 'second-app', state: 'idle', message: CODER_ACTIVITY_STOPPED_MESSAGE },
  ]);
});

function createRecordingPoller({ runningSessionCount, reportStatus = async () => {} }: {
  runningSessionCount: number;
  reportStatus?: (report: CoderActivityReport) => Promise<void>;
}) {
  const reports: CoderActivityReport[] = [];
  const lines: string[] = [];
  const poller = createCoderActivityPoller({
    ...createTimers(), now: () => 0, countRunningSessions: () => runningSessionCount,
    reportStatus: async (report) => {
      reports.push(report);
      await reportStatus(report);
    },
    log: { warn: (line: string) => lines.push(line) },
  });
  return { poller, reports, lines };
}

test('stopping after a working report closes the status with one idle report', async () => {
  const { poller, reports, lines } = createRecordingPoller({ runningSessionCount: 2 });
  await poller.start();
  await Promise.all([poller.stop(), poller.stop()]);
  await poller.stop();
  assert.deepEqual(reports, [
    { state: 'working', message: '2 Glimmervoid sessions running' },
    { state: 'idle', message: CODER_ACTIVITY_STOPPED_MESSAGE },
  ]);
  assert.deepEqual(lines, []);
});

test('stopping a poller that never reported sends nothing', async () => {
  const { poller, reports } = createRecordingPoller({ runningSessionCount: 2 });
  await poller.stop();
  assert.deepEqual(reports, []);
});

test('stopping after an idle report sends nothing more', async () => {
  const { poller, reports } = createRecordingPoller({ runningSessionCount: 0 });
  await poller.start();
  await poller.stop();
  assert.deepEqual(reports, [{ state: 'idle', message: 'No Glimmervoid sessions running' }]);
});

test('a failing idle report on stop is logged and stop still resolves', async () => {
  const { poller, reports, lines } = createRecordingPoller({
    runningSessionCount: 1,
    reportStatus: async (report) => {
      if (report.state === 'idle') throw new Error('coderd unreachable');
    },
  });
  await poller.start();
  await poller.stop();
  assert.equal(reports.length, 2);
  assert.deepEqual(lines, ['[coder-activity] idle report on stop failed: coderd unreachable']);
});

test('repeated report failures never back off past the retry cap', async () => {
  let currentTime = 0;
  const lines: string[] = [];
  const poller = createCoderActivityPoller({
    ...createTimers(), now: () => currentTime, random: () => 1, countRunningSessions: () => 1,
    reportStatus: async () => { throw new Error('coderd unreachable'); },
    log: { warn: (line: string) => lines.push(line) },
  });
  await poller.start();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    currentTime += 60 * 60_000;
    await poller.tick();
  }
  await poller.stop();
  const backoffSeconds = lines.flatMap((line) => {
    const match = /backing off (\d+)s/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  assert.equal(backoffSeconds.length, 9);
  assert.ok(backoffSeconds.every((seconds) => seconds * 1000 <= CODER_ACTIVITY_RETRY_MAX_WAIT_MS));
  assert.equal(backoffSeconds.at(-1), CODER_ACTIVITY_RETRY_MAX_WAIT_MS / 1000);
});

test('unset coder config creates no poller or timers', async () => {
  const timers = createTimers();
  const wiring = createCoderActivityWiring({ ...timers, config: {}, env: {}, countRunningSessions: () => 1 });
  wiring.start();
  await wiring.stop();
  assert.deepEqual(timers.scheduled, []);
});
