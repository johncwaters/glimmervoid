import { open, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileAsync, spawn } from '../../server/child-process-safe.ts';
import { parseProcessTable } from '../../server/github/core/team-review-reaper-core.ts';
import { glimmervoidHomeDir } from '../../server/core/config-path-core.ts';
import { prepareIsolatedEnvironment } from '../support/backend-harness.ts';
import type { FactoryOverrides } from './arguments.ts';
import { pidsStillNamingSameProcess } from './verdict.ts';
import type { ProcessIdentity } from './verdict.ts';
import { seedTelemetryState } from './telemetry.ts';
import { withoutTelemetryConfig } from './telemetry-core.ts';
import type { HarnessTelemetryDecision } from './telemetry-core.ts';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
export const builtServerEntryPath = path.join(repoRoot, 'dist/server/index.js');

async function canonicalPath(directory: string): Promise<string> {
  try { return await realpath(directory); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return path.join(await canonicalPath(path.dirname(directory)), path.basename(directory));
  }
}

export async function prepareInstance(tempDirectory: string, project: { projectPath: string; projectId: string } | null, factory: FactoryOverrides, telemetry: HarnessTelemetryDecision) {
  const isolated = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: project ? [project.projectPath] : [], recordSessions: true, mutateEnvironment: false });
  const realHomes = [glimmervoidHomeDir(os.homedir(), {}), glimmervoidHomeDir(os.homedir(), process.env)];
  if (isolated.port === 3000) throw new Error('Factory harness refuses port 3000');
  for (const realHome of realHomes) {
    if (await canonicalPath(isolated.isolatedHome) === await canonicalPath(realHome)) throw new Error('Factory harness refuses the real Glimmervoid home');
  }
  const document = withoutTelemetryConfig(JSON.parse(await readFile(isolated.configPath, 'utf8')));
  await writeFile(isolated.configPath, JSON.stringify({
    ...document, projects: project ? [{ id: project.projectId, name: 'Factory seed', path: project.projectPath }] : [],
    factory: { enabled: project !== null, ...factory }, usage: { enabled: true },
    capture: { enabled: true, retainDays: 0, retainFiles: 0, retainBytes: 0 },
  }, null, 2));
  if (telemetry.runHomeSeed) await seedTelemetryState(isolated.isolatedHome, telemetry.runHomeSeed);
  return isolated;
}

async function listProcessIdentities(): Promise<(ProcessIdentity & { ppid: number })[]> {
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,lstart='], { timeout: 1000, maxBuffer: 8 * 1024 * 1024 });
  return parseProcessTable(stdout).map(({ pid, ppid, args }) => ({ pid, ppid, startedAt: args }));
}

async function descendantIdentities(rootPid: number): Promise<ProcessIdentity[]> {
  const processes = await listProcessIdentities();
  const descendants = new Set([rootPid]);
  let previousSize = 0;
  while (previousSize !== descendants.size) {
    previousSize = descendants.size;
    for (const processRow of processes) if (descendants.has(processRow.ppid)) descendants.add(processRow.pid);
  }
  descendants.delete(rootPid);
  return processes.filter((processRow) => descendants.has(processRow.pid)).map(({ pid, startedAt }) => ({ pid, startedAt }));
}

function killProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
}

export async function startInstance(prepared: Awaited<ReturnType<typeof prepareInstance>>, serverLogPath: string, telemetry: HarnessTelemetryDecision) {
  const log = await open(serverLogPath, 'a');
  const { GLIMMERVOID_INSECURE_BIND: _inheritedInsecureBind, ...inheritedEnvironment } = telemetry.childEnvironment;
  const childEnvironment: NodeJS.ProcessEnv = { ...inheritedEnvironment, ...prepared.environment, GLIMMERVOID_HOST: '127.0.0.1' };
  const child = spawn(process.execPath, [builtServerEntryPath], {
    cwd: repoRoot, env: childEnvironment, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let spawnFailure: Error | null = null;
  let hasClosed = false;
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => { spawnFailure = error; });
    child.once('close', () => { hasClosed = true; resolve(); });
  });
  let supervisorFailure: Error | null = null;
  if (child.pid) {
    const supervisor = spawn(process.execPath, [path.join(import.meta.dirname, 'supervisor.ts'), String(process.pid), String(child.pid)], { detached: true, stdio: 'ignore' });
    supervisor.once('error', (error) => { supervisorFailure = error; });
    supervisor.once('exit', () => { if (!hasClosed) supervisorFailure ??= new Error('Factory supervisor exited before the built instance'); });
    supervisor.unref();
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    killProcess(-child.pid, signal);
  };
  let shutdown: Promise<void> | null = null;
  const stop = () => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      const recordedDescendants: ProcessIdentity[] = [];
      const shutdownErrors: unknown[] = [];
      try {
        try {
          if (child.pid && !hasClosed) recordedDescendants.push(...await descendantIdentities(child.pid));
        } catch (error) { shutdownErrors.push(error); }
        signalGroup('SIGTERM');
        await Promise.race([closed, sleep(8_000, undefined, { ref: false })]);
        try {
          if (child.pid && !hasClosed) recordedDescendants.push(...await descendantIdentities(child.pid));
        } catch (error) { shutdownErrors.push(error); }
        signalGroup('SIGKILL');
        let currentProcesses: ProcessIdentity[] = [];
        try {
          if (recordedDescendants.length > 0) currentProcesses = await listProcessIdentities();
        } catch (error) { shutdownErrors.push(error); }
        for (const pid of pidsStillNamingSameProcess(recordedDescendants, currentProcesses)) killProcess(pid, 'SIGKILL');
        await Promise.race([closed, sleep(2_000, undefined, { ref: false })]);
        if (!hasClosed) shutdownErrors.push(new Error('Built instance did not exit within the shutdown bound'));
        if (shutdownErrors.length > 0) throw new AggregateError(shutdownErrors, 'Built instance shutdown failed');
      } finally { await log.close(); }
    })();
    return shutdown;
  };
  const waitUntilReady = async (signal: AbortSignal) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (spawnFailure) throw spawnFailure;
      if (supervisorFailure) throw supervisorFailure;
      if (hasClosed) throw new Error(`Built instance exited during boot: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${prepared.port}/control-token`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
        if (response.ok) return;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof TypeError) && !(error instanceof Error && error.name === 'TimeoutError')) throw error;
      }
      await sleep(100, undefined, { signal });
    }
    throw new Error('Built instance was not ready within 30 seconds');
  };
  return { child, closed, stop, waitUntilReady };
}
