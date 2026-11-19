import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

import { refuseLaunchesOf } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { BINARY_RUN_SUBCOMMAND, computeRuntimePaths, relayExecutableBeside, relayExecutableProblemOf, relayRunnerOf } from './core/runtime-paths.ts';
import type { RelayRunner, RuntimePaths, SelfEntry } from './core/runtime-paths.ts';
import { firstCommandOnPath, stableLauncherPathFor } from './stable-node-path.ts';
import fnoxRelease from '../scripts/fnox-release.json' with { type: 'json' };

function hasPackageManifest(directory: string): boolean {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (typeof doc !== 'object' || doc === null || !('name' in doc)) return false;
    return typeof doc.name === 'string';
  } catch {
    return false;
  }
}

const runtimePaths: RuntimePaths = computeRuntimePaths({
  moduleFile: fileURLToPath(import.meta.url),
  hasPackageJson: hasPackageManifest,
  isBinary: isSea(),
});

const { appIconPath, assetRoot, boardStoreWorkerPath, bundled, codemapWorkerPath, cliPath, clientDir, examplePacksDir, layoutWorkerPath, mode, packageRoot, relayPath, seatbeltLauncherPath, workbookWorkerPath } = runtimePaths;

export { appIconPath, mode as runtimeMode, assetRoot, boardStoreWorkerPath, bundled, codemapWorkerPath, cliPath, clientDir, examplePacksDir, layoutWorkerPath, packageRoot, relayPath, seatbeltLauncherPath, workbookWorkerPath };

const SELF_LAUNCHER_COMMAND = mode === 'binary' ? 'glimmervoid' : 'node';
const BINARY_ARGV_PREFIX_LENGTH = 2;
const SCRIPT_ARGV_PREFIX_LENGTH = 1;

function stableLauncherPath(): string {
  return stableLauncherPathFor(SELF_LAUNCHER_COMMAND);
}

async function findNodeLauncherPath(): Promise<string | null> {
  if (mode === 'binary') return firstCommandOnPath('node');
  return stableLauncherPath();
}

function hookLauncherPath(): string {
  return mode === 'binary' ? stableLauncherPath() : 'node';
}

function hookLaunch(entry: SelfEntry): string[] {
  const launcherPath = hookLauncherPath();
  if (mode !== 'binary') return runtimePaths.selfLaunch(entry, launcherPath);
  return runtimePaths.selfLaunch(entry, launcherPath, relayRunnerFor(launcherPath).path);
}

function selfLaunch(entry: SelfEntry): string[] {
  return runtimePaths.selfLaunch(entry, stableLauncherPath());
}

function selfRelaunch(runningArgv: readonly string[]): string[] {
  const keptArgumentsFrom = mode === 'binary' ? BINARY_ARGV_PREFIX_LENGTH : SCRIPT_ARGV_PREFIX_LENGTH;
  return [stableLauncherPath(), ...runningArgv.slice(keptArgumentsFrom)];
}

function scriptLaunch(scriptPath: string, runEntry: string, launcherPath = hookLauncherPath()): string[] {
  if (mode === 'binary') return [relayRunnerFor(launcherPath).path, BINARY_RUN_SUBCOMMAND, runEntry];
  return [launcherPath, scriptPath];
}

function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function executableRealPath(): string {
  return realPathOrNull(process.execPath) ?? process.execPath;
}

const relayRunnerByLauncherPath = new Map<string, RelayRunner>();

function hasRelayBeside(executablePath: string): boolean {
  return realPathOrNull(relayExecutableBeside(executablePath)) !== null;
}

function relayRunnerFor(launcherPath: string): RelayRunner {
  const decidedRelayRunner = relayRunnerByLauncherPath.get(launcherPath);
  if (decidedRelayRunner !== undefined) return decidedRelayRunner;
  const runningExecutableRealPath = executableRealPath();
  const relayRunner = relayRunnerOf({
    launcherPath,
    hasRelayBesideLauncher: hasRelayBeside(launcherPath),
    hasRelayBesideExecutable: hasRelayBeside(runningExecutableRealPath),
    executableRealPath: runningExecutableRealPath,
  });
  relayRunnerByLauncherPath.set(launcherPath, relayRunner);
  return relayRunner;
}

function relayExecutablePath(): string | null {
  return mode === 'binary' ? relayRunnerFor(hookLauncherPath()).path : null;
}

function findRelayExecutableProblem() {
  if (mode !== 'binary') return null;
  const relayRunner = relayRunnerFor(hookLauncherPath());
  return relayExecutableProblemOf({ runner: relayRunner, runnerRealPath: realPathOrNull(relayRunner.path), executableRealPath: executableRealPath() });
}

function relayExecutableProblem(): string | null {
  return findRelayExecutableProblem()?.message ?? null;
}

function requireRelayExecutable(): void {
  const problem = findRelayExecutableProblem();
  if (problem?.refusesSpawn) throw Object.assign(new Error(problem.message), { code: problem.code });
}

