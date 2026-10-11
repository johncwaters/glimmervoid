import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../../server/config-store.ts';
import { ClientMessage } from '../../shared/contracts/control-messages.ts';
import { intents, parseIntentFile } from './intents.ts';
import type { Intent } from './intents.ts';
import type { Arguments } from './arguments.ts';
import { openControl, saveScreen } from './control.ts';
import { prepareInstance, startInstance } from './instance.ts';
import { acquireBatchLock, buildBatch, checkEnvironment } from './preflight.ts';
import { collectRecords, readDecisionLines, writeJson } from './records.ts';
import { seedTarget } from './seed.ts';
import { summaryRows } from './summary.ts';
import { decideVerdict, parseDecisionLines, unexpectedAcceptanceError } from './verdict.ts';
import type { Verdict, VerdictInput } from './verdict.ts';

const WORK_LIMIT_MINUTES = 30;

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function runOnce(intent: Intent, options: Arguments, recordDirectory: string, interrupt: AbortSignal): Promise<Verdict> {
  const input: VerdictInput = {
    intentName: intent.name, expectedEnd: intent.expectedEnd, expectedRefusal: intent.expectedRefusal, projectId: intent.request.projectId,
    startedAt: new Date().toISOString(), endedAt: '', queueReply: null, queueRepliedAt: null,
    broadcasts: [], decisionLines: [], originCommits: [], sessionIds: [], stopReason: 'exception', errors: [],
  };
  const controller = new AbortController();
  const watchWindowMinutes = options.factory.watchWindowMinutes ?? DEFAULT_CONFIG.factory.watchWindowMinutes;
  const deadline = AbortSignal.timeout((WORK_LIMIT_MINUTES + watchWindowMinutes) * 60_000);
  const signal = AbortSignal.any([interrupt, deadline, controller.signal]);
  let tempDirectory: string | null = null;
  let prepared: Awaited<ReturnType<typeof prepareInstance>> | null = null;
  let target: Awaited<ReturnType<typeof seedTarget>> | null = null;
  let instance: Awaited<ReturnType<typeof startInstance>> | null = null;
  let control: Awaited<ReturnType<typeof openControl>> | null = null;
  let stateWrites: Promise<void> = Promise.resolve();
  let hasTerminalStopReason = false;
  const statePath = path.join(recordDirectory, 'factory-state.jsonl');
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
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-run-'));
    signal.throwIfAborted();
    target = await seedTarget(tempDirectory);
    signal.throwIfAborted();
    prepared = await prepareInstance(tempDirectory, { projectPath: target.projectPath, projectId: intent.seedProjectId }, options.factory);
    await writeJson(path.join(recordDirectory, 'instance.json'), { tempDirectory, ...prepared, projectPath: target.projectPath, originPath: target.originPath });
    signal.throwIfAborted();
    instance = await startInstance(prepared, path.join(recordDirectory, 'server.log'));
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
    }, (sessionId) => input.sessionIds.push(sessionId), (error) => { input.errors.push(error.message); controller.abort(); });
    control.queue(queuedIntent);
    while (!signal.aborted) {
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) throw new Error('Built instance exited during the run');
      if (input.queueReply?.ok === false) { input.stopReason = 'refused'; hasTerminalStopReason = true; break; }
      const project = input.broadcasts.at(-1)?.state.projects.find((candidate) => candidate.projectId === input.projectId);
      if (project?.error) { input.stopReason = 'exception'; hasTerminalStopReason = true; break; }
      if (input.queueReply?.workId && project?.heading.action === 'steady' && project.orders.some((order) => order.id === input.queueReply?.workId && order.state === 'completed')) { input.stopReason = 'completed'; hasTerminalStopReason = true; break; }
      const decisions = parseDecisionLines(await readDecisionLines(prepared.isolatedHome, input.projectId, false));
      if (decisions.decisions.some((decision) => decision.kind === 'exception' || decision.outcome === 'block') || decisions.invalidDecisionLines.length > 0) { input.stopReason = 'exception'; hasTerminalStopReason = true; break; }
      await sleep(500, undefined, { signal });
    }
    input.decisionLines = await readDecisionLines(prepared.isolatedHome, input.projectId, false);
    const interim = decideVerdict({ ...input, endedAt: new Date().toISOString() });
    if (interim.failureClass === 'stalled') {
      const screenDirectory = path.join(recordDirectory, 'screens');
      await mkdir(screenDirectory);
      const sessions = new Set(input.sessionIds);
      for (const sessionId of sessions) {
        signal.throwIfAborted();
        try {
          const screen = await saveScreen(control.client, sessionId);
          if (screen) await writeFile(path.join(screenDirectory, `${encodeURIComponent(sessionId)}.ansi`), screen);
        } catch (error) { input.errors.push(`Screen for session ${sessionId} was not saved: ${errorText(error)}`); }
      }
    }
  } catch (error) {
    if (!interrupt.aborted && !deadline.aborted) input.errors.push(errorText(error));
  } finally {
    const hadDeadlinePassedBeforeShutdown = deadline.aborted;
    controller.abort();
    control?.socket.terminate();
    try { await instance?.stop(); } catch (error) { input.errors.push(errorText(error)); }
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
    input.endedAt = new Date().toISOString();
    await writeJson(path.join(recordDirectory, 'queue-reply.json'), { arrivedAt: input.queueRepliedAt, reply: input.queueReply });
  }
  if (interrupt.aborted) input.stopReason = 'interrupted';
  let verdict = decideVerdict(input);
  if (verdict.outcome === 'pass' && !options.keep && tempDirectory) {
    try { await rm(tempDirectory, { recursive: true, force: true }); }
    catch (error) { input.errors.push(errorText(error)); verdict = decideVerdict(input); }
  }
  await writeJson(path.join(recordDirectory, 'verdict.json'), verdict);
  return verdict;
}

