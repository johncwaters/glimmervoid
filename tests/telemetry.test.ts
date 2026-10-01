import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { POSTHOG_PROJECT_TOKEN, TELEMETRY_BATCH_URL } from '../server/core/telemetry-core.ts';
import { createTelemetry, MAX_QUEUED_EVENTS } from '../server/telemetry.ts';
import type { TelemetryOptions } from '../server/telemetry.ts';
import { TELEMETRY_BASE_PROPERTY_KEYS } from '../shared/contracts/telemetry.ts';

interface SentBatch {
  url: string;
  body: {
    api_key: string;
    batch: Array<{ event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }>;
  };
  signal: AbortSignal | null | undefined;
}

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(process.env.GLIMMERVOID_HOME ?? os.tmpdir(), 'telemetry-'));
}

function recordingFetch(respond: () => Promise<Response> = () => Promise.resolve(new Response('{}', { status: 200 }))) {
  const sent: SentBatch[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return respond();
  };
  return { sent, fetchFn };
}

function buildTelemetry(overrides: Partial<TelemetryOptions> = {}) {
  const warnings: string[] = [];
  const telemetry = createTelemetry({
    config: {},
    env: {},
    stateFilePath: path.join(makeStateDir(), 'telemetry.json'),
    packageRoot: '/opt/glimmervoid',
    version: '9.9.9',
    installFlavor: 'npm-global',
    isBundled: true,
    platform: 'linux',
    nodeVersion: '24.1.0',
    logger: { warn: (line: string) => warnings.push(line), log: () => {} },
    ...overrides,
  });
  return { telemetry, warnings };
}

test('disabled consent sends nothing and writes no state file', async () => {
  const { sent, fetchFn } = recordingFetch();
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath, env: { DO_NOT_TRACK: '1' } });
  for (let index = 0; index < 30; index += 1) telemetry.capture('app_started', {});
  await telemetry.flush();
  assert.equal(await telemetry.consumeFirstRunNotice(), false);
  await telemetry.stop();
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(stateFilePath), false);
});

test('a batch posts the project token, the install id and an anonymous allowlisted event', async () => {
  const { sent, fetchFn } = recordingFetch();
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath });
  telemetry.capture('session_started', { adapter: 'codex' });
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, TELEMETRY_BATCH_URL);
  assert.ok(sent[0].signal instanceof AbortSignal);
  assert.equal(sent[0].body.api_key, POSTHOG_PROJECT_TOKEN);
  const [event] = sent[0].body.batch;
  const storedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  assert.equal(event.event, 'session_started');
  assert.equal(event.distinct_id, storedState.installId);
  assert.match(event.distinct_id, /^[0-9a-f-]{36}$/);
  assert.equal(event.properties.$process_person_profile, false);
  assert.deepEqual(Object.keys(event.properties).sort(), [
    ...TELEMETRY_BASE_PROPERTY_KEYS, '$lib', '$process_person_profile', 'adapter',
  ].sort());
  assert.deepEqual(
    { app_version: event.properties.app_version, os_platform: event.properties.os_platform, node_major: event.properties.node_major },
    { app_version: '9.9.9', os_platform: 'linux', node_major: 24 },
  );
});

test('the project token override reaches the batch body', async () => {
  const { sent, fetchFn } = recordingFetch();
  const { telemetry } = buildTelemetry({ fetchFn, env: { GLIMMERVOID_TELEMETRY_PROJECT_TOKEN: 'phc_scratch' } });
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sent[0].body.api_key, 'phc_scratch');
});

test('an event carrying a property outside its allowlist is dropped', async () => {
  const { sent, fetchFn } = recordingFetch();
  const { telemetry, warnings } = buildTelemetry({ fetchFn });
  const leakyProperties = { adapter: 'codex' as const, cwd: '/home/alice/secret-repo' };
  telemetry.capture('session_started', leakyProperties);
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sent.length, 0);
  assert.equal(warnings.length, 1);
});

