import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelemetry, } from '../server/telemetry.ts';
import type { TelemetryOptions } from '../server/telemetry.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface SentException {
  type: string;
  mechanism: { handled: boolean };
  stacktrace: { frames: Array<{ platform: string; filename: string }> };
}

interface SentEvent {
  event: string;
  timestamp: string;
  properties: { $exception_level?: string; $exception_list: SentException[] };
}

const PACKAGE_ROOT = '/opt/glimmervoid';
const CREDENTIAL_URL = 'https://alice:hunter2secret@git.example.com/private-repo.git';
const HOME_PATH = '/home/alice/private-repo';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(process.env.GLIMMERVOID_HOME ?? os.tmpdir(), 'telemetry-errors-'));
}

function buildTelemetry(overrides: Partial<TelemetryOptions> = {}) {
  const sentBodies: string[] = [];
  const fetchFn: typeof fetch = (_input, init) => {
    sentBodies.push(String(init?.body));
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  const stateDir = makeStateDir();
  const telemetry = createTelemetry({
    config: {},
    env: {},
    fetchFn,
    stateFilePath: path.join(stateDir, 'telemetry.json'),
    pendingCrashFilePath: path.join(stateDir, 'telemetry-pending-crash.json'),
    packageRoot: PACKAGE_ROOT,
    version: '9.9.9',
    installFlavor: 'npm-global',
    isBundled: true,
    isDevInstall: false,
    logger: { warn: () => {}, log: () => {} },
    ...overrides,
  });
  const sentEvents = (): SentEvent[] => sentBodies.flatMap((body) => JSON.parse(body).batch);
  return { telemetry, sentBodies, sentEvents };
}

function appError(name: string, message: string, functionName = 'handleThing'): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at ${functionName} (${PACKAGE_ROOT}/server/thing.ts:10:5)\n    at ${PACKAGE_ROOT}/node_modules/ws/lib/x.js:1:1`;
  return error;
}

function exceptionLevelOf(event: SentEvent): string | undefined {
  return event.properties.$exception_level;
}

test('the crash monitor writes a fatal exception that the next boot sends and then deletes', async () => {
  const stateDir = makeStateDir();
  const pendingCrashFilePath = path.join(stateDir, 'telemetry-pending-crash.json');
  const crashSource = new EventEmitter();
  const crashed = buildTelemetry({ pendingCrashFilePath });
  crashed.telemetry.watchForCrashes(crashSource);
  crashSource.emit('uncaughtExceptionMonitor', appError('TypeError', 'boom'), 'uncaughtException');
  await crashed.telemetry.stop();
  assert.equal(crashSource.listenerCount('uncaughtExceptionMonitor'), 0);
  const pending = JSON.parse(fs.readFileSync(pendingCrashFilePath, 'utf8'));
  assert.equal(pending.properties.$exception_level, 'fatal');
  assert.equal(pending.properties.$exception_list[0].mechanism.handled, false);

  const nextBoot = buildTelemetry({ pendingCrashFilePath });
  await nextBoot.telemetry.sendPendingCrash();
  await nextBoot.telemetry.stop();
  const [sent] = nextBoot.sentEvents();
  assert.equal(nextBoot.sentEvents().length, 1);
  assert.equal(sent.event, '$exception');
  assert.equal(sent.timestamp, pending.timestamp);
  assert.equal(exceptionLevelOf(sent), 'fatal');
  assert.equal(fs.existsSync(pendingCrashFilePath), false);
});

test('a credential URL or home path inside an error message never reaches any payload', async () => {
  const pendingCrashFilePath = path.join(makeStateDir(), 'telemetry-pending-crash.json');
  const leakyMessage = `clone ${CREDENTIAL_URL} into ${HOME_PATH} failed`;
  const crashed = buildTelemetry({ pendingCrashFilePath });
  crashed.telemetry.recordFatalCrash(appError('Error', leakyMessage));
  await crashed.telemetry.stop();
  const crashFileText = fs.readFileSync(pendingCrashFilePath, 'utf8');

  const { telemetry, sentBodies } = buildTelemetry({ pendingCrashFilePath });
  await telemetry.sendPendingCrash();
  telemetry.captureException(appError('Error', leakyMessage), { handled: true });
  telemetry.captureClientError({ name: 'Error', stack: `Error: ${leakyMessage}\n    at go (${CREDENTIAL_URL}:1:2)\n    at go (file://${HOME_PATH}/x.js:1:2)` });
  await telemetry.stop();
  assert.equal(sentBodies.length >= 1, true);
  for (const payload of [crashFileText, ...sentBodies]) {
    assert.equal(payload.includes('hunter2secret'), false);
    assert.equal(payload.includes('alice'), false);
    assert.equal(payload.includes('/home/'), false);
    assert.equal(payload.includes('clone '), false);
  }
});

test('a control handler rejection is captured as a handled exception and a client-error is routed to telemetry', async () => {
  const capturedExceptions: Array<{ error: unknown; handled: boolean }> = [];
  const capturedClientErrors: Array<{ name: string; stack: string }> = [];
  const rejection = new Error('usage failed');
  const server = createControlServer(controlDeps({ projects: [] }, {
    requestUsageReport: () => Promise.reject(rejection),
    telemetry: {
      captureException: (error, { handled }) => { capturedExceptions.push({ error, handled }); },
      captureClientError: (report) => { capturedClientErrors.push(report); },
    },
  }));
  const connection = connectControl(server);
  connection.sent.length = 0;
  await connection.send({ type: 'request-usage-report', requestId: 'usage-1' });
  connection.send({ type: 'client-error', name: 'TypeError', stack: '    at x (http://localhost/app.js:1:2)', message: 'ignored' });
  assert.deepEqual(capturedExceptions, [{ error: rejection, handled: true }]);
  assert.deepEqual(capturedClientErrors, [{ name: 'TypeError', stack: '    at x (http://localhost/app.js:1:2)' }]);
  assert.deepEqual(connection.sent, []);
});
