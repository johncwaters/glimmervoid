import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, isMissingFileError } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { COHERENCE_CONFIG_FILENAME, unreadableConfigEntry } from './core/coherence-config-core.ts';
import type { CoherenceConfigEntry } from './core/coherence-config-core.ts';
import { COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER } from './core/coherence-adopt-core.ts';
import { changedPathsFromPorcelainStatus } from './core/coherence-feed-core.ts';
import { COHERENCE_TARGET_BIN_NAMES } from './core/coherence-session-core.ts';
import { prepareGuardrailsLaunch } from '../guardrails/guardrails-launch.ts';

type FileRead =
  | { kind: 'missing' }
  | { kind: 'refused' }
  | { kind: 'read'; bytes: Buffer; start: number; size: number; isTail: boolean; cursor: { dev: number; ino: number } };

type CheckoutSnapshot =
  | { ok: true; root: string; cwd: string; readDenied: string[]; objectDirs: string[]; inputDigest: string }
  | { ok: false; failure: 'too-large' | 'failed' };

type SnapshotSource = { kind: 'working-tree' } | { kind: 'commit'; sha: string };

type GuardedCommand = (file: string, args: string[], options: { timeoutMs: number; input?: string; extraEnv?: Record<string, string> }) => Promise<string>;

const CONFIG_READ_MAX_BYTES = 256 * 1024;
const GUARDED_RUN_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_ALTERNATES = 8;
const SNAPSHOT_FILE_MODE_MASK = 0o755;
const SNAPSHOT_GIT_TIMEOUT_MS = 30_000;
const SNAPSHOT_GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NO_FOLLOW_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

async function lstatOrNull(candidatePath: string) {
  return lstat(candidatePath).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
}

async function readRegularFileNoFollow(filePath: string, { fromOffset, maxBytes }: { fromOffset: number; maxBytes: number }): Promise<FileRead> {
  const entry = await lstatOrNull(filePath);
  if (!entry) return { kind: 'missing' };
  if (entry.isSymbolicLink() || !entry.isFile()) return { kind: 'refused' };
  const handle = await open(filePath, NO_FOLLOW_READ_FLAGS).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (!handle) return { kind: 'missing' };
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) return { kind: 'refused' };
    const size = opened.size;
    const wantedStart = fromOffset > size ? 0 : fromOffset;
    const start = Math.max(wantedStart, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { kind: 'read', bytes: bytes.subarray(0, filled), start, size, isTail: start > wantedStart, cursor: { dev: opened.dev, ino: opened.ino } };
  } finally {
    await handle.close();
  }
}

async function readCoherenceConfigEntry(cwd: string): Promise<CoherenceConfigEntry> {
  const configPath = path.join(cwd, COHERENCE_CONFIG_FILENAME);
  const unreadable = unreadableConfigEntry(await lstatOrNull(configPath));
  if (unreadable) return unreadable;
  const read = await readRegularFileNoFollow(configPath, { fromOffset: 0, maxBytes: CONFIG_READ_MAX_BYTES + 1 });
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind === 'refused') return { kind: 'not-a-file' };
  if (read.size > CONFIG_READ_MAX_BYTES) return { kind: 'too-large' };
  return { kind: 'file', text: read.bytes.toString('utf8') };
}

function completedFailureStdout(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const exitCode: unknown = Reflect.get(error, 'code');
  const stdout: unknown = Reflect.get(error, 'stdout');
  if (typeof exitCode !== 'number' || typeof stdout !== 'string' || stdout.trim() === '') return null;
  return stdout;
}

function wasKilledByTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'killed') === true;
}

function coherenceEnv(gitEnvironment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(gitEnvironment).filter(([key]) => !key.startsWith('COHERENCE_') && key !== 'CODEX_THREAD_ID'));
}

async function gitText(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER_BYTES, encoding: 'utf8' });
  return stdout;
}

