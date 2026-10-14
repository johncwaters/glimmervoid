import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { decideTelemetryConsent, resolveProjectToken } from '../server/core/telemetry-core.ts';
import { TELEMETRY_BASE_PROPERTY_KEYS, TelemetryState } from '../shared/contracts/telemetry.ts';
import { FactoryState } from '../shared/contracts/factory.ts';
import { factoryHarnessRunsDirectory } from '../server/factory/core/factory-harness-mirror-core.ts';
import { builtServerEntryPath, prepareInstance } from '../test/factory/instance.ts';
import {
  FactoryHarnessBaseProperties, FactoryHarnessBatch, FactoryHarnessRunProperties,
  buildRunTelemetryBatch, buildRunTelemetryProperties, decideHarnessTelemetry, parseHarnessInstallState,
} from '../test/factory/telemetry-core.ts';
import type { HarnessTelemetryInputs } from '../test/factory/telemetry-core.ts';
import { adoptRunHomeRemoteSwitch, loadHarnessInstallState, resolveHarnessTelemetryInputs, sendRunTelemetry } from '../test/factory/telemetry.ts';
import { removeInside, resolveInside } from '../test/factory/cleanup.ts';
import { bridgeSocketPathRefusal, decideGate, decideVerdict, findUnrecoveredException, matchedProductText, parseDecisionLines, pidsStillNamingSameProcess, processesUsingBuildOutput, readBuildOutput, unexpectedAcceptanceError } from '../test/factory/verdict.ts';
import type { GateEvidence, VerdictInput } from '../test/factory/verdict.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const verifyCloseSubject = `${matchedProductText.verifyCloseSubject.text}intent`;

const startedAt = '2026-10-11T00:00:00.000Z';
const endedAt = '2026-10-11T00:01:00.000Z';
const workerSha = 'a'.repeat(40);
const completedBroadcast = {
  arrivedAt: endedAt,
  state: FactoryState.parse({ type: 'factory-state', ts: Date.parse(endedAt), projects: [{
    projectId: 'seed', projectName: 'Seed', headSha: workerSha, paused: false, orchestrator: null, error: null,
    heading: { action: 'steady', reasons: [] }, orders: [{
      id: 'intent', objective: 'Add subtract', openedAt: startedAt, criteria: ['subtract works'], boundary: 'Seed',
      risk: 'low', state: 'completed', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src'], owner: null, lastEvent: null,
    }], conflicts: [], unverifiedCompletedWork: [],
  }] }),
};

function decision(overrides: Record<string, unknown>) {
  return JSON.stringify({ timestamp: endedAt, projectId: 'seed', outcome: 'raised', workId: 'worker', intentId: 'intent', sessionId: 'session', attempt: 1, durationMs: 0, failureClass: 'exception', reason: 'Failure', kind: 'exception', ...overrides });
}

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return { intentName: 'one-file-change', expectedEnd: 'completed', expectedRefusal: null, projectId: 'seed', startedAt, endedAt,
    queueReply: { projectId: 'seed', ok: true, workId: 'intent' }, queueRepliedAt: startedAt,
    broadcasts: [], decisionLines: [], originCommits: [], sessionIds: [], stopReason: 'timeout', errors: [], ...overrides };
}

function completingInput(): VerdictInput {
  return input({ stopReason: 'completed', broadcasts: [completedBroadcast],
    decisionLines: [decision({ kind: 'merge', outcome: 'merged', failureClass: null, reason: null, mergedSha: workerSha })],
    originCommits: [{ sha: workerSha, subject: 'Add subtract' }, { sha: 'b'.repeat(40), subject: verifyCloseSubject }],
  });
}

test('a run keeps going past a block the orchestrator can re-plan and stops on any other exception', () => {
  const blockReason = 'Needs write scope: tests/pending-wakeup.test.ts';
  const blocked = parseDecisionLines([
    decision({ kind: 'exception', outcome: 'raised', failureClass: 'exception', reason: blockReason }),
    decision({ kind: 'admission', outcome: 'block', failureClass: 'check', reason: blockReason }),
  ]).decisions;
  assert.equal(findUnrecoveredException(blockReason, blocked), null);
  const stalled = [...blocked, ...parseDecisionLines([decision({ kind: 'exception', outcome: 'stalled', failureClass: 'stall', reason: 'factory orchestrator idle' })]).decisions];
  assert.equal(findUnrecoveredException(blockReason, stalled), 'factory orchestrator idle');
  assert.equal(findUnrecoveredException('Ledger is unreadable', blocked), 'Ledger is unreadable');
});

