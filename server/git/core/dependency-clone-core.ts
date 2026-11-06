import crypto from 'node:crypto';
import path from 'node:path';

export type LockKind = 'npm' | 'pnpm';

export type DependencyLock = {
  kind: LockKind;
  worktreeLockText: string;
  mainStateText: string | null;
};

export type NestedPackageDir = { dir: string; ownLock: DependencyLock | null; hasAnyLockfile: boolean };

type DependencyCloneFacts = {
  worktreeHasNodeModules: boolean;
  mainHasNodeModules: boolean;
  lock: DependencyLock | null;
  mainFilesystemType: number;
  rootFilesystemType: number;
  mainDevice: number;
  worktreeParentDevice: number;
  nestedPackageDirs: NestedPackageDir[];
};

type DependencyCloneSkipReason =
  | 'present'
  | 'platform'
  | 'no-main-install'
  | 'no-lockfile'
  | 'not-apfs'
  | 'other-volume'
  | 'install-stale'
  | 'outside-link'
  | 'torn'
  | 'failed';

type DependencyClonePlan = { action: 'clone'; dirs: string[]; skippedDirs: string[] };
export type DependencyCloneSkip = { action: 'skip'; reason: DependencyCloneSkipReason };

export const LOCKFILE_BY_KIND: Readonly<Record<LockKind, { lockfile: string; installState: string }>> = {
  npm: { lockfile: 'package-lock.json', installState: path.join('node_modules', '.package-lock.json') },
  pnpm: { lockfile: 'pnpm-lock.yaml', installState: path.join('node_modules', '.pnpm', 'lock.yaml') },
};

export const KNOWN_LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export const CLONED_CACHE_DIRS: readonly string[] = ['.cache', '.vite', '.vite-temp'];

export function skipDependencyClone(reason: DependencyCloneSkipReason): DependencyCloneSkip {
  return { action: 'skip', reason };
}

export function planDependencyClone(facts: DependencyCloneFacts): DependencyClonePlan | DependencyCloneSkip {
  if (facts.worktreeHasNodeModules) return skipDependencyClone('present');
  if (!facts.mainHasNodeModules) return skipDependencyClone('no-main-install');
  if (!facts.lock) return skipDependencyClone('no-lockfile');
  if (facts.mainFilesystemType !== facts.rootFilesystemType) return skipDependencyClone('not-apfs');
  if (facts.mainDevice !== facts.worktreeParentDevice) return skipDependencyClone('other-volume');
  if (!isInstallCurrent(facts.lock)) return skipDependencyClone('install-stale');
  const dirs = ['.'];
  const skippedDirs: string[] = [];
  for (const nestedDir of facts.nestedPackageDirs) {
    if (nestedDir.dir === '.') continue;
    if (!isNestedInstallCurrent(nestedDir)) {
      skippedDirs.push(nestedDir.dir);
      continue;
    }
    dirs.push(nestedDir.dir);
  }
  return { action: 'clone', dirs, skippedDirs };
}

function isNestedInstallCurrent({ ownLock, hasAnyLockfile }: NestedPackageDir): boolean {
  if (ownLock) return isInstallCurrent(ownLock);
  return !hasAnyLockfile;
}

export function isLinkInsideCheckout(linkPathInCheckout: string, linkTarget: string): boolean {
  if (path.isAbsolute(linkTarget)) return false;
  const resolvedTarget = path.join(path.dirname(linkPathInCheckout), linkTarget);
  return resolvedTarget !== '..' && !resolvedTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(resolvedTarget);
}

function isInstallCurrent(lock: DependencyLock): boolean {
  if (lock.mainStateText === null) return false;
  return installSatisfiesLockfile(lock.kind, lock.worktreeLockText, lock.mainStateText);
}

