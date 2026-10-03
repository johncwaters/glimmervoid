import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { POSTHOG_PROJECT_TOKEN, TELEMETRY_BATCH_URL, TELEMETRY_FLAGS_URL } from '../server/core/telemetry-core.ts';
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
    isDevInstall: false,
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

test('ai generations post one hashed, content free event per rollup row', async () => {
  const { sent, fetchFn } = recordingFetch();
  const { telemetry } = buildTelemetry({ fetchFn });
  await telemetry.captureAiGenerations([
    { sessionId: 'session-secret', model: 'gpt-5.6', vendor: 'codex', input: 40, output: 4, cacheRead: 0, cacheCreate: 0, costUSD: 0.02, hasKnownCost: true, isModelKnown: true },
    { sessionId: 'session-idle', model: 'gpt-5.6', vendor: 'codex', input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0, hasKnownCost: false, isModelKnown: true },
  ]);
  await telemetry.flush();
  await telemetry.stop();
  const events = sent.flatMap((batch) => batch.body.batch);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, '$ai_generation');
  assert.equal(events[0].properties.$ai_provider, 'openai');
  assert.equal(events[0].properties.agent_adapter, 'codex');
  assert.equal(JSON.stringify(events[0]).includes('session-secret'), false);
});

test('ai generations stay unsent and write no state when consent is off', async () => {
  const { sent, fetchFn } = recordingFetch();
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath, env: { GLIMMERVOID_TELEMETRY: '0' } });
  await telemetry.captureAiGenerations([
    { sessionId: 'session-a', model: 'gpt-5.6', vendor: 'codex', input: 40, output: 4, cacheRead: 0, cacheCreate: 0, costUSD: 0, hasKnownCost: false, isModelKnown: true },
  ]);
  await telemetry.stop();
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(stateFilePath), false);
});

function killSwitchFetch(respondToFlags: () => Promise<Response>) {
  const flagRequests: Array<{ body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];
  const batches: SentBatch[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input) !== TELEMETRY_FLAGS_URL) {
      batches.push({ url: String(input), body, signal: init?.signal });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    flagRequests.push({ body, signal: init?.signal });
    return respondToFlags();
  };
  return { flagRequests, batches, fetchFn };
}

function flagsResponse(flags: Record<string, unknown>): () => Promise<Response> {
  return () => Promise.resolve(Response.json({ flags, errorsWhileComputingFlags: false, requestId: 'request-1' }));
}

test('the flag check posts the project token and install id outside the event queue', async () => {
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const { flagRequests, batches, fetchFn } = killSwitchFetch(flagsResponse({}));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath });
  await telemetry.checkRemoteSwitch();
  const storedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  assert.deepEqual(flagRequests[0].body, { api_key: POSTHOG_PROJECT_TOKEN, distinct_id: storedState.installId });
  assert.ok(flagRequests[0].signal instanceof AbortSignal);
  assert.equal(batches.length, 0);
  await telemetry.stop();
});

test('a disabled telemetry-enabled flag stops capture and clears the queue until a check enables it again', async () => {
  let flags: Record<string, unknown> = { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: false } };
  const { batches, fetchFn } = killSwitchFetch(() => flagsResponse(flags)());
  const { telemetry } = buildTelemetry({ fetchFn });
  telemetry.capture('app_started', {});
  await telemetry.checkRemoteSwitch();
  assert.equal(telemetry.isEnabled(), false);
  telemetry.capture('app_started', {});
  await telemetry.flush();
  assert.equal(batches.length, 0);
  flags = { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: true } };
  await telemetry.checkRemoteSwitch();
  telemetry.capture('session_started', { adapter: 'codex' });
  await telemetry.flush();
  await telemetry.stop();
  assert.deepEqual(batches.flatMap((batch) => batch.body.batch.map((event) => event.event)), ['session_started']);
});

test('an enabled or missing telemetry-enabled flag leaves capture on', async () => {
  for (const flags of [{ 'telemetry-enabled': { key: 'telemetry-enabled', enabled: true } }, {}]) {
    const { batches, fetchFn } = killSwitchFetch(flagsResponse(flags));
    const { telemetry } = buildTelemetry({ fetchFn });
    await telemetry.checkRemoteSwitch();
    telemetry.capture('app_started', {});
    await telemetry.flush();
    await telemetry.stop();
    assert.equal(batches.length, 1);
  }
});

test('a timed-out, rejected or unparseable flag check leaves capture on', async () => {
  const failures = [
    () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    () => Promise.resolve(new Response('nope', { status: 500 })),
    () => Promise.resolve(new Response('not json', { status: 200 })),
  ];
  for (const respondToFlags of failures) {
    const { batches, fetchFn } = killSwitchFetch(respondToFlags);
    const { telemetry } = buildTelemetry({ fetchFn });
    await assert.doesNotReject(telemetry.checkRemoteSwitch());
    telemetry.capture('app_started', {});
    await telemetry.flush();
    await telemetry.stop();
    assert.equal(batches.length, 1);
  }
});

test('a flag check failure after a disable keeps capture off', async () => {
  let respondToFlags = flagsResponse({ 'telemetry-enabled': { enabled: false } });
  const { batches, fetchFn } = killSwitchFetch(() => respondToFlags());
  const { telemetry } = buildTelemetry({ fetchFn });
  await telemetry.checkRemoteSwitch();
  respondToFlags = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
  await telemetry.checkRemoteSwitch();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(batches.length, 0);
});

