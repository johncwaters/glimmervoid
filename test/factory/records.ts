import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { FactoryLaneState, FactoryQueueIntentResult } from '../../shared/contracts/factory.ts';
import { refuseRealGlimmervoidInstance } from './instance.ts';

const KeptInstance = z.object({
  tempDirectory: z.string().min(1), port: z.number().int().min(1024).max(65535),
  configPath: z.string().min(1), isolatedHome: z.string().min(1), isolatedTemp: z.string().min(1),
  environment: z.object({ GLIMMERVOID_HOME: z.string(), GLIMMERVOID_CONFIG: z.string(), GLIMMERVOID_PORT: z.string(), GIT_CONFIG_GLOBAL: z.string(), GIT_CONFIG_NOSYSTEM: z.string(), TMPDIR: z.string() }),
  target: z.enum(['throwaway', 'gated-clone']), projectPath: z.string().min(1), originPath: z.string().min(1),
  snapshot: z.object({ batchDirectory: z.string(), snapshotPath: z.string(), realMain: z.string(), snapshotMain: z.string(), snapshotRefCommits: z.array(z.string()) }).nullable(),
});

const RecordedIntent = z.object({
  name: z.string(), expectedEnd: z.enum(['completed', 'refused']), expectedRefusal: z.string().nullable(),
  queuedIntent: z.record(z.string(), z.unknown()),
});
const AcceptedQueueReply = FactoryQueueIntentResult.extend({ ok: z.literal(true), workId: z.string().min(1) });
type KeptRun = { recordDirectory: string; prepared: z.infer<typeof KeptInstance>; queueReply: z.infer<typeof AcceptedQueueReply>; intentRecord: z.infer<typeof RecordedIntent> };

export async function readKeptRun(directory: string): Promise<KeptRun> {
  const recordDirectory = path.resolve(directory);
  if (!await exists(recordDirectory)) throw new Error(`Cannot resume ${recordDirectory}: no kept instance directory`);
  try {
    await access(path.join(recordDirectory, 'instance.json'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const candidates = (await readdir(recordDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
    for (const candidate of candidates) {
      const runDirectory = path.join(recordDirectory, candidate);
      try {
        const verdict = JSON.parse(await readFile(path.join(runDirectory, 'verdict.json'), 'utf8'));
        if (verdict.outcome === 'partial' || verdict.outcome === 'fail') return readKeptRun(runDirectory);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    throw new Error(`Cannot resume ${recordDirectory}: no kept retryable run with instance.json`);
  }
  const prepared = KeptInstance.parse(JSON.parse(await readFile(path.join(recordDirectory, 'instance.json'), 'utf8')));
  const expectedEnvironment = {
    GLIMMERVOID_HOME: path.join(prepared.tempDirectory, 'home'), GLIMMERVOID_CONFIG: path.join(prepared.tempDirectory, 'config.json'), GLIMMERVOID_PORT: String(prepared.port),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TMPDIR: path.join(prepared.tempDirectory, 'tmp'),
  };
  const isIsolatedInstance = prepared.isolatedHome === expectedEnvironment.GLIMMERVOID_HOME && prepared.configPath === expectedEnvironment.GLIMMERVOID_CONFIG
    && prepared.isolatedTemp === expectedEnvironment.TMPDIR && isDeepStrictEqual(prepared.environment, expectedEnvironment);
  if (!isIsolatedInstance) throw new Error(`Cannot resume ${recordDirectory}: instance.json does not describe an isolated harness instance`);
  await refuseRealGlimmervoidInstance(prepared);
  try {
    for (const requiredPath of [prepared.configPath, prepared.isolatedHome, prepared.isolatedTemp, prepared.projectPath, prepared.originPath]) await access(requiredPath);
  } catch (error) { throw new Error(`Cannot resume ${recordDirectory}: the kept instance is missing`, { cause: error }); }
  let queueRecord: unknown = null;
  try { queueRecord = JSON.parse(await readFile(path.join(recordDirectory, 'queue-reply.json'), 'utf8')); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const accepted = z.object({ reply: AcceptedQueueReply }).safeParse(queueRecord);
  if (!accepted.success) throw new Error(`Cannot resume ${recordDirectory}: no accepted intent id in queue-reply.json`);
  const intentRecord = RecordedIntent.parse(JSON.parse(await readFile(path.join(recordDirectory, 'intent.json'), 'utf8')));
  return { recordDirectory, prepared, queueReply: accepted.data.reply, intentRecord };
}

export async function writeJson(filePath: string, document: unknown) {
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

async function exists(directory: string) {
  try { await readdir(directory); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readDecisionLinesByFile(home: string, projectId: string, includePartialLine: boolean): Promise<Map<string, string[]>> {
  const directory = path.join(home, 'factory', projectId, 'decisions');
  const linesByFile = new Map<string, string[]>();
  if (!await exists(directory)) return linesByFile;
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    const contents = await readFile(path.join(directory, file), 'utf8');
    const fileLines = contents.split('\n');
    if (!includePartialLine && !contents.endsWith('\n')) fileLines.pop();
    linesByFile.set(file, fileLines.filter((line) => line.trim().length > 0));
  }
  return linesByFile;
}

export async function countDecisionLinesByFile(home: string, projectId: string): Promise<Map<string, number>> {
  const linesByFile = await readDecisionLinesByFile(home, projectId, true);
  return new Map(Array.from(linesByFile, ([file, lines]) => [file, lines.length]));
}

export async function readDecisionLines(home: string, projectId: string, includePartialLine = true, priorLineCountByFile: ReadonlyMap<string, number> = new Map()): Promise<string[]> {
  const linesByFile = await readDecisionLinesByFile(home, projectId, includePartialLine);
  return Array.from(linesByFile).flatMap(([file, lines]) => lines.slice(priorLineCountByFile.get(file) ?? 0));
}

async function gitLog(directory: string, revision: string) {
  return (await execFileAsync('git', ['-C', directory, '--no-pager', 'log', '--format=%H%x09%s', revision], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export async function collectRecords(home: string, configPath: string, projectId: string, originPath: string | null, recordDirectory: string, priorDecisionLineCountByFile: ReadonlyMap<string, number> = new Map()) {
  const decisionDirectory = path.join(home, 'factory', projectId, 'decisions');
  const recordingDirectory = path.join(path.dirname(configPath), 'recordings');
  for (const [source, target] of [[decisionDirectory, 'decisions'], [recordingDirectory, 'recordings']]) {
    if (!source || !target) continue;
    await mkdir(path.join(recordDirectory, target), { recursive: true });
    if (await exists(source)) await cp(source, path.join(recordDirectory, target), { recursive: true });
  }
  const originLog = originPath ? await gitLog(originPath, 'main') : '';
  await writeFile(path.join(recordDirectory, 'origin-main.log'), originLog);
  const statePath = path.join(home, 'factory', projectId, 'state.json');
  let ledgerLog = '';
  try {
    const state = FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
    if (state.ledgerPath) ledgerLog = await gitLog(state.ledgerPath, 'HEAD');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await writeFile(path.join(recordDirectory, 'ledger.log'), ledgerLog);
  const serverLog = await readFile(path.join(recordDirectory, 'server.log'), 'utf8');
  const spawnedSessionIds = Array.from(serverLog.matchAll(/^\[session ([^\]]+)\] spawn:/gm), (match) => match[1]).filter((sessionId): sessionId is string => Boolean(sessionId));
  return { spawnedSessionIds, decisionLines: await readDecisionLines(home, projectId, true, priorDecisionLineCountByFile), originCommits: originLog.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  }) };
}