function installSatisfiesLockfile(kind: LockKind, worktreeLockText: string, mainStateText: string): boolean {
  if (kind === 'pnpm') return worktreeLockText === mainStateText;
  const wantedPackages = readNpmPackages(worktreeLockText);
  const installedPackages = readNpmPackages(mainStateText);
  if (!wantedPackages || !installedPackages) return false;
  for (const [installPath, installed] of installedPackages) {
    const wanted = wantedPackages.get(installPath);
    if (!wanted || !isSameNpmPackage(wanted, installed)) return false;
  }
  for (const [installPath, wanted] of wantedPackages) {
    if (installPath === '' || installedPackages.has(installPath)) continue;
    if (wanted.optional !== true) return false;
  }
  return true;
}

type NpmPackageEntry = { version?: unknown; integrity?: unknown; resolved?: unknown; optional?: unknown; link?: unknown };

function readNpmPackages(lockText: string): Map<string, NpmPackageEntry> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(lockText); } catch { return null; }
  if (!isRecord(parsed) || !isRecord(parsed.packages)) return null;
  const packages = new Map<string, NpmPackageEntry>();
  for (const [installPath, entry] of Object.entries(parsed.packages)) {
    if (!isRecord(entry)) return null;
    packages.set(installPath, entry);
  }
  return packages;
}

function isSameNpmPackage(wanted: NpmPackageEntry, installed: NpmPackageEntry): boolean {
  return wanted.version === installed.version && wanted.integrity === installed.integrity && wanted.resolved === installed.resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COHERENCE_LOCK_PATH = 'node_modules/@posthog/coherence';
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function coherenceSeedVersion(npmLockText: string | null, rootPackageJsonText: string | null): string | null {
  if (npmLockText === null || rootPackageJsonText === null) return null;
  if (declaresWorkspaces(rootPackageJsonText)) return null;
  const lockedPackages = readNpmPackages(npmLockText);
  if (!lockedPackages) return null;
  if ([...lockedPackages.values()].some(isLocalPackage)) return null;
  const coherence = lockedPackages.get(COHERENCE_LOCK_PATH);
  if (!coherence || typeof coherence.version !== 'string' || !RELEASE_VERSION.test(coherence.version)) return null;
  if (typeof coherence.resolved !== 'string' || !coherence.resolved.startsWith('https://')) return null;
  return coherence.version;
}

export function coherenceSeedArgs(version: string): readonly string[] {
  return ['install', `@posthog/coherence@${version}`, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--prefer-offline', ...REGISTRY_STALL_ARGS];
}

const COHERENCE_NODE_MODULES_PATH = /node_modules\/(?:@posthog\/coherence|\.bin\/coherence)(?![\w.-])/g;

export function mentionsNodeModulesBeyondCoherence(configText: string): boolean {
  return configText.replace(COHERENCE_NODE_MODULES_PATH, '').includes('node_modules');
}

function declaresWorkspaces(packageJsonText: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(packageJsonText); } catch { return true; }
  return !isRecord(parsed) || parsed.workspaces !== undefined;
}

function isLocalPackage(entry: NpmPackageEntry): boolean {
  return entry.link === true || (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:'));
}

export function packageDirsFromTrackedFiles(trackedPackageJsonPaths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const trackedPath of trackedPackageJsonPaths) {
    if (path.posix.basename(trackedPath) !== 'package.json') continue;
    const dir = path.posix.dirname(trackedPath);
    if (dir.split('/').includes('node_modules')) continue;
    dirs.add(dir);
  }
  return [...dirs].sort((left, right) => left.localeCompare(right));
}

export function stagingPathFor(worktreeDir: string, relativeDir: string): string {
  const dirKey = crypto.createHash('sha256').update(relativeDir).digest('hex').slice(0, 16);
  return path.join(path.dirname(worktreeDir), `.${path.basename(worktreeDir)}.${dirKey}.node_modules-clone`);
}

export type PackageDirFacts = { dir: string; hasNodeModules: boolean; lockfiles: readonly string[] };
export type PlannedInstall = { dir: string; command: string; args: readonly string[] };
type DependencyInstallPlan = { installs: PlannedInstall[]; unsupportedDirs: string[] };
export type InstallResult =
  | { dir: string; command: string; ok: true }
  | { dir: string; command: string; ok: false; lastOutputLine: string; timedOut: boolean };
export type DependencyInstallOutcome = { results: InstallResult[]; unsupportedDirs: string[]; elapsedMs: number };

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

const REGISTRY_STALL_ARGS: readonly string[] = ['--fetch-timeout=30000', '--fetch-retries=1'];

const INSTALL_COMMAND_BY_KIND: Readonly<Record<LockKind, { command: string; args: readonly string[] }>> = {
  npm: { command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...REGISTRY_STALL_ARGS] },
  pnpm: { command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts', ...REGISTRY_STALL_ARGS] },
};

const INSTALL_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);