test('completion requires steady completion and both worker and verify-close commits on origin', () => {
  const verdict = decideVerdict(completingInput());
  assert.equal(verdict.outcome, 'pass');
  assert.equal(verdict.failureClass, null);
  assert.equal(verdict.milestonesMs.completed, 60_000);
  assert.equal(verdict.sessionCount, 1);
  assert.deepEqual(verdict.attemptsPerOrder, { worker: 1 });
  const missingWorker = decideVerdict({ ...completingInput(), originCommits: [{ sha: 'b'.repeat(40), subject: verifyCloseSubject }] });
  assert.equal(missingWorker.outcome, 'fail');
  assert.equal(missingWorker.failureClass, 'exception');
});

test('a gated completion holds on a clean proof whatever real main did, a leaked commit or foreign remote is a breach over every other failure, and a missing proof fails closed without claiming one', () => {
  const originPath = '/runtime/0001/origin.git';
  const origin = { name: 'origin', fetchUrls: [originPath], pushUrls: [originPath], resolvedFetchPaths: [originPath], resolvedPushPaths: [originPath] };
  const gate: GateEvidence = {
    snapshotRealMain: workerSha, snapshotMain: 'c'.repeat(40), originPath,
    before: { main: workerSha, originMain: workerSha }, after: { main: 'd'.repeat(40), originMain: 'd'.repeat(40) },
    remotes: [origin], leakedCommits: [], isCommitListCapped: false, proofErrors: [],
  };
  const held = decideVerdict({ ...completingInput(), gate });
  assert.equal(held.outcome, 'pass');
  assert.deepEqual(held.gate, { ...gate, held: true });
  const breached = decideVerdict({ ...completingInput(), stopReason: 'interrupted', gate: { ...gate, leakedCommits: [workerSha] } });
  assert.equal(breached.outcome, 'fail');
  assert.equal(breached.failureClass, 'exception');
  assert.equal(breached.gate?.held, false);
  assert.match(breached.reason ?? '', /gate did not hold/);
  assert.equal(decideGate({ ...gate, remotes: [origin, { ...origin, name: 'upstream' }] })?.held, false);
  const withoutProof = { ...gate, originPath: null, remotes: null, leakedCommits: null, proofErrors: ['working clone was never made'] };
  const unavailable = decideVerdict({ ...completingInput(), gate: withoutProof });
  assert.deepEqual([unavailable.outcome, unavailable.failureClass, unavailable.gate?.held, unavailable.reason], ['fail', 'exception', null, 'Gate proof unavailable']);
  const recoveredCheckRetry = decision({ kind: 'closeout', outcome: 'block', failureClass: 'check', fence: null, checks: [], review: null });
  assert.equal(decideVerdict({ ...completingInput(), decisionLines: [recoveredCheckRetry, ...completingInput().decisionLines], gate: withoutProof }).failureClass, 'exception');
  const interrupted = decideVerdict({ ...completingInput(), stopReason: 'interrupted', gate: withoutProof });
  assert.deepEqual([interrupted.failureClass, interrupted.gate?.held, interrupted.reason], ['interrupted', null, null]);
  assert.equal(decideVerdict(completingInput()).gate, null);
});

test('the refusal expected end passes only the expected refusal and fails another refusal or an accepted intent', () => {
  const refusal = (error: string) => decideVerdict(input({ expectedEnd: 'refused', expectedRefusal: 'Unknown factory project', stopReason: 'refused', queueReply: { projectId: 'seed', ok: false, error } }));
  const refused = refusal('Unknown factory project');
  assert.equal(refused.outcome, 'pass');
  assert.equal(refused.failureClass, null);
  const mismatched = refusal('Factory is not running');
  assert.equal(mismatched.outcome, 'fail');
  assert.equal(mismatched.failureClass, 'queue-refused');
  assert.equal(mismatched.queueReplyError, 'Factory is not running');
  const accepted = decideVerdict({ ...completingInput(), expectedEnd: 'refused' });
  assert.equal(accepted.outcome, 'fail');
  assert.equal(accepted.failureClass, 'exception');
  assert.match(unexpectedAcceptanceError('refused', completingInput().queueReply) ?? '', /accepted an intent it was expected to refuse/);
});

