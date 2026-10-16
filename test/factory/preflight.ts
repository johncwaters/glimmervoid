import { access, link, open, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync, spawn } from '../../server/child-process-safe.ts';
import { parseCwdTable, parseProcessTable } from '../../server/github/core/team-review-reaper-core.ts';
import { repoRoot } from './instance.ts';
import { processesUsingBuildOutput, readBuildOutput } from './verdict.ts';
import type { RunningProcess } from './verdict.ts';

const PROCESS_LIST_TIMEOUT_MS = 5_000;
const OWN_WORKTREE_ADVICE = 'Run the harness from its own worktree.';

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function checkBubblewrapStarts() {
  try { await execFileAsync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--unshare-user', '--unshare-pid', '--proc', '/proc', 'true'], { timeout: 5000 }); }
  catch (error) {
    const bubblewrapError = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`Factory lane guardrails cannot start: bwrap with the lane namespaces failed (${bubblewrapError || 'no output'}). On Ubuntu with kernel.apparmor_restrict_unprivileged_userns=1, bwrap needs an AppArmor profile granting userns.`, { cause: error });
  }
}

export async function checkEnvironment() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Factory harness requires Linux or macOS');
  const tools = process.platform === 'linux' ? ['bwrap', 'socat', 'rg'] : ['sandbox-exec'];
  for (const tool of tools) {
    try { await execFileAsync('/bin/sh', ['-c', 'command -v "$1"', 'factory-harness', tool], { timeout: 5000 }); }
    catch (error) { throw new Error(`Factory checks require ${tool} on PATH`, { cause: error }); }
  }
  if (process.platform === 'linux') await checkBubblewrapStarts();
  await access(path.join(repoRoot, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js'));
}

async function checkoutPrivateDirectory(): Promise<string> {
  try { return (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'], { timeout: 5000 })).stdout.trim() || repoRoot; }
  catch { return repoRoot; }
}

async function recordedHolderPid(lockPath: string): Promise<number | null> {
  try { return Number((await readFile(lockPath, 'utf8')).trim()); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !hasErrorCode(error, 'ESRCH'); }
}

async function removeLockOfDeadHolder(lockPath: string, deadHolderPid: number): Promise<void> {
  const takeoverGuardPath = `${lockPath}.takeover-${deadHolderPid}`;
  try { await (await open(takeoverGuardPath, 'wx')).close(); }
  catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    throw new Error(`Another factory harness is taking over the stale batch lock. If none is running, delete ${takeoverGuardPath}.`, { cause: error });
  }
  try {
    if (await recordedHolderPid(lockPath) === deadHolderPid) await rm(lockPath);
  } finally { await rm(takeoverGuardPath, { force: true }); }
}

export async function acquireBatchLock(): Promise<() => Promise<void>> {
  const lockPath = path.join(await checkoutPrivateDirectory(), 'glimmervoid-factory-run.lock');
  const claimPath = `${lockPath}.claim-${process.pid}`;
  await writeFile(claimPath, `${process.pid}\n`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(claimPath, lockPath);
        return async () => { if (await recordedHolderPid(lockPath) === process.pid) await rm(lockPath, { force: true }); };
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }
      const holderPid = await recordedHolderPid(lockPath);
      if (holderPid === null) continue;
      if (!Number.isSafeInteger(holderPid) || holderPid < 1) throw new Error(`The factory batch lock at ${lockPath} records no process id. Delete it if no harness is running.`);
      if (isProcessAlive(holderPid)) throw new Error(`Another factory harness batch (pid ${holderPid}) holds the build lock of this checkout at ${lockPath}. ${OWN_WORKTREE_ADVICE}`);
      await removeLockOfDeadHolder(lockPath, holderPid);
    }
    throw new Error(`The factory batch lock at ${lockPath} kept changing hands. ${OWN_WORKTREE_ADVICE}`);
  } finally { await rm(claimPath, { force: true }); }
}

async function linuxWorkingDirectory(pid: number): Promise<[number, string | null][]> {
  try { return [[pid, await readlink(`/proc/${pid}/cwd`)]]; }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH')) return [];
    return [[pid, null]];
  }
}

async function workingDirectoriesOfRunningProcesses(pids: number[]): Promise<Map<number, string | null>> {
  if (process.platform === 'linux') return new Map((await Promise.all(pids.map(linuxWorkingDirectory))).flat());
  let cwdOutput = '';
  try { cwdOutput = (await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (error) { cwdOutput = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''; }
  const readableDirectories = new Map(await Promise.all([...parseCwdTable(cwdOutput)].map(async ([pid, workingDirectory]) => [pid, await realpath(workingDirectory).catch(() => null)] as const)));
  return new Map(pids.map((pid) => [pid, readableDirectories.get(pid) ?? null]));
}

async function locateArguments(pid: number, command: string, workingDirectory: string | null): Promise<RunningProcess> {
  const pathArguments = command.split(/\s+/).filter((argument) => argument !== '' && !argument.startsWith('-'));
  const resolvableArguments = pathArguments.filter((argument) => workingDirectory !== null || path.isAbsolute(argument));
  const resolvedArguments = await Promise.all(resolvableArguments.map((argument) => realpath(path.resolve(workingDirectory ?? '/', argument)).then((resolved) => [resolved], () => [])));
  const unresolvedRelativeArguments = workingDirectory === null ? pathArguments.filter((argument) => !path.isAbsolute(argument)) : [];
  return { pid, command, resolvedArguments: resolvedArguments.flat(), unresolvedRelativeArguments };
}

async function buildOutputDirectory(): Promise<string | null> {
  try { return await realpath(path.join(repoRoot, 'dist')); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function findProcessesUsingBuildOutput(): Promise<RunningProcess[]> {
  const directory = await buildOutputDirectory();
  if (directory === null) return [];
  const { stdout } = await execFileAsync('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,args='], { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const rows = parseProcessTable(stdout);
  const workingDirectories = await workingDirectoriesOfRunningProcesses(rows.map((row) => row.pid));
  const running = await Promise.all(rows.filter((row) => workingDirectories.has(row.pid)).map((row) => locateArguments(row.pid, row.args, workingDirectories.get(row.pid) ?? null)));
  return processesUsingBuildOutput(running, await readBuildOutput(directory), process.pid);
}

export async function buildBatch(signal: AbortSignal) {
  signal.throwIfAborted();
  const buildOutputUsers = await findProcessesUsingBuildOutput();
  if (buildOutputUsers.length > 0) {
    throw new Error(`Factory harness refuses to build: the batch build deletes dist, and a process is running from the dist of this checkout, or has a relative argument that could land there and a working directory that could not be read (pid ${buildOutputUsers.map((user) => user.pid).join(', ')}). ${OWN_WORKTREE_ADVICE}`);
  }
  const child = spawn('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', detached: true });
  const stop = (terminationSignal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, terminationSignal); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => { stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 2000); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => { if (code === 0) { resolve(); return; } reject(new Error(`Batch build failed (${code})`)); });
    });
    signal.throwIfAborted();
  } finally {
    if (signal.aborted) stop('SIGKILL');
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
  }
}
