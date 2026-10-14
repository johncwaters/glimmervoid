import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientMessage } from '../../shared/contracts/control-messages.ts';
import { intents, parseIntentFile } from './intents.ts';
import type { Intent } from './intents.ts';
import type { Arguments } from './arguments.ts';
import { openControl, saveScreen } from './control.ts';
import { builtServerEntryPath, repoRoot, prepareInstance, startInstance } from './instance.ts';
import { acquireBatchLock, buildBatch, checkEnvironment } from './preflight.ts';
import { collectRecords, readDecisionLines, writeJson } from './records.ts';
import { seedBatchSnapshot, seedTarget } from './seed.ts';
import type { BatchSnapshot } from './seed.ts';
import { checkGate, readGateProof, readRealCommits } from './gate.ts';
import { removeInside } from './cleanup.ts';
import { targets } from './targets.ts';
import { summaryRows } from './summary.ts';
import { bridgeSocketPathRefusal, decideVerdict, findUnrecoveredException, parseDecisionLines, unexpectedAcceptanceError } from './verdict.ts';
import type { VerdictInput } from './verdict.ts';
import { adoptRunHomeRemoteSwitch, resolveHarnessTelemetryInputs, sendRunTelemetry } from './telemetry.ts';
import { decideHarnessTelemetry } from './telemetry-core.ts';
import { HARNESS_STATE_FILE_NAME, HARNESS_VERDICT_FILE_NAME, factoryHarnessRunsDirectory, harnessBatchName, harnessRunName } from '../../server/factory/core/factory-harness-mirror-core.ts';
import type { HarnessTelemetryInputs, RecordedVerdict } from './telemetry-core.ts';

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function runOnce(
  intent: Intent, options: Arguments, recordDirectory: string, interrupt: AbortSignal,
  telemetryInputs: HarnessTelemetryInputs, stateDirectory: string, runIndex: number, snapshot: BatchSnapshot | null, runtimeParent: string,
): Promise<{ recordedVerdict: RecordedVerdict; telemetryInputsAfterRun: HarnessTelemetryInputs; hasKeptRun: boolean; wasGateRefused: boolean }> {
  const input: VerdictInput = {
    intentName: intent.name, expectedEnd: intent.expectedEnd, expectedRefusal: intent.expectedRefusal, projectId: intent.request.projectId,
    startedAt: new Date().toISOString(), endedAt: '', queueReply: null, queueRepliedAt: null,
    broadcasts: [], decisionLines: [], originCommits: [], sessionIds: [], stopReason: 'exception', errors: [],
    gate: snapshot ? {
      snapshotRealMain: snapshot.realMain, snapshotMain: snapshot.snapshotMain, originPath: null,
      before: { main: null, originMain: null }, after: { main: null, originMain: null },
      remotes: null, leakedCommits: null, isCommitListCapped: false, proofErrors: [],
    } : null,
  };
  const listedSessionIds = new Set<string>();
  const controller = new AbortController();
  const workLimitMinutes = targets[options.target].workLimitMinutes;
  const deadline = workLimitMinutes === null ? new AbortController().signal : AbortSignal.timeout(workLimitMinutes * 60_000);
  const signal = AbortSignal.any([interrupt, deadline, controller.signal]);
  let tempDirectory: string | null = null;
  let prepared: Awaited<ReturnType<typeof prepareInstance>> | null = null;
  let target: Awaited<ReturnType<typeof seedTarget>> | null = null;
  let instance: Awaited<ReturnType<typeof startInstance>> | null = null;
  let control: Awaited<ReturnType<typeof openControl>> | null = null;
  let stateWrites: Promise<void> = Promise.resolve();
  let wasGateRefused = false;
  let hasTerminalStopReason = false;
  let telemetryInputsAfterRun = telemetryInputs;
  const instanceTelemetry = decideHarnessTelemetry(telemetryInputs);
  const statePath = path.join(recordDirectory, HARNESS_STATE_FILE_NAME);
  const queuedIntent = ClientMessage.parse({ type: 'factory-queue-intent', requestId: 'factory-harness', ...intent.request });
  await writeJson(path.join(recordDirectory, 'intent.json'), { name: intent.name, expectedEnd: intent.expectedEnd, expectedRefusal: intent.expectedRefusal, queuedIntent });
  await writeJson(path.join(recordDirectory, 'queue-reply.json'), null);
  await writeFile(statePath, '');
  await writeFile(path.join(recordDirectory, 'server.log'), '');
  await writeFile(path.join(recordDirectory, 'origin-main.log'), '');
  await writeFile(path.join(recordDirectory, 'ledger.log'), '');
  await mkdir(path.join(recordDirectory, 'decisions'));
  await mkdir(path.join(recordDirectory, 'recordings'));
  try {
    if (input.gate) input.gate.before = await readRealCommits(repoRoot);
    tempDirectory = path.join(runtimeParent, path.basename(recordDirectory));
    await mkdir(tempDirectory);
    signal.throwIfAborted();
    target = await seedTarget(tempDirectory, options.target, snapshot, signal);
    signal.throwIfAborted();
    prepared = await prepareInstance(tempDirectory, { projectPath: target.projectPath, projectId: intent.seedProjectId }, options.factory, instanceTelemetry);
    await writeJson(path.join(recordDirectory, 'instance.json'), { tempDirectory, ...prepared, target: options.target, snapshot, projectPath: target.projectPath, originPath: target.originPath });
    signal.throwIfAborted();
    if (snapshot) await checkGate(target, snapshot);
    instance = await startInstance(prepared, path.join(recordDirectory, 'server.log'), instanceTelemetry);
    await instance.waitUntilReady(signal);
    control = await openControl(prepared.port, signal, (broadcast) => {
      input.broadcasts.push(broadcast);
      stateWrites = stateWrites.then(() => appendFile(statePath, `${JSON.stringify(broadcast)}\n`)).catch((error: unknown) => { input.errors.push(errorText(error)); controller.abort(); });
      for (const project of broadcast.state.projects) {
        if (project.orchestrator) input.sessionIds.push(project.orchestrator.sessionId);
        for (const worker of project.liveWorkers ?? []) input.sessionIds.push(worker.sessionId);
      }
    }, (reply, arrivedAt) => {
      input.queueReply = reply; input.queueRepliedAt = arrivedAt;
      const acceptanceError = unexpectedAcceptanceError(intent.expectedEnd, reply);
      if (!acceptanceError) return;
      input.errors.push(acceptanceError);
      controller.abort();
    }, (sessionId) => listedSessionIds.add(sessionId), (error) => { input.errors.push(error.message); controller.abort(); });
    control.queue(queuedIntent);
    let previousUnrecoveredException: string | null = null;
    while (!signal.aborted) {
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) throw new Error('Built instance exited during the run');
      if (input.queueReply?.ok === false) { input.stopReason = 'refused'; hasTerminalStopReason = true; break; }
      const project = input.broadcasts.at(-1)?.state.projects.find((candidate) => candidate.projectId === input.projectId);
      if (input.queueReply?.workId && project?.heading.action === 'steady' && project.orders.some((order) => order.id === input.queueReply?.workId && order.state === 'completed')) { input.stopReason = 'completed'; hasTerminalStopReason = true; break; }
      const decisions = parseDecisionLines(await readDecisionLines(prepared.isolatedHome, input.projectId, false));
      const unrecoveredException = findUnrecoveredException(project?.error, decisions.decisions);
      if ((unrecoveredException !== null && unrecoveredException === previousUnrecoveredException) || decisions.invalidDecisionLines.length > 0) { input.stopReason = 'exception'; hasTerminalStopReason = true; break; }
      previousUnrecoveredException = unrecoveredException;
      await sleep(500, undefined, { signal });
    }
    input.decisionLines = await readDecisionLines(prepared.isolatedHome, input.projectId, false);
    const interim = decideVerdict({ ...input, endedAt: new Date().toISOString() });
    if (interim.failureClass === 'stalled') {
      const screenDirectory = path.join(recordDirectory, 'screens');
      await mkdir(screenDirectory);
      const sessions = new Set([...input.sessionIds, ...listedSessionIds]);
      for (const sessionId of sessions) {
        signal.throwIfAborted();
        try {
          const screen = await saveScreen(control.client, sessionId);
          if (screen) await writeFile(path.join(screenDirectory, `${encodeURIComponent(sessionId)}.ansi`), screen);
        } catch (error) { input.errors.push(`Screen for session ${sessionId} was not saved: ${errorText(error)}`); }
      }
    }
  } catch (error) {
    wasGateRefused = errorText(error).startsWith('Gate refused:');
    if (wasGateRefused) console.error(errorText(error));
    if (!interrupt.aborted && !deadline.aborted) input.errors.push(errorText(error));
  } finally {
    const hadDeadlinePassedBeforeShutdown = deadline.aborted;
    controller.abort();
    control?.socket.terminate();
    try { await instance?.stop(); } catch (error) { input.errors.push(errorText(error)); }
    if (prepared) telemetryInputsAfterRun = await adoptRunHomeRemoteSwitch(telemetryInputs, prepared.isolatedHome, stateDirectory);
    await stateWrites;
    try {
      if (prepared) {
        const records = await collectRecords(prepared.isolatedHome, prepared.configPath, intent.seedProjectId, target?.originPath ?? null, recordDirectory);
        input.decisionLines = records.decisionLines;
        input.originCommits = records.originCommits;
        input.sessionIds.push(...records.spawnedSessionIds);
      }
    } catch (error) { input.errors.push(errorText(error)); }
    if (interrupt.aborted) input.stopReason = 'interrupted';
    if (!interrupt.aborted && hadDeadlinePassedBeforeShutdown && !hasTerminalStopReason) input.stopReason = 'timeout';
    if (input.gate && snapshot) {
      const originPath = target?.originPath ?? (tempDirectory ? path.join(tempDirectory, 'origin.git') : null);
      const projectPath = target?.projectPath ?? (tempDirectory ? path.join(tempDirectory, 'repo') : null);
      input.gate = { ...input.gate, ...await readGateProof(repoRoot, originPath, projectPath, snapshot.snapshotRefCommits) };
    }
    input.endedAt = new Date().toISOString();
    await writeJson(path.join(recordDirectory, 'queue-reply.json'), { arrivedAt: input.queueRepliedAt, reply: input.queueReply });
  }
  if (interrupt.aborted) input.stopReason = 'interrupted';
  let verdict = decideVerdict(input);
  if (verdict.outcome === 'pass' && !options.keep && tempDirectory) {
    try { await removeInside(runtimeParent, tempDirectory); }
    catch (error) { input.errors.push(errorText(error)); verdict = decideVerdict(input); }
  }
  await writeJson(path.join(recordDirectory, HARNESS_VERDICT_FILE_NAME), verdict);
  const telemetrySendResult = await sendRunTelemetry({
    verdict, decision: decideHarnessTelemetry(telemetryInputsAfterRun), builtServerEntryPath,
    context: { isCustomIntent: Boolean(options.intentFile), runIndex, batchSize: options.runs },
  });
  const recordedVerdict = { ...verdict, telemetrySendResult };
  await writeJson(path.join(recordDirectory, HARNESS_VERDICT_FILE_NAME), recordedVerdict);
  return { recordedVerdict, telemetryInputsAfterRun, hasKeptRun: tempDirectory !== null && (options.keep || verdict.outcome !== 'pass'), wasGateRefused };
}

