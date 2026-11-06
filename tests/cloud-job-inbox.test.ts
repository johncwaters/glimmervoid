import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createJobInboxRequestHandler } from '../cloud/inbox/job-inbox-listener.ts';
import { createJobInbox } from '../cloud/inbox/job-inbox-wiring.ts';
import { loadConfigFile } from '../server/config/config-file.ts';
import { WATCHER_JOBS_PATH } from '../shared/contracts/watcher-jobs.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';

const WATCHER_TOKEN = 'a-watcher-token-only-this-test-knows';
const QUIET_LOG = { warn: () => {} };

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
  const inbox = createJobInbox({ watcherConfig: { autoStart: false, inboxPort: 1, token: WATCHER_TOKEN }, log: QUIET_LOG });
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
    handlers: { ping: async () => { handlerRuns += 1; await new Promise((resolve) => setTimeout(resolve, 100)); throw new Error('the ping failed'); } },
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
    assert.equal(createJobInbox({ watcherConfig: config.watcher, log: QUIET_LOG }).decision.listen, false);
  } finally {
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
});

test('a non-loopback inbox opens only with the environment token, never with the per-boot one', () => {
  const withoutEnvToken = createJobInbox({ watcherConfig: { autoStart: true, inboxHost: '0.0.0.0', inboxPort: 7700 }, log: QUIET_LOG });
  assert.equal(withoutEnvToken.decision.listen, false);
  assert.equal(withoutEnvToken.token, null);

  const withEnvToken = createJobInbox({ watcherConfig: { autoStart: false, inboxHost: '0.0.0.0', inboxPort: 7700, token: WATCHER_TOKEN }, log: QUIET_LOG });
  assert.deepEqual(withEnvToken.decision, { listen: true, host: '0.0.0.0', port: 7700, tokenSource: 'env' });
  assert.equal(withEnvToken.token, WATCHER_TOKEN);

  const localAutoStart = createJobInbox({ watcherConfig: {}, log: QUIET_LOG });
  assert.deepEqual(localAutoStart.decision, { listen: true, host: '127.0.0.1', port: 0, tokenSource: 'per-boot' });
  assert.notEqual(localAutoStart.token, null);

  const switchedOff = createJobInbox({ watcherConfig: { autoStart: false }, log: QUIET_LOG });
  assert.deepEqual(switchedOff.decision, { listen: false, reason: null });
});
