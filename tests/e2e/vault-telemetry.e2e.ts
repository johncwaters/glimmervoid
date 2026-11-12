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
import { resolveFnoxPath } from '../../server/runtime-paths.ts';

const SCENARIO_SEEDS = ['server/secrets/secrets-broker.ts', 'server/secrets/fnox-runner.ts', 'server/telemetry.ts', 'server/agent-api-cli.ts', 'bin/glimmervoid.ts'];

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SECRET_NAME = 'E2E_VAULT_SECRET';
const VAULT_NAME = 'e2e-vault';
const SECRET_VALUE = 'e2e-secret-value-7f3a';
const DELIVERY_DEADLINE_MS = 20_000;
const TELEMETRY_ENVIRONMENT_NAMES = ['CI', 'NODE_TEST_CONTEXT', 'GLIMMERVOID_TELEMETRY', 'DO_NOT_TRACK'];

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
  id?: string;
  transition?: { event: string };
}

const cannotRunFakeOp = process.platform === 'win32' || !fs.existsSync(resolveFnoxPath());

function writeFakeOp(): string {
  const fakeBin = fs.mkdtempSync(path.join(process.env.GLIMMERVOID_HOME ?? REPO_ROOT, 'vault-op-'));
  fs.writeFileSync(path.join(fakeBin, 'op'), `#!/bin/sh\nprintf '%s' '${SECRET_VALUE}'\n`, { mode: 0o755 });
  return fakeBin;
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

test('an approved secret reaches a shell session through the password manager, and telemetry reports it without names, values or addresses', { skip: cannotRunFakeOp }, async (t) => {
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
    pathPrefix: writeFakeOp(),
    seedConfig: {
      projects: [],
      telemetry: { enabled: true },
      vault: { manager: '1password', lookIn: VAULT_NAME },
      secrets: { byProject: { [projectDirectory]: { [SECRET_NAME]: { isAllowed: true } } } },
    },
  });

  const client = await dashboardClient(server.port);
  const control = await openRecordingSocket<ControlFrame>(client, '/control');
  control.ws.send(JSON.stringify({ type: 'add-session', requestId: 'e2e-shell', name: 'e2e shell', path: projectDirectory, agent: 'shell' }));
  const added = await waitForMessage(control.received, (frame) => frame.type === 'add-session-result' && frame.requestId === 'e2e-shell', 'the shell session reply');
  assert.equal(added.ok, true, added.error ?? 'the shell session was refused');
  await waitForMessage(control.received, (frame) => frame.type === 'session-status' && frame.id === added.sessionId && frame.transition?.event === 'first_output', 'the shell printing its prompt', DELIVERY_DEADLINE_MS);
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
  await closeSocket(control.ws);
  const stopped = await server.stopProcessGroup('SIGTERM');
  t.diagnostic(`boot ${server.bootMs} ms, shutdown ${stopped.shutdownMs} ms`);
  assert.equal(stopped.exitCode, 0, server.logText());
  assertCleanLog(server.logText());

  const capturedEvents = capturedEventsOf(fakeIngest.requests);
  const answeredSecrets = capturedEvents.filter((captured) => captured.event === 'vault_secret_answered');
  assert.equal(answeredSecrets.at(-1)?.properties.delivered_count, 1, JSON.stringify(answeredSecrets));
  const forbiddenTexts = [SECRET_NAME, SECRET_VALUE, VAULT_NAME, projectDirectory, path.basename(projectDirectory), server.home, fakeIngest.origin, 'http://', 'https://'];
  const leakedStrings = capturedEvents.flatMap((captured) => stringsInside(captured.properties).filter((text) => forbiddenTexts.some((forbidden) => text.includes(forbidden))).map((text) => `${captured.event}: ${text}`));
  assert.deepEqual(leakedStrings, [], 'telemetry carried a secret, address or project name');
});

export { SCENARIO_SEEDS };