export async function runBatch(options: Arguments): Promise<number> {
  let intent = intents.find((candidate) => candidate.name === options.intentName);
  if (options.intentFile) {
    intent = parseIntentFile(JSON.parse(await readFile(options.intentFile, 'utf8')));
    ClientMessage.parse({ type: 'factory-queue-intent', requestId: 'factory-harness', ...intent.request });
  }
  if (!intent) throw new Error(`Unknown intent: ${options.intentName}`);
  if (!options.intentFile && intent.target !== options.target) throw new Error(`Intent ${intent.name} belongs to target ${intent.target}, not ${options.target}`);
  await checkEnvironment();
  const runtimeParent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-run-')));
  const socketRefusal = bridgeSocketPathRefusal(path.join(runtimeParent, harnessRunName(options.runs), 'tmp'), process.platform);
  if (socketRefusal) {
    await rmdir(runtimeParent);
    throw new Error(socketRefusal);
  }
  const stateDirectory = factoryHarnessRunsDirectory(process.env, os.homedir());
  const parent = options.artifacts ?? stateDirectory;
  const requestedBatchDirectory = path.resolve(parent, harnessBatchName(new Date(), randomUUID()));
  await mkdir(requestedBatchDirectory, { recursive: true });
  const batchDirectory = await realpath(requestedBatchDirectory);
  const interrupt = new AbortController();
  let interruptedSignal: NodeJS.Signals | null = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const onSignal = (signal: NodeJS.Signals) => { interruptedSignal ??= signal; interrupt.abort(); };
  for (const signal of signals) process.on(signal, onSignal);
  const verdicts: RecordedVerdict[] = [];
  let environmentFailure: unknown = null;
  let snapshot: BatchSnapshot | null = null;
  let hasKeptRun = options.keep;
  let hasPendingRun = false;
  let wasGateRefused = false;
  let releaseBatchLock: (() => Promise<void>) | null = null;
  try {
    releaseBatchLock = await acquireBatchLock();
    let telemetryInputs = await resolveHarnessTelemetryInputs(options.noTelemetry, stateDirectory);
    if (options.target === 'gated-clone') snapshot = await seedBatchSnapshot(batchDirectory, repoRoot, interrupt.signal);
    await buildBatch(interrupt.signal);
    for (let run = 1; run <= options.runs; run++) {
      if (interrupt.signal.aborted) break;
      const recordDirectory = path.join(batchDirectory, harnessRunName(run));
      await mkdir(recordDirectory);
      hasPendingRun = true;
      const completedRun = await runOnce(intent, options, recordDirectory, interrupt.signal, telemetryInputs, stateDirectory, run, snapshot, runtimeParent);
      hasPendingRun = false;
      telemetryInputs = completedRun.telemetryInputsAfterRun;
      verdicts.push(completedRun.recordedVerdict);
      hasKeptRun ||= completedRun.hasKeptRun;
      wasGateRefused ||= completedRun.wasGateRefused;
      if (completedRun.recordedVerdict.gate?.held === false || wasGateRefused) break;
    }
  } catch (error) { environmentFailure = error; }
  finally {
    try {
      if (options.target === 'gated-clone' && !hasKeptRun && !hasPendingRun) {
        try { await removeInside(batchDirectory, path.join(batchDirectory, 'staging.git')); }
        catch (error) { environmentFailure ??= error; }
      }
      try { await rmdir(runtimeParent); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST')) environmentFailure ??= error;
      }
      const rows = summaryRows(verdicts);
      await writeJson(path.join(batchDirectory, 'summary.json'), { batchDirectory, target: options.target, snapshot, rows, skippedRuns: Array.from({ length: options.runs - verdicts.length }, (_, index) => index + verdicts.length + 1) });
      console.table(rows.map((row) => ({ ...row, attemptsPerOrder: JSON.stringify(row.attemptsPerOrder) })));
      console.log(`Records: ${batchDirectory}`);
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
      await releaseBatchLock?.();
    }
  }
  if (interruptedSignal) return 128 + os.constants.signals[interruptedSignal];
  if (environmentFailure) throw environmentFailure;
  if (wasGateRefused) return 2;
  return verdicts.every((verdict) => verdict.outcome === 'pass') ? 0 : 1;
}