function refuseUnstableSelfLaunches(): void {
  if (stableLauncherPath() === process.execPath) return;
  refuseLaunchesOf(process.execPath);
}

const packageBins = new Map<string, string | null>();

function resolvePackageBin(packageName: string, binName: string): string | null {
  const cacheKey = `${packageName}:${binName}`;
  if (packageBins.has(cacheKey)) return packageBins.get(cacheKey) ?? null;
  const resolvedBin = readPackageBin(packageName, binName);
  packageBins.set(cacheKey, resolvedBin);
  return resolvedBin;
}

function readPackageBin(packageName: string, binName: string): string | null {
  try {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('bin' in manifest)) return null;
    const bins = manifest.bin;
    const relativeBin = typeof bins === 'string' ? bins
      : bins && typeof bins === 'object' ? Reflect.get(bins, binName) : null;
    if (typeof relativeBin !== 'string') return null;
    const binPath = path.join(path.dirname(manifestPath), relativeBin);
    return fs.statSync(binPath).isFile() ? binPath : null;
  } catch {
    return null;
  }
}

let ffmpegPath: string | null = null;

function resolveFfmpegPath(): string | null {
  if (ffmpegPath) return ffmpegPath;
  ffmpegPath = readFfmpegPath();
  return ffmpegPath;
}

function readFfmpegPath(): string | null {
  try {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    const exported: unknown = require('ffmpeg-static');
    if (typeof exported !== 'string') return null;
    if (!fs.statSync(exported).isFile()) return null;
    if (mode !== 'binary') return exported;
    return extractExecutableFromBinary(exported);
  } catch {
    return null;
  }
}

let fnoxPath: string | null = null;

function resolveFnoxPath(): string {
  if (fnoxPath) return fnoxPath;
  fnoxPath = runtimePaths.fnoxPath({ execPath: process.execPath, platform: process.platform, fnoxVersion: readPinnedFnoxVersion() });
  return fnoxPath;
}

function readPinnedFnoxVersion(): string {
  if (mode === 'binary') return '';
  return fnoxRelease.version;
}

function binaryRuntimeDir(): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  return path.join(glimmervoidHomeDir(os.homedir(), process.env), 'runtime', version);
}

function extractExecutableFromBinary(snapshotPath: string): string {
  const extractedPath = path.join(binaryRuntimeDir(), path.basename(snapshotPath));
  if (fs.existsSync(extractedPath)) return extractedPath;
  fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
  const partialPath = `${extractedPath}.${process.pid}.partial`;
  fs.writeFileSync(partialPath, fs.readFileSync(snapshotPath), { mode: 0o755 });
  fs.renameSync(partialPath, extractedPath);
  return extractedPath;
}

const NODE_PTY_NATIVE_DIRECTORIES = [path.join('build', 'Release'), path.join('prebuilds', `${process.platform}-${process.arch}`)];

function copySnapshotFiles(sourceDir: string, targetDir: string, shouldCopy: (fileName: string) => boolean): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !shouldCopy(entry.name)) continue;
    fs.writeFileSync(path.join(targetDir, entry.name), fs.readFileSync(path.join(sourceDir, entry.name)), { mode: 0o755 });
  }
}

function extractNodePtyFromBinary(): string | null {
  if (mode !== 'binary' || process.platform !== 'darwin') return null;
  const extractedDir = path.join(binaryRuntimeDir(), 'node-pty');
  const extractedEntry = path.join(extractedDir, 'lib', 'index.js');
  if (fs.existsSync(extractedEntry)) return extractedEntry;
  const snapshotDir = path.dirname(createRequire(path.join(packageRoot, 'package.json')).resolve('node-pty/package.json'));
  const partialDir = `${extractedDir}.${process.pid}.partial`;
  try {
    copySnapshotFiles(snapshotDir, partialDir, (fileName) => fileName === 'package.json');
    copySnapshotFiles(path.join(snapshotDir, 'lib'), path.join(partialDir, 'lib'), (fileName) => fileName.endsWith('.js') && !fileName.endsWith('.test.js'));
    for (const nativeDirectory of NODE_PTY_NATIVE_DIRECTORIES) {
      copySnapshotFiles(path.join(snapshotDir, nativeDirectory), path.join(partialDir, nativeDirectory), () => true);
    }
    fs.renameSync(partialDir, extractedDir);
    return extractedEntry;
  } catch (err) {
    fs.rmSync(partialDir, { recursive: true, force: true });
    if (fs.existsSync(extractedEntry)) return extractedEntry;
    throw err;
  }
}

export { extractNodePtyFromBinary, findNodeLauncherPath, hookLaunch, refuseUnstableSelfLaunches, relayExecutablePath, relayExecutableProblem, requireRelayExecutable, resolveFfmpegPath, resolveFnoxPath, resolvePackageBin, scriptLaunch, selfLaunch, selfRelaunch, stableLauncherPath };