test('the product source still contains every literal the verdict matches', () => {
  for (const { sourceFile, text } of Object.values(matchedProductText)) {
    assert.ok(fs.readFileSync(path.join(repoRoot, sourceFile), 'utf8').includes(text), `${sourceFile} no longer contains "${text}"`);
  }
});

test('a process running from the dist of this checkout, or one whose relative argument names a dist file or a dist folder path from an unreadable working directory, blocks the batch build, while a bare word naming a dist folder does not, and so does a check sandbox socket path past the unix limit', async () => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'factory-build-output-test-'));
  try {
    const distDirectory = path.join(checkout, 'dist');
    await mkdir(path.join(distDirectory, 'server'), { recursive: true });
    await mkdir(path.join(distDirectory, 'bin'), { recursive: true });
    await writeFile(path.join(distDirectory, 'server', 'index.js'), '');
    await writeFile(path.join(distDirectory, 'bin', 'glimmervoid.js'), '');
    const buildOutput = await readBuildOutput(distDirectory);
    const serverEntry = path.join(distDirectory, 'server', 'index.js');
    const located = (pid: number, resolvedArguments: string[], unresolvedRelativeArguments: string[] = []) => ({ pid, command: '', resolvedArguments, unresolvedRelativeArguments });
    const conflicts = processesUsingBuildOutput([
      located(1, ['/usr/bin/node', serverEntry]),
      located(2, ['/usr/bin/node', '/other-checkout/dist/server/index.js']),
      located(3, ['/usr/bin/node', path.join(distDirectory, 'bin', 'glimmervoid.js')]),
      located(4, ['/usr/bin/node'], ['dist/server/index.js']),
      located(5, ['/usr/bin/node'], ['../bin/glimmervoid.js']),
      located(6, ['/usr/sbin/sshd'], ['listener', 'startups']),
      located(7, ['/usr/bin/node', path.join(checkout, 'test', 'factory', 'run.ts')]),
      located(8, ['/usr/bin/node', serverEntry]),
      { ...located(9, []), command: `node ${serverEntry}` },
      located(10, ['/usr/bin/weed'], ['server', 'dist']),
      located(11, ['/usr/bin/node'], ['dist/server']),
      located(12, ['/usr/bin/node'], ['../dist/server']),
    ], buildOutput, 8);
    assert.deepEqual(conflicts.map((conflict) => conflict.pid), [1, 3, 4, 5, 9, 11, 12]);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
  assert.equal(bridgeSocketPathRefusal('/tmp/glimmervoid-factory-run-XXXXXX/0001/tmp', 'linux'), null);
  assert.equal(bridgeSocketPathRefusal(`/${'a'.repeat(71)}`, 'linux'), null);
  assert.match(bridgeSocketPathRefusal(`/${'a'.repeat(72)}`, 'linux') ?? '', /needs 108 bytes and a unix socket path holds 107/);
  assert.equal(bridgeSocketPathRefusal(`/${'a'.repeat(72)}`, 'darwin'), null);
});

