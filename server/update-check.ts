import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';

import type { UpdateChannel } from '../shared/contracts/update-journal.ts';
import { execFileAsync } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import {
  decideInstallFlavor,
  decideUpdateStatus,
  isCheckFresh,
  normalizeSha,
  parseLatestRelease,
  parseRemoteTagSha,
  parseResolvedSha,
} from './core/update-core.ts';
import type { InstallFlavor } from './core/update-core.ts';
import { loadJsonStateFileSync, loadedJsonValue, writeJsonAtomicSync } from './json-file.ts';
import { packageRoot as resolvedPackageRoot } from './runtime-paths.ts';
import { runGit } from './git/git-exec.ts';
import { REPO_SLUG } from '../shared/repo.ts';
import { compareReleaseVersions } from '../shared/build-channel.ts';
import { clock } from '../shared/clock.ts';

const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const RELEASE_REQUEST_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'glimmervoid-update-check' };
const DEFAULT_TIMEOUT_MS = 8000;
const GIT_HEAD_TIMEOUT_MS = 3000;
const RELEASE_ANCESTRY_TIMEOUT_MS = 3000;
const RELEASE_TAG_LOOKUP_TIMEOUT_MS = 5000;
const STATE_FILE_NAME = 'update-check.json';
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_SOURCE = 'github-latest-release';

type RunCommand = typeof execFileAsync;
type GitCallResult = { ok: boolean; out: string; err?: string };

interface InstalledIdentity {
  flavor: InstallFlavor;
  installedSha: string | null;
  installedBranch: string | null;
  upstream: string | null;
  isTreeClean: boolean | null;
}

interface LatestTarget {
  version: string | null;
  sha: string | null;
  reason: string | null;
  deprecation: string | null;
}

interface CheckState {
  lastCheckAt?: unknown;
  channel?: unknown;
  latestVersion?: string | null;
  latestSha?: string | null;
  releaseSource?: unknown;
  reason?: unknown;
  installedVersion?: unknown;
  deprecation?: unknown;
}

interface CheckForUpdateOptions {
  currentVersion?: string;
  updateChannel?: UpdateChannel;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  abortController?: AbortController;
  packageRoot?: string;
  runCommand?: RunCommand;
  statePath?: string;
  ttlMs?: number;
  now?: number;
}

type CoreUpdateStatus = ReturnType<typeof decideUpdateStatus>;
type UpdateCheckStatus = CoreUpdateStatus & {
  installedBranch: string | null;
  upstream: string | null;
  isTreeClean: boolean | null;
  lastCheckAt: number;
};

function defaultStatePath(): string {
  return path.join(glimmervoidHomeDir(), STATE_FILE_NAME);
}

