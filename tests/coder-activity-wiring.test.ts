import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoderActivityPoller } from '../server/coder-activity-poller.ts';
import { createCoderActivityReporter } from '../server/coder-activity-wiring.ts';
import {
  CODER_ACTIVITY_HEARTBEAT_MS, CODER_ACTIVITY_TICK_INTERVAL_MS,
} from '../server/core/coder-activity-core.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';

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