async function isRealDirectoryChainUnder(root: string, relativeDirectory: string, { isCreating }: { isCreating: boolean }): Promise<boolean> {
  let current = root;
  for (const segment of relativeDirectory === '.' ? [] : relativeDirectory.split('/')) {
    current = path.join(current, segment);
    const entry = await lstatOrNull(current);
    if (entry === null && !isCreating) return false;
    if (entry === null) {
      await mkdir(current);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  }
  return true;
}

async function isSourceParentInsideTree(realTop: string, relativePath: string): Promise<boolean | null> {
  const expectedParent = path.join(realTop, path.posix.dirname(relativePath));
  const realParent = await realpath(expectedParent).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (realParent === null) return null;
  return realParent === expectedParent;
}

async function removeFromSnapshot(snapshotRoot: string, relativePath: string): Promise<void> {
  if (!await isRealDirectoryChainUnder(snapshotRoot, path.posix.dirname(relativePath), { isCreating: false })) return;
  const destinationPath = path.join(snapshotRoot, relativePath);
  const existing = await lstatOrNull(destinationPath);
  if (existing === null || existing.isDirectory()) return;
  await rm(destinationPath, { force: true });
}

async function overlayChangedFile(realTop: string, snapshotRoot: string, relativePath: string, remainingBytes: number, inputDigest: Hash): Promise<number | 'too-large'> {
  const isParentInside = await isSourceParentInsideTree(realTop, relativePath);
  if (isParentInside === false) return 0;
  const sourcePath = path.join(realTop, relativePath);
  const source = isParentInside === null ? null : await lstatOrNull(sourcePath);
  if (source === null) {
    await removeFromSnapshot(snapshotRoot, relativePath);
    inputDigest.update(`removed\0${relativePath}\0`);
    return 0;
  }
  if (source.isSymbolicLink() || !source.isFile()) return 0;
  if (source.size > remainingBytes) return 'too-large';
  const read = await readRegularFileNoFollow(sourcePath, { fromOffset: 0, maxBytes: remainingBytes + 1 });
  if (read.kind === 'missing') {
    await removeFromSnapshot(snapshotRoot, relativePath);
    inputDigest.update(`removed\0${relativePath}\0`);
    return 0;
  }
  if (read.kind === 'refused') return 0;
  if (read.size > remainingBytes) return 'too-large';
  if (!await isRealDirectoryChainUnder(snapshotRoot, path.posix.dirname(relativePath), { isCreating: true })) return 0;
  const destinationPath = path.join(snapshotRoot, relativePath);
  const existing = await lstatOrNull(destinationPath);
  if (existing?.isDirectory()) return 0;
  await rm(destinationPath, { force: true });
  const mode = source.mode & SNAPSHOT_FILE_MODE_MASK;
  await writeFile(destinationPath, read.bytes, { flag: 'wx', mode });
  inputDigest.update(`file\0${relativePath}\0${mode}\0${read.bytes.length}\0`).update(read.bytes);
  return read.bytes.length;
}

async function alternateObjectDirectories(snapshotRoot: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [path.join(snapshotRoot, '.git', 'objects')];
  for (let objectsDir = pending.shift(); objectsDir !== undefined && found.length < SNAPSHOT_MAX_ALTERNATES; objectsDir = pending.shift()) {
    const alternatesText = await readFile(path.join(objectsDir, 'info', 'alternates'), 'utf8').catch((error: unknown) => {
      if (isMissingFileError(error)) return '';
      throw error;
    });
    const alternateLines = alternatesText.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
    for (const alternateLine of alternateLines) {
      const alternate = await realpath(path.resolve(objectsDir, alternateLine));
      if (found.includes(alternate)) continue;
      found.push(alternate);
      pending.push(alternate);
    }
  }
  return found;
}

async function overlayWorkingTreeChanges(realTop: string, snapshotRoot: string, changedPaths: readonly string[], inputDigest: Hash): Promise<boolean> {
  let remainingBytes = SNAPSHOT_MAX_BYTES;
  for (const relativePath of changedPaths) {
    const copiedBytes = await overlayChangedFile(realTop, snapshotRoot, relativePath, remainingBytes, inputDigest);
    if (copiedBytes === 'too-large') return false;
    remainingBytes -= copiedBytes;
  }
  return true;
}

async function snapshotCheckout({ cwd, snapshotRoot, env, source }: {
  cwd: string; snapshotRoot: string; env: Record<string, string>; source: SnapshotSource;
}): Promise<CheckoutSnapshot> {
  if (source.kind === 'commit' && !SNAPSHOT_COMMIT_SHA.test(source.sha)) return { ok: false, failure: 'failed' };
  const realCwd = await realpath(cwd);
  const realTop = await realpath((await gitText(['rev-parse', '--show-toplevel'], realCwd, env)).trim());
  const relativeCwd = path.relative(realTop, realCwd);
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) return { ok: false, failure: 'failed' };
  const commonGitDir = await realpath((await gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], realTop, env)).trim());
  const checkoutSha = source.kind === 'commit' ? source.sha : (await gitText(['rev-parse', '--verify', 'HEAD^{commit}'], realTop, env)).trim();
  const changedPaths = source.kind === 'commit'
    ? []
    : changedPathsFromPorcelainStatus(await gitText(['--no-optional-locks', 'status', '-z', '--porcelain=v1', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], realTop, env));
  if (changedPaths.length > SNAPSHOT_MAX_FILES) return { ok: false, failure: 'too-large' };
  await gitText(['clone', '--quiet', '--shared', '--no-checkout', realTop, snapshotRoot], path.dirname(snapshotRoot), env);
  await gitText(['checkout', '--quiet', '--detach', checkoutSha], snapshotRoot, env);
  const inputDigest = createHash('sha256').update(`${checkoutSha}\0${relativeCwd}\0`);
  if (!await overlayWorkingTreeChanges(realTop, snapshotRoot, changedPaths, inputDigest)) return { ok: false, failure: 'too-large' };
  const objectDirs = await alternateObjectDirectories(snapshotRoot);
  return { ok: true, root: snapshotRoot, cwd: path.join(snapshotRoot, relativeCwd), readDenied: [realTop, commonGitDir], objectDirs, inputDigest: inputDigest.digest('hex') };
}