test('bounded removal reaches a child through a symlinked parent and still refuses a path that leaves it', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'factory-bounded-removal-test-'));
  try {
    const realBatchDirectory = path.join(tempDirectory, 'real-batch');
    const linkedBatchDirectory = path.join(tempDirectory, 'linked-batch');
    const outsideDirectory = path.join(tempDirectory, 'outside');
    await mkdir(path.join(realBatchDirectory, 'run'), { recursive: true });
    await mkdir(outsideDirectory);
    await symlink(realBatchDirectory, linkedBatchDirectory);
    await symlink(outsideDirectory, path.join(realBatchDirectory, 'escape'));
    assert.equal(await resolveInside(linkedBatchDirectory, path.join(linkedBatchDirectory, 'not-made-yet')), path.join(await fs.promises.realpath(realBatchDirectory), 'not-made-yet'));
    await removeInside(linkedBatchDirectory, path.join(linkedBatchDirectory, 'run'));
    assert.deepEqual(await readdir(realBatchDirectory), ['escape']);
    await assert.rejects(removeInside(linkedBatchDirectory, path.join(linkedBatchDirectory, 'escape')), /Refusing path outside/);
    await assert.rejects(removeInside(linkedBatchDirectory, linkedBatchDirectory), /Refusing path outside/);
    await assert.rejects(removeInside(linkedBatchDirectory, outsideDirectory), /Refusing path outside/);
    assert.deepEqual(await readdir(tempDirectory), ['linked-batch', 'outside', 'real-batch']);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test('a recorded descendant is signalled only while its pid still carries the recorded start time', () => {
  const recordedStart = 'Sun Oct 11 14:35:27 2026';
  const recorded = [{ pid: 10, startedAt: recordedStart }, { pid: 11, startedAt: recordedStart }, { pid: 12, startedAt: recordedStart }, { pid: 13, startedAt: '' }];
  const current = [{ pid: 10, startedAt: recordedStart }, { pid: 11, startedAt: 'Sun Oct 11 14:35:33 2026' }, { pid: 13, startedAt: '' }];
  assert.deepEqual(pidsStillNamingSameProcess(recorded, current), [10]);
});

test('failure precedence is interrupted, queue-refused, stalled, checks, review, exception, timeout', () => {
  const closeout = (failureClass: 'check' | 'review') => decision({ kind: 'closeout', outcome: 'block', failureClass, fence: null, checks: [], review: null });
  const failures = [decision({ outcome: 'stalled', failureClass: 'stall' }), closeout('check'), closeout('review'), decision({})];
  const competing = input({ stopReason: 'interrupted', queueReply: { projectId: 'seed', ok: false }, decisionLines: failures });
  assert.equal(decideVerdict(competing).failureClass, 'interrupted');
  assert.equal(decideVerdict({ ...competing, stopReason: 'timeout' }).failureClass, 'queue-refused');
  for (const [index, expected] of ['stalled', 'checks', 'review', 'exception', 'timeout'].entries()) {
    assert.equal(decideVerdict(input({ decisionLines: failures.slice(index) })).failureClass, expected);
  }
  assert.equal(decideVerdict({ ...completingInput(), stopReason: 'interrupted' }).failureClass, 'interrupted');
});

test('malformed and schema-invalid decision lines are counted and reported without throwing', () => {
  const verdict = decideVerdict(input({ decisionLines: ['{', JSON.stringify({ kind: 'invented' })] }));
  assert.equal(verdict.invalidDecisionLineCount, 2);
  assert.deepEqual(verdict.invalidDecisionLines.map((line) => line.line), [1, 2]);
  assert.ok(verdict.invalidDecisionLines.every((line) => line.error.length > 0));
  assert.equal(verdict.failureClass, 'exception');
});

const telemetryContext = { isCustomIntent: true, runIndex: 2, batchSize: 3 };
const installId = '8f32b196-3761-4540-a6f9-4f67da58cbae';

test('the summary allowlist rejects extra keys and removes free text from a custom verdict', () => {
  const privateText = ['private-intent-file.json', 'Refused private objective', '/private/repository/path'];
  const verdict = decideVerdict(input({
    intentName: privateText[0], expectedEnd: 'refused', expectedRefusal: privateText[1], stopReason: 'refused',
    queueReply: { projectId: privateText[2], ok: false, error: privateText[1] }, errors: [privateText[2]],
  }));
  const batch = buildRunTelemetryBatch(verdict, telemetryContext, {
    installId, projectToken: 'test-token', appVersion: '0.30.0', platform: 'linux', nodeVersion: '24.0.0',
    installFlavor: 'clone', isBundled: true, timestamp: endedAt,
  });
  assert.deepEqual(Object.keys(FactoryHarnessBaseProperties.shape).sort(), [...TELEMETRY_BASE_PROPERTY_KEYS].sort());
  const properties = buildRunTelemetryProperties(verdict, telemetryContext);
  assert.deepEqual(properties, {
    intent: 'custom', expected_end: 'refused', outcome: 'fail', failure_class: 'exception', duration_ms: 60_000,
    session_count: 0, order_count: 0, max_attempt: null, spend_usd: null, run_index: 2, batch_size: 3,
  });
  assert.equal(FactoryHarnessRunProperties.safeParse({ ...properties, objective: privateText[1] }).success, false);
  assert.equal(FactoryHarnessBatch.safeParse({ ...batch, batch: [{ ...batch.batch[0], properties: { ...batch.batch[0].properties, path: privateText[2] } }] }).success, false);
  for (const text of privateText) assert.equal(JSON.stringify(batch).includes(text), false);
  const completed = buildRunTelemetryProperties(decideVerdict(completingInput()), { ...telemetryContext, isCustomIntent: false });
  assert.equal(completed.intent, 'one-file-change');
  assert.equal(completed.order_count, 2);
  assert.equal(completed.max_attempt, 1);
  assert.equal(FactoryHarnessRunProperties.safeParse({ ...properties, intent: privateText[0] }).success, false);
});

test('the stable harness identity is private, atomic, reusable, loaded only with consent and carries the remote switch between run homes', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'factory-identity-test-'));
  try {
    const stateDirectory = factoryHarnessRunsDirectory({ XDG_STATE_HOME: tempDirectory }, '/unused-home');
    assert.equal(factoryHarnessRunsDirectory({}, tempDirectory), path.join(tempDirectory, '.local/state/glimmervoid-factory-runs'));
    const identities = await Promise.all(Array.from({ length: 4 }, async () => (await loadHarnessInstallState(stateDirectory)).installId));
    const firstInstallId = identities[0];
    assert.ok(firstInstallId);
    assert.deepEqual(identities, Array(4).fill(firstInstallId));
    assert.deepEqual(parseHarnessInstallState(JSON.parse(await readFile(path.join(stateDirectory, 'install-id.json'), 'utf8'))), { installId: firstInstallId });
    assert.equal((await stat(path.join(stateDirectory, 'install-id.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(stateDirectory), ['install-id.json']);
    assert.equal(parseHarnessInstallState({ installId: 'invalid' }), null);
    await writeFile(path.join(stateDirectory, 'install-id.json'), '{');
    const replacementInstallId = (await loadHarnessInstallState(stateDirectory)).installId;
    assert.notEqual(replacementInstallId, firstInstallId);
    const consentedInputs = await resolveHarnessTelemetryInputs(false, stateDirectory, {}, tempDirectory);
    assert.deepEqual(consentedInputs, { environment: {}, noTelemetry: false, operatorConfig: {}, installId: replacementInstallId, isRemoteDisabled: false });
    assert.deepEqual(decideHarnessTelemetry(consentedInputs).childEnvironment, {});
    const untouchedStateDirectory = path.join(tempDirectory, 'untouched-state');
    const offForBatch = { runHomeSeed: null, childEnvironment: { GLIMMERVOID_TELEMETRY: '0' } };
    assert.deepEqual(decideHarnessTelemetry(await resolveHarnessTelemetryInputs(true, untouchedStateDirectory, {}, tempDirectory)), { summary: 'skipped-no-consent', ...offForBatch });
    assert.equal(fs.existsSync(untouchedStateDirectory), false);
    const danglingStateDirectory = path.join(tempDirectory, 'dangling-state');
    await mkdir(danglingStateDirectory);
    await symlink(path.join(tempDirectory, 'absent-identity-target'), path.join(danglingStateDirectory, 'install-id.json'));
    await assert.rejects(loadHarnessInstallState(danglingStateDirectory), /Cannot read the harness install identity/);
    assert.deepEqual(await readdir(danglingStateDirectory), ['install-id.json']);
    const unloadableStateDirectory = path.join(stateDirectory, 'install-id.json');
    assert.deepEqual(decideHarnessTelemetry(await resolveHarnessTelemetryInputs(false, unloadableStateDirectory, {}, tempDirectory)), { summary: 'failed', ...offForBatch });
    const prepared = await prepareInstance(tempDirectory, null, {}, decideHarnessTelemetry({ ...consentedInputs, isRemoteDisabled: true }));
    const runHomeStatePath = path.join(prepared.isolatedHome, 'telemetry.json');
    const seeded = TelemetryState.parse(JSON.parse(await readFile(runHomeStatePath, 'utf8')));
    assert.equal(seeded.installId, replacementInstallId);
    assert.equal(seeded.remoteDisabled, true);
    assert.ok(seeded.noticeShownAt && Number.isFinite(Date.parse(seeded.noticeShownAt)));
    const remotelyDisabledInputs = await adoptRunHomeRemoteSwitch(consentedInputs, prepared.isolatedHome, stateDirectory);
    assert.equal(decideHarnessTelemetry(remotelyDisabledInputs).summary, 'skipped-remote-disabled');
    assert.deepEqual(await resolveHarnessTelemetryInputs(false, stateDirectory, {}, tempDirectory), remotelyDisabledInputs);
    assert.equal(await adoptRunHomeRemoteSwitch(remotelyDisabledInputs, path.join(tempDirectory, 'missing-run-home'), stateDirectory), remotelyDisabledInputs);
    await writeFile(runHomeStatePath, JSON.stringify({ installId: replacementInstallId, remoteDisabled: false }));
    assert.deepEqual(await adoptRunHomeRemoteSwitch(remotelyDisabledInputs, prepared.isolatedHome, stateDirectory), consentedInputs);
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDirectory, 'install-id.json'), 'utf8')), { installId: replacementInstallId });
    const config = JSON.parse(await readFile(prepared.configPath, 'utf8'));
    assert.equal('telemetry' in config, false);
    assert.equal(decideTelemetryConsent({}, config).isEnabled, true);
    assert.equal(decideTelemetryConsent({ DO_NOT_TRACK: '1' }, config).isEnabled, false);
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }
});

