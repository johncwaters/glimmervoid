import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const repoRoot = path.join(import.meta.dirname, '..');

const FnoxRelease = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256ByTarget: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
}).strict();

const release = FnoxRelease.parse(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fnox-release.json'), 'utf8')));

const TARGET_BY_HOST: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

interface FetchFnoxRequest {
  target: string;
  outputPath: string;
  isCheckOnly?: boolean;
}

function fail(message: string): never {
  throw new Error(`fetch-fnox: ${message}`);
}

function hostTarget(): string {
  const target = TARGET_BY_HOST[`${process.platform}-${process.arch}`];
  if (!target) fail(`no pinned fnox for ${process.platform}-${process.arch}`);
  return target;
}

function isWindowsTarget(target: string): boolean {
  return target.endsWith('-windows-msvc');
}

function executableNameFor(target: string): string {
  return isWindowsTarget(target) ? 'fnox.exe' : 'fnox';
}

function archiveNameFor(target: string): string {
  return `fnox-${target}${isWindowsTarget(target) ? '.zip' : '.tar.gz'}`;
}

function devFnoxPath(target: string): string {
  return path.join(repoRoot, '.fnox', release.version, executableNameFor(target));
}

function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function reportsPinnedVersion(executablePath: string): boolean {
  try {
    return execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).includes(release.version);
  } catch {
    return false;
  }
}

async function downloadVerifiedArchive(target: string, downloadDirectory: string): Promise<string> {
  const expectedSha256 = release.sha256ByTarget[target];
  if (!expectedSha256) fail(`scripts/fnox-release.json pins no sha256 for ${target}`);
  const archiveName = archiveNameFor(target);
  const archiveUrl = `https://github.com/jdx/fnox/releases/download/v${release.version}/${archiveName}`;
  const response = await fetch(archiveUrl).catch((error: unknown) => fail(`${archiveUrl} could not be fetched: ${error instanceof Error ? error.message : String(error)}`));
  if (!response.ok) fail(`${archiveUrl} answered ${response.status}`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  if (actualSha256 !== expectedSha256) fail(`${archiveName} has sha256 ${actualSha256}, pinned ${expectedSha256}`);
  const archivePath = path.join(downloadDirectory, archiveName);
  fs.writeFileSync(archivePath, archiveBytes);
  return archivePath;
}

function executableEntryOf(archivePath: string, target: string): string {
  const executableName = executableNameFor(target);
  const archiveEntries = execFileSync(tarCommand(), ['-tf', archivePath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const entry = archiveEntries.find((name) => path.posix.basename(name) === executableName);
  if (!entry) fail(`${path.basename(archivePath)} holds no ${executableName}`);
  return entry;
}

async function fetchFnox({ target, outputPath, isCheckOnly = false }: FetchFnoxRequest): Promise<void> {
  const downloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-fnox-'));
  try {
    const archivePath = await downloadVerifiedArchive(target, downloadDirectory);
    const executableEntry = executableEntryOf(archivePath, target);
    if (isCheckOnly) {
      console.log(`fetch-fnox: ${path.basename(archivePath)} matches its pinned sha256 and holds ${executableEntry}`);
      return;
    }
    const extractDirectory = path.join(downloadDirectory, 'extracted');
    fs.mkdirSync(extractDirectory);
    execFileSync(tarCommand(), ['-xf', archivePath, '-C', extractDirectory, executableEntry]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(path.join(extractDirectory, ...executableEntry.split('/')), outputPath);
    fs.chmodSync(outputPath, 0o755);
    console.log(`fetch-fnox: fnox ${release.version} for ${target} at ${path.relative(repoRoot, outputPath) || outputPath}`);
  } finally {
    fs.rmSync(downloadDirectory, { recursive: true, force: true });
  }
}

function optionValue(optionName: string): string | null {
  const optionIndex = process.argv.indexOf(optionName);
  if (optionIndex === -1) return null;
  const value = process.argv[optionIndex + 1];
  if (!value || value.startsWith('--')) fail(`${optionName} needs a value`);
  return value;
}

async function fetchForDev(): Promise<void> {
  const target = hostTarget();
  const outputPath = devFnoxPath(target);
  if (reportsPinnedVersion(outputPath)) return;
  await fetchFnox({ target, outputPath });
}

async function fetchRequested(requestedOutputPath: string | null, isCheckOnly: boolean): Promise<void> {
  const target = optionValue('--target') ?? hostTarget();
  const outputPath = requestedOutputPath ? path.resolve(requestedOutputPath) : devFnoxPath(target);
  await fetchFnox({ target, outputPath, isCheckOnly });
}

async function main(): Promise<void> {
  const isCheckOnly = process.argv.includes('--check-only');
  const requestedOutputPath = optionValue('--out');
  const isDevFetch = !requestedOutputPath && !isCheckOnly && !process.argv.includes('--target');
  if (!isDevFetch) return fetchRequested(requestedOutputPath, isCheckOnly);
  return fetchForDev().catch((error: unknown) => {
    console.warn(`${error instanceof Error ? error.message : String(error)}; the dev server starts without fnox, so secret reads fail until a fetch succeeds`);
  });
}

if (import.meta.main) await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

export { fetchFnox, hostTarget };