export function planDependencyInstall(platform: string, packageDirs: readonly PackageDirFacts[]): DependencyInstallPlan {
  const plan: DependencyInstallPlan = { installs: [], unsupportedDirs: [] };
  if (platform === 'win32') return plan;
  for (const packageDir of packageDirs) {
    if (packageDir.hasNodeModules) continue;
    const lockKind = installableLockKind(packageDir.lockfiles);
    if (lockKind) {
      plan.installs.push({ dir: packageDir.dir, ...INSTALL_COMMAND_BY_KIND[lockKind] });
      continue;
    }
    if (packageDir.lockfiles.length) plan.unsupportedDirs.push(packageDir.dir);
  }
  return plan;
}

function installableLockKind(lockfiles: readonly string[]): LockKind | null {
  for (const kind of ['npm', 'pnpm'] as const satisfies readonly LockKind[]) {
    if (lockfiles.includes(LOCKFILE_BY_KIND[kind].lockfile)) return kind;
  }
  return null;
}

export function installEnvFrom(serverEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const installEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(serverEnv)) {
    if (INSTALL_ENV_NAMES.has(name)) installEnv[name] = value;
  }
  return installEnv;
}

export function lastOutputLineOf(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

export function describeInstalledDirs(outcome: DependencyInstallOutcome): string | null {
  const installedDirs = outcome.results.filter((result) => result.ok).map((result) => result.dir);
  if (!installedDirs.length) return null;
  return `installed node_modules (${installedDirs.join(', ')}) in ${outcome.elapsedMs}ms`;
}

export function describeInstallWarnings(outcome: DependencyInstallOutcome): string[] {
  const warnings: string[] = [];
  for (const result of outcome.results) {
    if (result.ok) continue;
    const failure = result.timedOut ? 'timed out after 10 minutes' : `failed: ${result.lastOutputLine || 'no output'}`;
    warnings.push(`${result.command} in ${result.dir} ${failure}; install dependencies in the worktree`);
  }
  if (outcome.unsupportedDirs.length) {
    warnings.push(`node_modules in ${outcome.unsupportedDirs.join(', ')} was not installed because the worktree has no package-lock.json or pnpm-lock.yaml there; install dependencies there`);
  }
  return warnings;
}

export function describeDependencyCloneSkip(reason: DependencyCloneSkipReason): string {
  return SKIP_DESCRIPTIONS[reason];
}

const SKIP_DESCRIPTIONS: Readonly<Record<DependencyCloneSkipReason, string>> = {
  present: 'node_modules is already in the worktree',
  platform: 'dependency cloning runs on macOS only',
  'no-main-install': 'the main checkout has no node_modules',
  'no-lockfile': 'the worktree has no package-lock.json or pnpm-lock.yaml',
  'not-apfs': 'the main checkout is not on APFS, so node_modules was not cloned',
  'other-volume': 'the main checkout and the worktree are on different volumes, so node_modules was not cloned',
  'install-stale': "the main checkout's node_modules does not match the worktree's lockfile, so it was not cloned",
  'outside-link': "the main checkout's node_modules holds a link outside the repository (npm link or a file: dependency), so it was not cloned",
  torn: "the main checkout's node_modules changed during the clone, so the clone was discarded",
  failed: 'cloning node_modules from the main checkout failed',
};
