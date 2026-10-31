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

type DependencyClonePlan = { action: 'clone'; dirs: string[]; staleDirs: string[] };
export type DependencyCloneSkip = { action: 'skip'; reason: DependencyCloneSkipReason; notify: boolean };

export const LOCKFILE_BY_KIND: Readonly<Record<LockKind, { lockfile: string; installState: string }>> = {
  npm: { lockfile: 'package-lock.json', installState: path.join('node_modules', '.package-lock.json') },
  pnpm: { lockfile: 'pnpm-lock.yaml', installState: path.join('node_modules', '.pnpm', 'lock.yaml') },
};

export const KNOWN_LOCKFILES: readonly string[] = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export const CLONED_CACHE_DIRS: readonly string[] = ['.cache', '.vite', '.vite-temp'];

const NOTIFYING_REASONS: ReadonlySet<DependencyCloneSkipReason> = new Set(['not-apfs', 'other-volume', 'install-stale', 'outside-link', 'torn', 'failed']);

export function skipDependencyClone(reason: DependencyCloneSkipReason): DependencyCloneSkip {
  return { action: 'skip', reason, notify: NOTIFYING_REASONS.has(reason) };
}

export function planDependencyClone(facts: DependencyCloneFacts): DependencyClonePlan | DependencyCloneSkip {
  if (facts.worktreeHasNodeModules) return skipDependencyClone('present');
  if (!facts.mainHasNodeModules) return skipDependencyClone('no-main-install');
  if (!facts.lock) return skipDependencyClone('no-lockfile');
  if (facts.mainFilesystemType !== facts.rootFilesystemType) return skipDependencyClone('not-apfs');
  if (facts.mainDevice !== facts.worktreeParentDevice) return skipDependencyClone('other-volume');
  if (!isInstallCurrent(facts.lock)) return skipDependencyClone('install-stale');
  const dirs = ['.'];
  const staleDirs: string[] = [];
  for (const nestedDir of facts.nestedPackageDirs) {
    if (nestedDir.dir === '.') continue;
    if (!isNestedInstallCurrent(nestedDir)) {
      staleDirs.push(nestedDir.dir);
      continue;
    }
    dirs.push(nestedDir.dir);
  }
  return { action: 'clone', dirs, staleDirs };
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

type NpmPackageEntry = { version?: unknown; integrity?: unknown; resolved?: unknown; optional?: unknown };

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

export function describeDependencyCloneSkip(reason: DependencyCloneSkipReason): string {
  return SKIP_DESCRIPTIONS[reason];
}

export function describeStaleDirs(staleDirs: readonly string[]): string {
  return `node_modules in ${staleDirs.join(', ')} does not match its lockfile in the main checkout, so it was not cloned; install dependencies there`;
}

const SKIP_DESCRIPTIONS: Readonly<Record<DependencyCloneSkipReason, string>> = {
  present: 'node_modules is already in the worktree',
  platform: 'dependency cloning runs on macOS only',
  'no-main-install': 'the main checkout has no node_modules',
  'no-lockfile': 'the worktree has no package-lock.json or pnpm-lock.yaml',
  'not-apfs': 'the main checkout is not on APFS, so node_modules was not cloned; install dependencies in the worktree',
  'other-volume': 'the main checkout and the worktree are on different volumes, so node_modules was not cloned; install dependencies in the worktree',
  'install-stale': "the main checkout's node_modules does not match the worktree's lockfile, so it was not cloned; install dependencies in the worktree",
  'outside-link': "the main checkout's node_modules holds a link outside the repository (npm link or a file: dependency), so it was not cloned; install dependencies in the worktree",
  torn: "the main checkout's node_modules changed during the clone, so the clone was discarded; install dependencies in the worktree",
  failed: 'cloning node_modules from the main checkout failed; install dependencies in the worktree',
};