test('twenty queued events flush without waiting for the timer', async () => {
  const { sent, fetchFn } = recordingFetch();
  const { telemetry } = buildTelemetry({ fetchFn });
  for (let index = 0; index < 20; index += 1) telemetry.capture('app_active', { active_session_count: index });
  await telemetry.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.batch.length, 20);
  await telemetry.stop();
});

test('the queue holds at most 500 events and drops the oldest', async () => {
  let releaseFirstSend: () => void = () => {};
  const firstSendHeld = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
  let sendCount = 0;
  const { sent, fetchFn } = recordingFetch(async () => {
    sendCount += 1;
    if (sendCount === 1) await firstSendHeld;
    return new Response('{}', { status: 200 });
  });
  const { telemetry } = buildTelemetry({ fetchFn });
  for (let index = 0; index < 600; index += 1) telemetry.capture('app_active', { active_session_count: index });
  releaseFirstSend();
  await telemetry.flush();
  await telemetry.flush();
  await telemetry.stop();
  const counts = sent.flatMap((batch) => batch.body.batch.map((event) => event.properties.active_session_count));
  assert.deepEqual(counts.slice(0, 20), Array.from({ length: 20 }, (_, index) => index));
  const queuedWhileSending = counts.slice(20);
  assert.equal(queuedWhileSending.length, MAX_QUEUED_EVENTS);
  assert.equal(queuedWhileSending[0], 100);
  assert.equal(queuedWhileSending.at(-1), 599);
});

test('a rejected send is swallowed and logged once', async () => {
  const { sent, fetchFn } = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
  const { telemetry, warnings } = buildTelemetry({ fetchFn });
  telemetry.capture('app_started', {});
  await telemetry.flush();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sent.length, 2);
  assert.equal(warnings.length, 1);
});

test('a timed-out send is swallowed', async () => {
  const { fetchFn } = recordingFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
  const { telemetry, warnings } = buildTelemetry({ fetchFn });
  telemetry.capture('app_started', {});
  await assert.doesNotReject(telemetry.flush());
  await telemetry.stop();
  assert.match(warnings[0] ?? '', /TimeoutError/);
});

test('a non-2xx response is logged, never thrown', async () => {
  const { fetchFn } = recordingFetch(() => Promise.resolve(new Response('nope', { status: 401 })));
  const { telemetry, warnings } = buildTelemetry({ fetchFn });
  telemetry.capture('app_started', {});
  await assert.doesNotReject(telemetry.flush());
  await telemetry.stop();
  assert.match(warnings[0] ?? '', /status=401/);
});

test('the first-run notice is shown once per install and persisted', async () => {
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const first = buildTelemetry({ stateFilePath, fetchFn: recordingFetch().fetchFn });
  assert.equal(await first.telemetry.consumeFirstRunNotice(), true);
  assert.equal(await first.telemetry.consumeFirstRunNotice(), false);
  await first.telemetry.stop();
  const stored = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  assert.equal(typeof stored.noticeShownAt, 'string');
  const second = buildTelemetry({ stateFilePath, fetchFn: recordingFetch().fetchFn });
  assert.equal(await second.telemetry.consumeFirstRunNotice(), false);
  await second.telemetry.stop();
  assert.equal(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).installId, stored.installId);
});

test('turning consent off in config clears the queue', async () => {
  const { sent, fetchFn } = recordingFetch();
  const config: { telemetry: { enabled: boolean } } = { telemetry: { enabled: true } };
  const { telemetry } = buildTelemetry({ fetchFn, config });
  telemetry.capture('app_started', {});
  config.telemetry.enabled = false;
  telemetry.applyConfig();
  config.telemetry.enabled = true;
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sent.length, 0);
});

test('stop sends what is queued and nothing captured afterwards', async () => {
  const { sent, fetchFn } = recordingFetch();
  const { telemetry } = buildTelemetry({ fetchFn });
  telemetry.capture('app_started', {});
  await telemetry.stop();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.batch.length, 1);
});