test('the summary sender follows the shared decision, posts one batch to loopback and fails or skips without throwing or retrying', async () => {
  const postedBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    postedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/batch/');
    assert.equal(request.headers['content-type'], 'application/json');
    response.writeHead(postedBodies.length === 1 ? 200 : 503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const batchUrl = `http://127.0.0.1:${address.port}/batch/`;
  const verdict = decideVerdict(completingInput());
  const consentedInputs: HarnessTelemetryInputs = { environment: {}, noTelemetry: false, operatorConfig: {}, installId, isRemoteDisabled: false };
  const options = { verdict, context: telemetryContext, decision: decideHarnessTelemetry(consentedInputs), builtServerEntryPath, batchUrl };
  const resultFor = (inputs: Partial<HarnessTelemetryInputs>) => sendRunTelemetry({ ...options, decision: decideHarnessTelemetry({ ...consentedInputs, ...inputs }) });
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'factory-operator-config-test-'));
  try {
    assert.equal(await sendRunTelemetry(options), 'sent');
    const batch = FactoryHarnessBatch.parse(postedBodies[0]);
    assert.equal(batch.api_key, resolveProjectToken({}));
    assert.equal(batch.batch[0].distinct_id, installId);
    assert.equal(batch.batch[0].properties.app_version, JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version);
    assert.equal(batch.batch[0].properties.os_platform, process.platform);
    assert.equal(batch.batch[0].properties.$lib, 'glimmervoid');
    assert.equal(batch.batch[0].properties.$process_person_profile, false);
    assert.equal(batch.batch[0].properties.is_dev_install, true);
    assert.equal(batch.batch[0].properties.is_bundled, true);
    assert.equal(await sendRunTelemetry(options), 'failed');
    assert.equal(await sendRunTelemetry({ ...options, verdict: { ...verdict, durationMs: Number.NaN } }), 'failed');
    assert.equal(await resultFor({ noTelemetry: true }), 'skipped-no-consent');
    for (const environment of [{ DO_NOT_TRACK: '1' }, { GLIMMERVOID_TELEMETRY: '0' }, { CI: 'true' }, { NODE_TEST_CONTEXT: 'child-v8' }]) {
      assert.equal(await resultFor({ environment }), 'skipped-no-consent');
    }
    assert.equal(await resultFor({ isRemoteDisabled: true }), 'skipped-remote-disabled');
    assert.equal(await resultFor({ installId: null }), 'failed');
    const operatorConfigPath = path.join(tempDirectory, 'config.json');
    const stateDirectory = path.join(tempDirectory, 'state');
    await writeFile(operatorConfigPath, JSON.stringify({ port: 3000, telemetry: { enabled: false } }));
    for (const environment of [{ GLIMMERVOID_CONFIG: operatorConfigPath }, { GLIMMERVOID_HOME: tempDirectory }]) {
      const operatorOptOut = await resolveHarnessTelemetryInputs(false, stateDirectory, environment, '/unused-home');
      assert.deepEqual(operatorOptOut.operatorConfig, { telemetry: { enabled: false } });
      assert.equal(decideHarnessTelemetry(operatorOptOut).childEnvironment.GLIMMERVOID_TELEMETRY, '0');
      assert.equal(await sendRunTelemetry({ ...options, decision: decideHarnessTelemetry(operatorOptOut) }), 'skipped-no-consent');
    }
    await writeFile(operatorConfigPath, '{');
    assert.deepEqual((await resolveHarnessTelemetryInputs(true, stateDirectory, { GLIMMERVOID_CONFIG: operatorConfigPath }, '/unused-home')).operatorConfig, {});
    assert.equal(fs.existsSync(stateDirectory), false);
    assert.equal(postedBodies.length, 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(await sendRunTelemetry(options), 'failed');
});
