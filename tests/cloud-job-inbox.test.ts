import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createJobInboxRequestHandler } from '../cloud/inbox/job-inbox-listener.ts';
import { createJobInbox } from '../cloud/inbox/job-inbox-wiring.ts';
import { withBuiltInJobHandlers } from '../cloud/inbox/watchee-handlers.ts';
import { loadConfigFile } from '../server/config/config-file.ts';
import { WATCHER_JOBS_PATH } from '../shared/contracts/watcher-jobs.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';

const WATCHER_TOKEN = 'a-watcher-token-only-this-test-knows';
const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'glimmervoid.ts');
const runFile = promisify(execFile);
const QUIET_LOG = { log: () => {}, warn: () => {} };
const IGNORING_HANDLERS = withBuiltInJobHandlers({});

function pingJob(jobId: string = crypto.randomUUID()) {
  return { version: 1, jobId, sentAt: new Date().toISOString(), kind: 'ping', payload: {} };
}

async function postJob(port: number, body: unknown, authorization: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  const response = await fetch(`http://127.0.0.1:${port}${WATCHER_JOBS_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('the job inbox acks a ping once, dedupes its retry, and refuses a wrong token or a malformed job', async () => {
  const inbox = createJobInbox({ watcherConfig: { autoStart: false, inboxPort: 1, token: WATCHER_TOKEN }, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  assert.equal(inbox.decision.listen, true);
  const server = http.createServer();
  inbox.attach(server);
  const port = await listenOnLoopback(server);
  try {
    const job = pingJob();
    assert.deepEqual(await postJob(port, job, `Bearer ${WATCHER_TOKEN}`), { status: 200, body: { jobId: job.jobId, status: 'accepted' } });
    assert.deepEqual(await postJob(port, job, `Bearer ${WATCHER_TOKEN}`), { status: 200, body: { jobId: job.jobId, status: 'duplicate' } });
    assert.equal((await postJob(port, pingJob(), null)).status, 401);
    assert.equal((await postJob(port, pingJob(), 'Bearer not-the-token')).status, 401);
    assert.equal((await postJob(port, pingJob(), WATCHER_TOKEN)).status, 401);
    assert.equal((await postJob(port, { ...pingJob(), kind: 'launch-missiles' }, `Bearer ${WATCHER_TOKEN}`)).status, 400);
    assert.equal((await postJob(port, { ...pingJob(), payload: { extra: true } }, `Bearer ${WATCHER_TOKEN}`)).status, 400);
    assert.equal((await postJob(port, { ...pingJob(), jobId: 'not-a-uuid' }, `Bearer ${WATCHER_TOKEN}`)).status, 400);
  } finally {
    await closeServer(server);
  }
});

test('a retry of a job still running is told to retry, and a job that failed is run again', async () => {
  let handlerRuns = 0;
  const server = http.createServer(createJobInboxRequestHandler({
    token: WATCHER_TOKEN,
    log: QUIET_LOG,
    handlers: { ...IGNORING_HANDLERS, ping: async () => { handlerRuns += 1; await new Promise((resolve) => setTimeout(resolve, 100)); throw new Error('the ping failed'); } },
  }));
  const port = await listenOnLoopback(server);
  try {
    const job = pingJob();
    const firstDelivery = postJob(port, job, `Bearer ${WATCHER_TOKEN}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await postJob(port, job, `Bearer ${WATCHER_TOKEN}`)).status, 409);
    assert.equal((await firstDelivery).status, 500);
    assert.equal((await postJob(port, job, `Bearer ${WATCHER_TOKEN}`)).status, 500);
    assert.equal(handlerRuns, 2);
  } finally {
    await closeServer(server);
  }
});

test('a watcher token written in config.json never opens a non-loopback inbox', () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-watcher-config-'));
  try {
    const configPath = path.join(configDirectory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projects: [], watcher: { inboxHost: '0.0.0.0', inboxPort: 7700, token: 'written-in-the-file' } }));
    const { config } = loadConfigFile(configPath, { envSecrets: [] });
    assert.equal(createJobInbox({ watcherConfig: config.watcher, handlers: IGNORING_HANDLERS, log: QUIET_LOG }).decision.listen, false);
  } finally {
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
});