export async function runBatch(options: Arguments): Promise<number> {
  let intent = intents.find((candidate) => candidate.name === options.intentName);
  if (options.intentFile) {
    intent = parseIntentFile(JSON.parse(await readFile(options.intentFile, 'utf8')));
    ClientMessage.parse({ type: 'factory-queue-intent', requestId: 'factory-harness', ...intent.request });
  }
  if (!intent) throw new Error(`Unknown intent: ${options.intentName}`);
  await checkEnvironment();
  const parent = options.artifacts ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'glimmervoid-factory-runs');
  const batchDirectory = path.resolve(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(batchDirectory, { recursive: true });
  const interrupt = new AbortController();
  let interruptedSignal: NodeJS.Signals | null = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const onSignal = (signal: NodeJS.Signals) => { interruptedSignal ??= signal; interrupt.abort(); };
  for (const signal of signals) process.on(signal, onSignal);
  const verdicts: Verdict[] = [];
  let environmentFailure: unknown = null;
  let releaseBatchLock: (() => Promise<void>) | null = null;
  try {
    releaseBatchLock = await acquireBatchLock();
    await buildBatch(interrupt.signal);
    for (let run = 1; run <= options.runs; run++) {
      if (interrupt.signal.aborted) break;
      const recordDirectory = path.join(batchDirectory, String(run).padStart(4, '0'));
      await mkdir(recordDirectory);
      await runOnce(intent, options, recordDirectory, interrupt.signal);
      verdicts.push(JSON.parse(await readFile(path.join(recordDirectory, 'verdict.json'), 'utf8')));
    }
  } catch (error) { environmentFailure = error; }
  finally {
    try {
      const rows = summaryRows(verdicts);
      await writeJson(path.join(batchDirectory, 'summary.json'), { batchDirectory, rows });
      console.table(rows.map((row) => ({ ...row, attemptsPerOrder: JSON.stringify(row.attemptsPerOrder) })));
      console.log(`Records: ${batchDirectory}`);
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
      await releaseBatchLock?.();
    }
  }
  if (interruptedSignal) return 128 + os.constants.signals[interruptedSignal];
  if (environmentFailure) throw environmentFailure;
  return verdicts.every((verdict) => verdict.outcome === 'pass') ? 0 : 1;
}
