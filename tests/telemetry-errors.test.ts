import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelemetry, MAX_REPORTED_EXCEPTION_FINGERPRINTS } from '../server/telemetry.ts';
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

function exceptionTypesOf(events: SentEvent[]): string[] {
  return events.map((event) => event.properties.$exception_list[0].type);
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

test('a pending crash is deleted unsent when consent is off at the next boot', async () => {
  const pendingCrashFilePath = path.join(makeStateDir(), 'telemetry-pending-crash.json');
  const crashed = buildTelemetry({ pendingCrashFilePath });
  crashed.telemetry.recordFatalCrash(appError('TypeError', 'boom'));
  await crashed.telemetry.stop();
  assert.equal(fs.existsSync(pendingCrashFilePath), true);

  const nextBoot = buildTelemetry({ pendingCrashFilePath, env: { DO_NOT_TRACK: '1' } });
  await nextBoot.telemetry.sendPendingCrash();
  await nextBoot.telemetry.stop();
  assert.equal(nextBoot.sentBodies.length, 0);
  assert.equal(fs.existsSync(pendingCrashFilePath), false);
});

test('a pending crash survives a boot whose send fails or is rejected, and the next successful send removes it', async () => {
  const pendingCrashFilePath = path.join(makeStateDir(), 'telemetry-pending-crash.json');
  const crashed = buildTelemetry({ pendingCrashFilePath });
  crashed.telemetry.recordFatalCrash(appError('TypeError', 'boom'));
  await crashed.telemetry.stop();

  const offlineBoot = buildTelemetry({ pendingCrashFilePath, fetchFn: () => Promise.reject(new TypeError('fetch failed')) });
  await offlineBoot.telemetry.sendPendingCrash();
  await offlineBoot.telemetry.stop();
  assert.equal(fs.existsSync(pendingCrashFilePath), true);

  const rejectedBoot = buildTelemetry({ pendingCrashFilePath, fetchFn: () => Promise.resolve(new Response('{}', { status: 503 })) });
  await rejectedBoot.telemetry.sendPendingCrash();
  await rejectedBoot.telemetry.stop();
  assert.equal(fs.existsSync(pendingCrashFilePath), true);

  const onlineBoot = buildTelemetry({ pendingCrashFilePath });
  await onlineBoot.telemetry.sendPendingCrash();
  await onlineBoot.telemetry.stop();
  assert.equal(onlineBoot.sentEvents().length, 1);
  assert.equal(fs.existsSync(pendingCrashFilePath), false);
});

test('an invalid pending crash file is removed without sending', async () => {
  const pendingCrashFilePath = path.join(makeStateDir(), 'telemetry-pending-crash.json');
  fs.writeFileSync(pendingCrashFilePath, '{"not":"a crash"}');
  const { telemetry, sentBodies } = buildTelemetry({ pendingCrashFilePath });
  await telemetry.sendPendingCrash();
  await telemetry.stop();
  assert.equal(sentBodies.length, 0);
  assert.equal(fs.existsSync(pendingCrashFilePath), false);
});

test('the crash monitor writes nothing when consent is off at the time of the crash', async () => {
  const pendingCrashFilePath = path.join(makeStateDir(), 'telemetry-pending-crash.json');
  const { telemetry } = buildTelemetry({ pendingCrashFilePath, config: { telemetry: { enabled: false } } });
  telemetry.recordFatalCrash(appError('TypeError', 'boom'));
  await telemetry.stop();
  assert.equal(fs.existsSync(pendingCrashFilePath), false);
});

test('a repeated exception is sent once per process whatever its message', async () => {
  const { telemetry, sentEvents } = buildTelemetry();
  telemetry.captureException(appError('TypeError', 'first message'), { handled: true });
  telemetry.captureException(appError('TypeError', 'second message'), { handled: true });
  telemetry.captureException(appError('RangeError', 'first message'), { handled: true });
  telemetry.captureException(appError('TypeError', 'first message', 'otherFunction'), { handled: true });
  await telemetry.stop();
  assert.deepEqual(exceptionTypesOf(sentEvents()), ['TypeError', 'RangeError', 'TypeError']);
});

test('the dedupe set stops reporting new exceptions once it holds its cap', async () => {
  const { telemetry, sentEvents } = buildTelemetry();
  for (let index = 0; index < MAX_REPORTED_EXCEPTION_FINGERPRINTS + 10; index += 1) {
    telemetry.captureException(appError(`Error${index}`, 'boom'), { handled: true });
  }
  await telemetry.flush();
  await telemetry.stop();
  assert.equal(sentEvents().length, MAX_REPORTED_EXCEPTION_FINGERPRINTS);
});

test('a browser error keeps only URL paths in its frames and is reported unhandled at error level', async () => {
  const { telemetry, sentEvents } = buildTelemetry();
  telemetry.captureClientError({
    name: 'TypeError',
    stack: '    at renderCard (http://localhost:4400/assets/app-abc.js?v=3#frag:10:5)\n    at http://127.0.0.1:5173/public/app.ts:2:1',
  });
  telemetry.captureClientError({
    name: 'TypeError',
    stack: '    at renderCard (http://localhost:4400/assets/app-abc.js?v=4:10:5)\n    at http://127.0.0.1:5173/public/app.ts:2:1',
  });
  await telemetry.stop();
  assert.equal(sentEvents().length, 1);
  const [exception] = sentEvents()[0].properties.$exception_list;
  assert.equal(exceptionLevelOf(sentEvents()[0]), 'error');
  assert.equal(exception.mechanism.handled, false);
  assert.deepEqual(exception.stacktrace.frames.map((frame) => [frame.platform, frame.filename]), [
    ['web:javascript', '/public/app.ts'],
    ['web:javascript', '/assets/app-abc.js'],
  ]);
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