test('a non-loopback inbox opens only with the environment token, never with the per-boot one', () => {
  const withoutEnvToken = createJobInbox({ watcherConfig: { autoStart: true, inboxHost: '0.0.0.0', inboxPort: 7700 }, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  assert.equal(withoutEnvToken.decision.listen, false);
  assert.equal(withoutEnvToken.token, null);

  const withEnvToken = createJobInbox({ watcherConfig: { autoStart: false, inboxHost: '0.0.0.0', inboxPort: 7700, token: WATCHER_TOKEN }, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  assert.deepEqual(withEnvToken.decision, { listen: true, host: '0.0.0.0', port: 7700, tokenSource: 'env' });
  assert.equal(withEnvToken.token, WATCHER_TOKEN);

  const localAutoStart = createJobInbox({ watcherConfig: {}, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  assert.deepEqual(localAutoStart.decision, { listen: true, host: '127.0.0.1', port: 0, tokenSource: 'per-boot' });
  assert.notEqual(localAutoStart.token, null);

  const switchedOff = createJobInbox({ watcherConfig: { autoStart: false }, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  assert.deepEqual(switchedOff.decision, { listen: false, reason: null });
});

async function runWatchPing(port: number, watcherToken: string): Promise<{ exitCode: number; output: string }> {
  const env = { ...process.env, GLIMMERVOID_WATCHER_TOKEN: watcherToken };
  try {
    const { stdout, stderr } = await runFile(process.execPath, [CLI_PATH, 'watch', '--inbox', `http://127.0.0.1:${port}`, '--ping'], { env });
    return { exitCode: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('glimmervoid watch --ping exits 0 on the inbox ack and 1 naming a refused token', async () => {
  const inbox = createJobInbox({ watcherConfig: { inboxPort: 1, token: WATCHER_TOKEN }, handlers: IGNORING_HANDLERS, log: QUIET_LOG });
  const server = http.createServer();
  inbox.attach(server);
  const port = await listenOnLoopback(server);
  try {
    const acked = await runWatchPing(port, WATCHER_TOKEN);
    assert.equal(acked.exitCode, 0, acked.output);
    assert.match(acked.output, /ping acked by http:\/\/127\.0\.0\.1:\d+\/jobs/);
    const refused = await runWatchPing(port, 'not-the-token');
    assert.equal(refused.exitCode, 1, refused.output);
    assert.match(refused.output, /inbox refused the token \(401\)/);
  } finally {
    await closeServer(server);
  }
});

test('glimmervoid watch --ping retries an inbox that drops the connection mid-reply, then names it unreachable', async () => {
  let deliveryAttempts = 0;
  const droppingInbox = http.createServer((request, response) => {
    deliveryAttempts += 1;
    request.resume();
    response.writeHead(503, { 'content-length': '100' });
    response.write('cut');
    setTimeout(() => response.socket?.destroy(), 10);
  });
  const port = await listenOnLoopback(droppingInbox);
  try {
    const dropped = await runWatchPing(port, WATCHER_TOKEN);
    assert.equal(dropped.exitCode, 1, dropped.output);
    assert.match(dropped.output, /inbox unreachable/);
    assert.equal(deliveryAttempts, 3);
  } finally {
    await closeServer(droppingInbox);
  }
});

test('an auto-started watcher pings the inbox, is restarted after it dies, and stops when the inbox closes', async () => {
  const pingWaiters: (() => void)[] = [];
  const nextPing = () => new Promise<void>((resolve) => { pingWaiters.push(resolve); });
  const supervisorLines: string[] = [];
  const inbox = createJobInbox({
    watcherConfig: {},
    handlers: { ...IGNORING_HANDLERS, ping: async () => { pingWaiters.shift()?.(); } },
    log: { log: (line: string) => supervisorLines.push(line), warn: (line: string) => supervisorLines.push(line) },
  });
  const server = http.createServer();
  inbox.attach(server);
  const port = await listenOnLoopback(server);
  try {
    const firstPing = nextPing();
    inbox.startWatcher(port);
    await firstPing;
    const firstPid = Number(/pid (\d+)/.exec(supervisorLines.join('\n'))?.[1]);
    const restartedPing = nextPing();
    process.kill(firstPid, 'SIGKILL');
    await restartedPing;
    assert.ok(supervisorLines.some((line) => /child exited \(SIGKILL\), restarting in 1s/.test(line)), supervisorLines.join('\n'));
  } finally {
    await closeServer(server);
  }
  const lastPid = Number([...supervisorLines.join('\n').matchAll(/pid (\d+)/g)].at(-1)?.[1]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.throws(() => process.kill(lastPid, 0));
});

test('a supervised watcher whose server goes away mid-ping exits instead of idling forever', async () => {
  const silentInbox = http.createServer(() => {});
  const port = await listenOnLoopback(silentInbox);
  const watcherChild = spawn(process.execPath, [CLI_PATH, 'watch', '--inbox', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, GLIMMERVOID_WATCHER_TOKEN: WATCHER_TOKEN },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    watcherChild.disconnect();
    const exitCode = await Promise.race([
      new Promise((resolve) => { watcherChild.once('exit', resolve); }),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 3000)),
    ]);
    assert.equal(exitCode, 0);
  } finally {
    watcherChild.kill('SIGKILL');
    silentInbox.closeAllConnections();
    await closeServer(silentInbox);
  }
});
