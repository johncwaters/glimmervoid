import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

import { refuseLaunchesOf } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { computeRuntimePaths } from './core/runtime-paths.ts';
import type { RuntimePaths, SelfEntry } from './core/runtime-paths.ts';
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

const { assetRoot, boardStoreWorkerPath, bundled, cliPath, clientDir, examplePacksDir, layoutWorkerPath, mode, packageRoot, relayPath } = runtimePaths;

export { assetRoot, boardStoreWorkerPath, bundled, cliPath, clientDir, examplePacksDir, layoutWorkerPath, packageRoot, relayPath };

const BINARY_RUN_SUBCOMMAND = '__run';
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
  return runtimePaths.selfLaunch(entry, hookLauncherPath());
}

function selfLaunch(entry: SelfEntry): string[] {
  return runtimePaths.selfLaunch(entry, stableLauncherPath());
}

function selfRelaunch(runningArgv: readonly string[]): string[] {
  const keptArgumentsFrom = mode === 'binary' ? BINARY_ARGV_PREFIX_LENGTH : SCRIPT_ARGV_PREFIX_LENGTH;
  return [stableLauncherPath(), ...runningArgv.slice(keptArgumentsFrom)];
}

function scriptLaunch(scriptPath: string, runEntry: string, launcherPath = hookLauncherPath()): string[] {
  if (mode === 'binary') return [launcherPath, BINARY_RUN_SUBCOMMAND, runEntry];
  return [launcherPath, scriptPath];
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

export { extractNodePtyFromBinary, findNodeLauncherPath, hookLaunch, refuseUnstableSelfLaunches, resolveFfmpegPath, resolveFnoxPath, resolvePackageBin, scriptLaunch, selfLaunch, selfRelaunch, stableLauncherPath };
