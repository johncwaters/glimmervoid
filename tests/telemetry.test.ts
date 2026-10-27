import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { POSTHOG_PROJECT_TOKEN, TELEMETRY_BATCH_URL, } from '../server/core/telemetry-core.ts';
import { createAccountIdReader, createTelemetry, } from '../server/telemetry.ts';
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
  for (let index = 0; index < 30; index += 1) telemetry.capture('app_started', { is_first_start: false });
  await telemetry.flush();
  assert.equal(await telemetry.consumeFirstRunNotice(), false);
  await telemetry.stop();
  assert.equal(sent.length, 0);
  assert.equal(fs.existsSync(stateFilePath), false);
});

test('a batch posts the project token, the install id and an allowlisted event', async () => {
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
  assert.deepEqual(Object.keys(event.properties).sort(), [
    ...TELEMETRY_BASE_PROPERTY_KEYS, '$lib', 'adapter',
  ].sort());
  assert.deepEqual(
    { app_version: event.properties.app_version, os_platform: event.properties.os_platform, node_major: event.properties.node_major },
    { app_version: '9.9.9', os_platform: 'linux', node_major: 24 },
  );
});

test('app_started carries only hashes of the Claude and Codex account ids, never the login files', async () => {
  const claudeAccountUuid = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const codexUserId = 'user-AbC123xyz';
  const idTokenClaims = { email: 'alice@example.com', name: 'Alice', 'https://api.openai.com/auth': { user_id: codexUserId, chatgpt_account_id: 'workspace-1' } };
  const idToken = `header.${Buffer.from(JSON.stringify(idTokenClaims)).toString('base64url')}.signature`;
  const homeDir = '/home/alice';
  const filesByPath: Record<string, string> = {
    [path.join(homeDir, '.claude.json')]: JSON.stringify({ oauthAccount: { accountUuid: claudeAccountUuid, emailAddress: 'alice@example.com', displayName: 'Alice' } }),
    [path.join(homeDir, '.codex', 'auth.json')]: JSON.stringify({ tokens: { id_token: idToken, access_token: 'secret-access', refresh_token: 'secret-refresh', account_id: 'workspace-1' } }),
  };
  const readAccountIds = createAccountIdReader({ env: {}, homeDir, readTextFile: (filePath) => Promise.resolve(filesByPath[filePath] ?? null) });
  const { sent, fetchFn } = recordingFetch();
  const { telemetry } = buildTelemetry({ fetchFn, readAccountIds });
  telemetry.capture('app_started', { is_first_start: true });
  telemetry.capture('session_started', { adapter: 'codex' });
  await telemetry.flush();
  await telemetry.stop();
  const [appStarted, sessionStarted] = sent[0].body.batch;
  assert.deepEqual(Object.keys(appStarted.properties.$set as object).sort(), ['claude_account_hash', 'codex_user_hash']);
  assert.deepEqual(appStarted.properties.$set_once, { first_app_version: '9.9.9', first_os_platform: 'linux', first_install_flavor: 'npm-global' });
  assert.equal(sessionStarted.properties.$set, undefined);
  const body = JSON.stringify(sent[0].body);
  for (const secret of [claudeAccountUuid, codexUserId, 'alice@example.com', 'Alice', 'secret-access', 'secret-refresh', 'workspace-1']) {
    assert.equal(body.includes(secret), false, `${secret} never leaves the machine`);
  }
});

test('deleting data sends one request under the old id even with telemetry off, then rotates the id', async () => {
  const { sent, fetchFn } = recordingFetch();
  const stateFilePath = path.join(makeStateDir(), 'telemetry.json');
  const oldInstallId = 'a0000000-0000-4000-8000-000000000001';
  fs.writeFileSync(stateFilePath, JSON.stringify({ installId: oldInstallId, noticeShownAt: '2026-10-01T00:00:00.000Z' }));
  const { telemetry } = buildTelemetry({ fetchFn, stateFilePath, config: { telemetry: { enabled: false } } });
  assert.equal(await telemetry.requestDataDeletion(), true);
  assert.equal(telemetry.currentInstallId(), null);
  await telemetry.stop();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.batch.map(({ event, distinct_id }) => ({ event, distinct_id })), [{ event: 'data_deletion_requested', distinct_id: oldInstallId }]);
  const storedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  assert.notEqual(storedState.installId, oldInstallId);
  assert.equal(storedState.noticeShownAt, '2026-10-01T00:00:00.000Z');
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

test('every event carries is_dev_install, and $release_id only when a release id is set', async () => {
  const withRelease = recordingFetch();
  const linked = buildTelemetry({ fetchFn: withRelease.fetchFn, isDevInstall: true, releaseId: 'release-1' });
  linked.telemetry.capture('app_started', { is_first_start: false });
  await linked.telemetry.flush();
  await linked.telemetry.stop();
  const withoutRelease = recordingFetch();
  const unlinked = buildTelemetry({ fetchFn: withoutRelease.fetchFn, releaseId: null });
  unlinked.telemetry.capture('app_started', { is_first_start: false });
  await unlinked.telemetry.flush();
  await unlinked.telemetry.stop();
  const [linkedEvent] = withRelease.sent[0].body.batch;
  const [unlinkedEvent] = withoutRelease.sent[0].body.batch;
  assert.equal(linkedEvent.properties.is_dev_install, true);
  assert.equal(linkedEvent.properties.$release_id, 'release-1');
  assert.equal(unlinkedEvent.properties.is_dev_install, false);
  assert.equal('$release_id' in unlinkedEvent.properties, false);
});