test('an absent telemetry-enabled flag after a disable keeps capture off', async () => {
  let respondToFlags = flagsResponse({ 'telemetry-enabled': { enabled: false } });
  const { batches, fetchFn } = killSwitchFetch(() => respondToFlags());
  const { telemetry } = buildTelemetry({ fetchFn });
  await telemetry.checkRemoteSwitch();
  respondToFlags = flagsResponse({});
  await telemetry.checkRemoteSwitch();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(batches.length, 0);
});

test('local consent off makes no flag request and writes no state file', async () => {
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const { flagRequests, fetchFn } = killSwitchFetch(flagsResponse({}));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath, env: { GLIMMERVOID_TELEMETRY: '0' } });
  telemetry.startRemoteSwitchChecks();
  await telemetry.checkRemoteSwitch();
  await telemetry.stop();
  assert.equal(flagRequests.length, 0);
  assert.equal(fs.existsSync(stateFilePath), false);
});

const disabledFlag = { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: false } };
const enabledFlag = { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: true } };

async function persistRemoteDisable(stateFilePath: string): Promise<void> {
  const { telemetry } = buildTelemetry({ fetchFn: killSwitchFetch(flagsResponse(disabledFlag)).fetchFn, stateFilePath });
  await telemetry.checkRemoteSwitch();
  await telemetry.stop();
}

test('a remote disable is persisted and keeps a restarted install silent when its first flag check fails', async () => {
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  await persistRemoteDisable(stateFilePath);
  assert.equal(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).remoteDisabled, true);
  const { batches, flagRequests, fetchFn } = killSwitchFetch(() => Promise.resolve(new Response('nope', { status: 500 })));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath });
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.checkRemoteSwitch();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(flagRequests.length, 1);
  assert.equal(batches.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).remoteDisabled, true);
});

test('a persisted remote disable keeps a restarted install from sending its saved crash', async () => {
  const stateDir = makeStateDir();
  const stateFilePath = path.join(stateDir, 'telemetry.json');
  const pendingCrashFilePath = path.join(stateDir, 'telemetry-pending-crash.json');
  await persistRemoteDisable(stateFilePath);
  const crashing = buildTelemetry({ fetchFn: killSwitchFetch(flagsResponse({})).fetchFn, pendingCrashFilePath });
  crashing.telemetry.recordFatalCrash(new Error('boom'));
  await crashing.telemetry.stop();
  const { batches, fetchFn } = killSwitchFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath, pendingCrashFilePath });
  telemetry.startRemoteSwitchChecks();
  await telemetry.sendPendingCrash();
  await telemetry.stop();
  assert.equal(batches.length, 0);
  assert.equal(fs.existsSync(pendingCrashFilePath), true);
});

test('a persisted remote disable is cleared and persisted once a check returns the flag enabled', async () => {
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  await persistRemoteDisable(stateFilePath);
  const { batches, fetchFn } = killSwitchFetch(flagsResponse(enabledFlag));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath });
  await telemetry.checkRemoteSwitch();
  telemetry.capture('app_started', {});
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(batches.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).remoteDisabled, false);
});

test('turning local consent on through applyConfig runs a flag check, and leaving it off runs none', async () => {
  let markFlagRequested: () => void = () => {};
  const flagRequested = new Promise<void>((resolve) => { markFlagRequested = resolve; });
  const { flagRequests, fetchFn } = killSwitchFetch(() => {
    markFlagRequested();
    return flagsResponse({})();
  });
  const config: { telemetry: { enabled: boolean } } = { telemetry: { enabled: false } };
  const { telemetry } = buildTelemetry({ fetchFn, config });
  telemetry.startRemoteSwitchChecks();
  telemetry.applyConfig();
  await telemetry.checkRemoteSwitch();
  assert.equal(flagRequests.length, 0);
  config.telemetry.enabled = true;
  telemetry.applyConfig();
  await flagRequested;
  assert.equal(flagRequests.length, 1);
  await telemetry.stop();
});

test('every event carries is_dev_install, and $release_id only when a release id is set', async () => {
  const withRelease = recordingFetch();
  const linked = buildTelemetry({ fetchFn: withRelease.fetchFn, isDevInstall: true, releaseId: 'release-1' });
  linked.telemetry.capture('app_started', {});
  await linked.telemetry.flush();
  await linked.telemetry.stop();
  const withoutRelease = recordingFetch();
  const unlinked = buildTelemetry({ fetchFn: withoutRelease.fetchFn, releaseId: null });
  unlinked.telemetry.capture('app_started', {});
  await unlinked.telemetry.flush();
  await unlinked.telemetry.stop();
  const [linkedEvent] = withRelease.sent[0].body.batch;
  const [unlinkedEvent] = withoutRelease.sent[0].body.batch;
  assert.equal(linkedEvent.properties.is_dev_install, true);
  assert.equal(linkedEvent.properties.$release_id, 'release-1');
  assert.equal(unlinkedEvent.properties.is_dev_install, false);
  assert.equal('$release_id' in unlinkedEvent.properties, false);
});
