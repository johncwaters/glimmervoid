import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { FactoryLaneState } from '../../shared/contracts/factory.ts';

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

export async function readDecisionLines(home: string, projectId: string, includePartialLine = true): Promise<string[]> {
  const directory = path.join(home, 'factory', projectId, 'decisions');
  if (!await exists(directory)) return [];
  const lines: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    const contents = await readFile(path.join(directory, file), 'utf8');
    const fileLines = contents.split('\n');
    if (!includePartialLine && !contents.endsWith('\n')) fileLines.pop();
    lines.push(...fileLines.filter((line) => line.trim().length > 0));
  }
  return lines;
}

async function gitLog(directory: string, revision: string) {
  return (await execFileAsync('git', ['-C', directory, '--no-pager', 'log', '--format=%H%x09%s', revision], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

export async function collectRecords(home: string, configPath: string, projectId: string, originPath: string | null, recordDirectory: string) {
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
  return { spawnedSessionIds, decisionLines: await readDecisionLines(home, projectId), originCommits: originLog.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  }) };
}