function readJsonFile(filePath: string): unknown {
  return loadedJsonValue(loadJsonStateFileSync({ filePath, parse: (raw: unknown) => raw, quarantine: false }));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLockfileSha(packageRoot: string): string | null {
  const document = readRecord(readJsonFile(path.join(packageRoot, '..', '.package-lock.json')));
  const packages = readRecord(document?.packages);
  const entry = readRecord(packages?.['node_modules/glimmervoid']);
  if (!entry) return null;
  return parseResolvedSha(entry.resolved);
}

function readPackageGitHead(packageRoot: string): string | null {
  const document = readRecord(readJsonFile(path.join(packageRoot, 'package.json')));
  if (!document) return null;
  return normalizeSha(document.gitHead);
}

function directoryExists(directoryPath: string): boolean {
  try {
    return fs.existsSync(directoryPath);
  } catch {
    return false;
  }
}

async function runGitProbe(
  runCommand: RunCommand,
  args: string[],
  { cwd, timeout, signal }: { cwd?: string; timeout: number; signal: AbortSignal },
): Promise<GitCallResult> {
  const result = await runGit(args, { cwd, timeoutMs: timeout, signal, execFileFn: runCommand, preferStderr: true });
  if (result.ok) return { ok: true, out: result.out };
  return { ok: false, out: '', err: result.err.trim() || 'git command failed' };
}

async function probeBranchAndUpstream(
  probe: (args: string[]) => Promise<GitCallResult>,
): Promise<{ branch: string | null; upstream: string | null }> {
  const branchProbe = await probe(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstreamProbe = await probe(['rev-parse', '--abbrev-ref', '@{upstream}']);
  return {
    branch: branchProbe.ok && branchProbe.out !== 'HEAD' ? branchProbe.out : null,
    upstream: upstreamProbe.ok && upstreamProbe.out ? upstreamProbe.out : null,
  };
}

async function cloneIdentity(
  packageRoot: string,
  runCommand: RunCommand,
  signal: AbortSignal,
): Promise<InstalledIdentity> {
  const options = { cwd: packageRoot, timeout: GIT_HEAD_TIMEOUT_MS, signal };
  const head = await runGitProbe(runCommand, ['rev-parse', 'HEAD'], options);
  const checkout = await probeBranchAndUpstream((args) => runGitProbe(runCommand, args, options));
  const status = await runGitProbe(
    runCommand,
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    options,
  );
  return {
    flavor: 'clone',
    installedSha: normalizeSha(head.out),
    installedBranch: checkout.branch,
    upstream: checkout.upstream,
    isTreeClean: status.ok ? status.out === '' : null,
  };
}

function standaloneExecutableRealpath(): string | null {
  if (!isSea()) return null;
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function detectInstallFlavor(packageRoot: string, standaloneExecutablePath = standaloneExecutableRealpath()): ReturnType<typeof decideInstallFlavor> {
  return decideInstallFlavor({
    standaloneExecutablePath,
    packageRoot,
    lockfileSha: readLockfileSha(packageRoot),
    gitHeadSha: readPackageGitHead(packageRoot),
    hasGitDir: directoryExists(path.join(packageRoot, '.git')),
    isInsideNodeModules: path.basename(path.dirname(packageRoot)) === 'node_modules',
  });
}

async function resolveInstalledIdentity(
  { packageRoot, runCommand, signal }: { packageRoot: string; runCommand: RunCommand; signal: AbortSignal },
): Promise<InstalledIdentity> {
  const decided = detectInstallFlavor(packageRoot);
  if (decided.flavor === 'clone') return cloneIdentity(packageRoot, runCommand, signal);
  return { ...decided, installedBranch: null, upstream: null, isTreeClean: null };
}

async function fetchLatestRelease(fetchFn: typeof fetch, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetchFn(LATEST_RELEASE_URL, { signal, headers: RELEASE_REQUEST_HEADERS });
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function resolveReleaseTagSha(
  version: string,
  { packageRoot, runCommand, signal }: { packageRoot: string; runCommand: RunCommand; signal: AbortSignal },
): Promise<string | null> {
  const listing = await runGitProbe(runCommand, ['ls-remote', '--tags', 'origin', `v${version}`, `v${version}^{}`], { cwd: packageRoot, timeout: RELEASE_TAG_LOOKUP_TIMEOUT_MS, signal });
  if (!listing.ok) return null;
  return parseRemoteTagSha(listing.out, version);
}

async function resolveLatestRelease(
  { currentVersion, isClone, packageRoot, runCommand, fetchFn, signal }: { currentVersion: string | undefined; isClone: boolean; packageRoot: string; runCommand: RunCommand; fetchFn: typeof fetch; signal: AbortSignal },
): Promise<LatestTarget> {
  const release = parseLatestRelease(await fetchLatestRelease(fetchFn, signal));
  if (!release) return { version: null, sha: null, reason: 'release-check-failed', deprecation: null };
  const fixesInstalledVersion = release.hasSecurityFix && compareReleaseVersions(release.version, currentVersion ?? null) > 0;
  const deprecation = fixesInstalledVersion ? `Glimmervoid ${release.version} fixes a security issue.` : null;
  const sha = isClone ? await resolveReleaseTagSha(release.version, { packageRoot, runCommand, signal }) : null;
  return { version: release.version, sha, reason: null, deprecation };
}

function readCheckState(statePath: string): CheckState | null {
  return readRecord(readJsonFile(statePath));
}

function writeCheckState(statePath: string, state: Record<string, unknown>): void {
  try {
    writeJsonAtomicSync(statePath, state, { mkdir: true });
  } catch {
  }
}

async function finish(
  installed: InstalledIdentity,
  latestTarget: LatestTarget,
  currentVersion: string | undefined,
  channel: UpdateChannel,
  lastCheckAt: number,
  packageRoot: string,
  runCommand: RunCommand,
  signal: AbortSignal,
): Promise<UpdateCheckStatus> {
  let isLatestReleaseAncestorOfHead = false;
  const latestSha = normalizeSha(latestTarget.sha);
  if (installed.flavor === 'clone' && installed.installedSha && latestSha) {
    const ancestry = await runGitProbe(
      runCommand,
      ['merge-base', '--is-ancestor', latestSha, 'HEAD'],
      { cwd: packageRoot, timeout: RELEASE_ANCESTRY_TIMEOUT_MS, signal },
    );
    isLatestReleaseAncestorOfHead = ancestry.ok;
  }
  return {
    ...decideUpdateStatus({
      installedSha: installed.installedSha,
      latestSha: latestTarget.sha,
      currentVersion,
      latestVersion: latestTarget.version,
      flavor: installed.flavor,
      channel,
      reason: latestTarget.reason,
      isLatestReleaseAncestorOfHead,
      deprecation: latestTarget.deprecation,
    }),
    installedBranch: installed.installedBranch,
    upstream: installed.upstream,
    isTreeClean: installed.isTreeClean,
    lastCheckAt,
  };
}

function targetFromCache(cached: CheckState, currentVersion: string | undefined): LatestTarget {
  return {
    version: typeof cached.latestVersion === 'string' ? cached.latestVersion : null,
    sha: typeof cached.latestSha === 'string' ? cached.latestSha : null,
    reason: typeof cached.reason === 'string' ? cached.reason : null,
    deprecation: cached.installedVersion === currentVersion && typeof cached.deprecation === 'string' ? cached.deprecation : null,
  };
}

async function checkForUpdate({
  currentVersion,
  updateChannel = 'release',
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  abortController = new AbortController(),
  packageRoot = resolvedPackageRoot,
  runCommand = execFileAsync,
  statePath = defaultStatePath(),
  ttlMs = STATE_TTL_MS,
  now = clock.nowMs(),
}: CheckForUpdateOptions = {}): Promise<UpdateCheckStatus> {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const signal = abortController.signal;
  let installed: InstalledIdentity = {
    flavor: 'unknown',
    installedSha: null,
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
  };
  try {
    installed = await resolveInstalledIdentity({ packageRoot, runCommand, signal });
    const cached = readCheckState(statePath);
    const cacheOutrunByInstall = normalizeSha(cached?.latestSha) !== null
      && normalizeSha(cached?.latestSha) === installed.installedSha;
    const isCacheFromSameSource = cached?.releaseSource === RELEASE_SOURCE;
    if (cached?.channel === updateChannel && isCacheFromSameSource && !cacheOutrunByInstall && isCheckFresh(cached.lastCheckAt, now, ttlMs)) {
      return finish(installed, targetFromCache(cached, currentVersion), currentVersion, updateChannel, now, packageRoot, runCommand, signal);
    }
    signal.throwIfAborted();
    const latestTarget = await resolveLatestRelease({ currentVersion, isClone: installed.flavor === 'clone', packageRoot, runCommand, fetchFn, signal });
    const hasCacheableTarget = latestTarget.reason === null
      && (latestTarget.version !== null || latestTarget.sha !== null);
    if (hasCacheableTarget) {
      writeCheckState(statePath, {
        lastCheckAt: now,
        channel: updateChannel,
        latestVersion: latestTarget.version,
        latestSha: normalizeSha(latestTarget.sha),
        releaseSource: RELEASE_SOURCE,
        reason: latestTarget.reason,
        installedVersion: currentVersion ?? null,
        deprecation: latestTarget.deprecation,
      });
    }
    return finish(installed, latestTarget, currentVersion, updateChannel, now, packageRoot, runCommand, signal);
  } catch {
    return finish(
      installed,
      { version: null, sha: null, reason: 'update-check-failed', deprecation: null },
      currentVersion,
      updateChannel,
      now,
      packageRoot,
      runCommand,
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

export { checkForUpdate, detectInstallFlavor, probeBranchAndUpstream, standaloneExecutableRealpath };
export type { UpdateCheckStatus };
