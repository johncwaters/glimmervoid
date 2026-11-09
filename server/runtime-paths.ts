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
import { stableLauncherPathFor } from './stable-node-path.ts';

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

function extractExecutableFromBinary(snapshotPath: string): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  const extractedPath = path.join(glimmervoidHomeDir(os.homedir(), process.env), 'runtime', version, path.basename(snapshotPath));
  if (fs.existsSync(extractedPath)) return extractedPath;
  fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
  const partialPath = `${extractedPath}.${process.pid}.partial`;
  fs.writeFileSync(partialPath, fs.readFileSync(snapshotPath), { mode: 0o755 });
  fs.renameSync(partialPath, extractedPath);
  return extractedPath;
}

export { hookLaunch, refuseUnstableSelfLaunches, resolveFfmpegPath, resolvePackageBin, scriptLaunch, selfLaunch, selfRelaunch, stableLauncherPath };
