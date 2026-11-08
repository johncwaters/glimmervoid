import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from '../helpers/dashboard-ws.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { startRecordingFake } from './support/recording-fake.ts';
import type { RecordedRequest } from './support/recording-fake.ts';
import { assertCleanLog, startServer } from './support/server-process.ts';

const SCENARIO_SEEDS = ['server/secrets/vault-socket.ts', 'server/secrets/secrets-broker.ts', 'server/telemetry.ts', 'server/agent-api-cli.ts', 'bin/glimmervoid.ts'];

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SECRET_NAME = 'E2E_VAULT_SECRET';
const SECRET_REFERENCE = 'op://e2e-vault/e2e-item/credential';
const SECRET_VALUE = 'e2e-secret-value-7f3a';
const WRONG_TOKEN = 'e2e-wrong-vault-token';
const DELIVERY_DEADLINE_MS = 20_000;
const TELEMETRY_ENVIRONMENT_NAMES = ['CI', 'NODE_TEST_CONTEXT', 'GLIMMERVOID_TELEMETRY', 'DO_NOT_TRACK'];

interface CompanionFile {
  url: string;
  token: string;
}

interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
}

interface ControlFrame {
  type: string;
  requestId?: string;
  ok?: boolean;
  sessionId?: string;
  error?: string | null;
}

function connectCompanion(companionUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(companionUrl, { headers: { authorization: `Bearer ${token}` } });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function answerResolveJobs(companion: WebSocket): void {
  companion.send(JSON.stringify({ type: 'hello', newItemsVault: null }));
  companion.on('message', (rawJob: Buffer) => {
    const job = JSON.parse(rawJob.toString('utf8'));
    if (job.type !== 'resolve') return;
    const items = job.items.map((item: { name: string; reference: string }) => (item.reference === SECRET_REFERENCE ? { name: item.name, value: SECRET_VALUE } : { name: item.name, failure: { kind: 'not-found', message: 'unknown reference' } }));
    companion.send(JSON.stringify({ type: 'resolved', jobId: job.jobId, items }));
  });
}

function capturedEventsOf(requests: readonly RecordedRequest[]): CapturedEvent[] {
  return requests
    .filter((request) => request.path === '/batch/')
    .flatMap((request) => JSON.parse(request.body).batch as CapturedEvent[]);
}

function stringsInside(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsInside);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsInside);
  return [];
}

test('the vault takes a companion, refuses a wrong token, delivers an approved secret to a shell session, and telemetry reports it without names, values, tokens or addresses', async (t) => {
  const fakeIngest = await startRecordingFake((request) => {
    if (request.path.startsWith('/flags')) return { status: 200, body: '{"flags":{}}' };
    return { status: 200, body: '{"status":1}' };
  });
  t.after(() => fakeIngest.close());
  const projectDirectory = fs.mkdtempSync(path.join(process.env.GLIMMERVOID_HOME ?? REPO_ROOT, 'vault-project-'));
  const server = await startServer({
    scenarioName: 'vault-telemetry',
    testContext: t,
    extraEnvironment: { GLIMMERVOID_POSTHOG_INGEST_HOST: fakeIngest.origin },
    removedEnvironmentNames: TELEMETRY_ENVIRONMENT_NAMES,
    seedConfig: {
      projects: [],
      telemetry: { enabled: true },
      secrets: { byProject: { [projectDirectory]: { [SECRET_NAME]: { reference: SECRET_REFERENCE, isAllowed: true } } } },
    },
  });

  const companionFilePath = path.join(server.home, 'vault-companion.json');
  await waitFor(() => fs.existsSync(companionFilePath), 'the vault companion file');
  const companionFile: CompanionFile = JSON.parse(fs.readFileSync(companionFilePath, 'utf8'));
  const companionUrl = new URL('/vault', companionFile.url).toString();

  await assert.rejects(connectCompanion(companionUrl, WRONG_TOKEN), /401/);
  await server.waitForLogLine(/\[vault\] refused a companion connection: wrong token/, 'the wrong token refusal');
  const companion = await connectCompanion(companionUrl, companionFile.token);
  answerResolveJobs(companion);
  await server.waitForLogLine(/\[vault\] companion connected/, 'the companion connection');

  const client = await dashboardClient(server.port);
  const control = await openRecordingSocket<ControlFrame>(client, '/control');
  control.ws.send(JSON.stringify({ type: 'add-session', requestId: 'e2e-shell', name: 'e2e shell', path: projectDirectory, agent: 'shell' }));
  const added = await waitForMessage(control.received, (frame) => frame.type === 'add-session-result' && frame.requestId === 'e2e-shell', 'the shell session reply');
  assert.equal(added.ok, true, added.error ?? 'the shell session was refused');
  const terminal = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(client.url(`/terminals/${added.sessionId}`), client.options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const needReplyPath = path.join(projectDirectory, 'need-reply.json');
  const needCommand = `'${process.execPath}' '${path.join(REPO_ROOT, 'bin', 'glimmervoid.ts')}' need ${SECRET_NAME} > '${needReplyPath}' 2>&1\r`;
  terminal.send(JSON.stringify({ type: 'input', data: needCommand }));

  const envFilePath = path.join(projectDirectory, '.env.local');
  await waitFor(() => fs.existsSync(envFilePath) && fs.readFileSync(envFilePath, 'utf8').includes(SECRET_VALUE), 'the secret written to the session env file', DELIVERY_DEADLINE_MS);
  await waitFor(() => fs.existsSync(needReplyPath) && fs.readFileSync(needReplyPath, 'utf8').includes('delivered'), 'the need command reporting delivery', DELIVERY_DEADLINE_MS);

  terminal.close();
  companion.close();
  await closeSocket(control.ws);
  const stopped = await server.stopProcessGroup('SIGTERM');
  t.diagnostic(`boot ${server.bootMs} ms, shutdown ${stopped.shutdownMs} ms`);
  assert.equal(stopped.exitCode, 0, server.logText());
  assertCleanLog(server.logText());

  const capturedEvents = capturedEventsOf(fakeIngest.requests);
  const vaultConnections = capturedEvents.filter((captured) => captured.event === 'vault_companion_connection').map((captured) => captured.properties.state);
  assert.ok(vaultConnections.includes('refused') && vaultConnections.includes('connected'), `vault connection events: ${JSON.stringify(vaultConnections)}`);
  const answeredSecrets = capturedEvents.filter((captured) => captured.event === 'vault_secret_answered');
  assert.equal(answeredSecrets.at(-1)?.properties.delivered_count, 1, JSON.stringify(answeredSecrets));
  const forbiddenTexts = [SECRET_NAME, SECRET_VALUE, SECRET_REFERENCE, companionFile.token, WRONG_TOKEN, projectDirectory, path.basename(projectDirectory), server.home, fakeIngest.origin, 'http://', 'https://'];
  const leakedStrings = capturedEvents.flatMap((captured) => stringsInside(captured.properties).filter((text) => forbiddenTexts.some((forbidden) => text.includes(forbidden))).map((text) => `${captured.event}: ${text}`));
  assert.deepEqual(leakedStrings, [], 'telemetry carried a secret, token, address or project name');
});

export { SCENARIO_SEEDS };