async function isExecutableTarget(targetPath: string): Promise<boolean> {
  const entry = await lstatOrNull(targetPath);
  if (entry === null || !(entry.isFile() || entry.isSymbolicLink())) return false;
  const resolved = entry.isSymbolicLink() ? await stat(targetPath).catch(() => null) : entry;
  if (!resolved?.isFile()) return false;
  return access(targetPath, fsConstants.X_OK).then(() => true, () => false);
}

async function mirrorLifecycleTargets(sourceCwd: string, snapshot: Extract<CheckoutSnapshot, { ok: true }>): Promise<string[]> {
  const relativeBinDirectory = path.relative(snapshot.root, path.join(snapshot.cwd, 'node_modules', '.bin')).split(path.sep).join('/');
  const mirroredBinNames: string[] = [];
  for (const binName of COHERENCE_TARGET_BIN_NAMES) {
    if (!await isExecutableTarget(path.join(sourceCwd, 'node_modules', '.bin', binName))) continue;
    if (!await isRealDirectoryChainUnder(snapshot.root, relativeBinDirectory, { isCreating: true })) return mirroredBinNames;
    await writeFile(path.join(snapshot.root, relativeBinDirectory, binName), COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.text, {
      flag: 'wx', mode: COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.mode,
    }).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    mirroredBinNames.push(binName);
  }
  return mirroredBinNames;
}

async function nodeModulesHolding(filePath: string): Promise<string> {
  const realFile = await realpath(filePath);
  for (let current = path.dirname(realFile); path.dirname(current) !== current; current = path.dirname(current)) {
    if (path.basename(current) === 'node_modules') return current;
  }
  return path.dirname(realFile);
}

async function withGuardrailsLaunch<Outcome>({ scratch, snapshot, readablePaths, env }: {
  scratch: string; snapshot: Extract<CheckoutSnapshot, { ok: true }>; readablePaths: string[]; env: Record<string, string>;
}, use: (runGuarded: GuardedCommand) => Promise<Outcome>): Promise<Outcome | null> {
  const tempDir = path.join(scratch, 'tmp');
  await mkdir(tempDir);
  const prepared = await prepareGuardrailsLaunch({
    role: {
      vendors: [], vendorHome: { scope: 'state' }, network: { access: 'none' }, writableRoots: [snapshot.root],
      lockedCheckouts: [], commitCheckouts: [], readDenied: snapshot.readDenied, readableWithinDenied: [...snapshot.objectDirs, ...readablePaths],
    },
    launchId: path.basename(scratch),
    tempDir,
    enterDir: snapshot.cwd,
  });
  if (!prepared.ok) return null;
  const runGuarded: GuardedCommand = async (file, args, { timeoutMs, input, extraEnv = {} }) => {
    const wrapped = await prepared.launch.wrap(file, args, { hasTerminal: false });
    const { stdout } = await execFileAsync(wrapped.file, wrapped.args, {
      cwd: prepared.launch.cwd, env: { ...env, ...extraEnv, ...prepared.launch.env },
      timeout: timeoutMs, maxBuffer: GUARDED_RUN_MAX_BUFFER_BYTES, encoding: 'utf8', input,
    });
    return stdout;
  };
  try {
    return await use(runGuarded);
  } finally {
    await prepared.launch.dispose();
  }
}

export {
  coherenceEnv, completedFailureStdout, lstatOrNull, mirrorLifecycleTargets, nodeModulesHolding, readCoherenceConfigEntry, readRegularFileNoFollow, snapshotCheckout,
  wasKilledByTimeout, withGuardrailsLaunch,
};
export type { CheckoutSnapshot, FileRead, GuardedCommand };
