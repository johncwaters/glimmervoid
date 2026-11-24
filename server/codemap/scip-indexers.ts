import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { clock } from '../../shared/clock.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { commandCandidatesOnPath } from '../core/node-launch-core.ts';
import { installEnvFrom } from '../git/core/dependency-clone-core.ts';
import { runCommand } from '../git/git-exec.ts';
import { resolveInstallPath } from '../install-path.ts';
import indexerManifestJson from './scip-indexers.json' with { type: 'json' };
import scipTypescriptLockfile from './scip-typescript.package-lock.json' with { type: 'json' };

const NpmIndexer = z.strictObject({
  kind: z.literal('npm'),
  package: z.string().min(1),
  entry: z.string().min(1),
  extensions: z.array(z.string().startsWith('.')).min(1),
});
type NpmIndexer = z.infer<typeof NpmIndexer>;

const IndexerManifest = z.strictObject({ typescript: NpmIndexer });
type IndexerLanguage = keyof z.infer<typeof IndexerManifest>;

const NpmLockfile = z.object({
  name: z.string().min(1),
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.object({ version: z.string().optional(), dependencies: z.record(z.string(), z.string()).optional() })),
});

interface PinnedNpmIndexer extends NpmIndexer {
  version: string;
  lockfileText: string;
  lockfileHash: string;
  packageJsonText: string;
}

const LOCKFILE_HASH_LENGTH = 12;
const READY_MARKER = '.glimmervoid-ready';
const STAGING_FOLDER = '.staging';
const INSTALL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const WINDOWS_ENV_NAMES = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'ProgramData'];

function pinnedIndexerOf(indexer: NpmIndexer, lockfileJson: unknown): PinnedNpmIndexer {
  const lockfile = NpmLockfile.parse(lockfileJson);
  const rootDependencies = lockfile.packages['']?.dependencies ?? {};
  const version = lockfile.packages[`node_modules/${indexer.package}`]?.version;
  if (!version || rootDependencies[indexer.package] !== version || Object.keys(rootDependencies).length !== 1) throw new Error(`the shipped lockfile of ${indexer.package} must pin exactly that package to one exact version`);
  const lockfileText = `${JSON.stringify(lockfile, null, 2)}\n`;
  return {
    ...indexer,
    version,
    lockfileText,
    lockfileHash: crypto.createHash('sha256').update(lockfileText).digest('hex').slice(0, LOCKFILE_HASH_LENGTH),
    packageJsonText: `${JSON.stringify({ name: lockfile.name, private: true, dependencies: rootDependencies }, null, 2)}\n`,
  };
}

const MANIFEST = IndexerManifest.parse(indexerManifestJson);
const INDEXERS: Record<IndexerLanguage, PinnedNpmIndexer> = { typescript: pinnedIndexerOf(MANIFEST.typescript, scipTypescriptLockfile) };

interface IndexerLaunch {
  entryPath: string;
  env: NodeJS.ProcessEnv;
}

type IndexerOutcome = { ok: true; launch: IndexerLaunch } | { ok: false; reason: string };

type ProvisionState = { state: 'fetching'; fetching: Promise<IndexerOutcome> } | { state: 'ready'; launch: IndexerLaunch } | { state: 'failed'; reason: string; retryAtMs: number };

function indexedLanguagesOf(repoPaths: readonly string[], isTestPath: (repoPath: string) => boolean): IndexerLanguage[] {
  const presentExtensions = new Set(repoPaths.filter((repoPath) => !isTestPath(repoPath)).map((repoPath) => path.posix.extname(repoPath)));
  return (Object.keys(INDEXERS) as IndexerLanguage[]).filter((language) => INDEXERS[language].extensions.some((extension) => presentExtensions.has(extension)));
}

function indexersDirOf(homeDir: string): string {
  return path.join(homeDir, 'indexers');
}

function installDirOf(homeDir: string, indexer: PinnedNpmIndexer): string {
  return path.join(indexersDirOf(homeDir), indexer.package.replace(/[@/]/g, '_'), `${indexer.version}-${indexer.lockfileHash}`);
}

function entryPathOf(installDir: string, indexer: PinnedNpmIndexer): string {
  return path.join(installDir, 'node_modules', indexer.package, indexer.entry);
}

async function indexerEnv(): Promise<NodeJS.ProcessEnv> {
  const installPath = await resolveInstallPath(['npm', 'node']);
  const env = installEnvFrom(process.env, installPath.extraPathEntries);
  if (process.platform !== 'win32') return env;
  for (const name of WINDOWS_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function npmLaunchOf(env: NodeJS.ProcessEnv): { file: string; leadingArgs: string[] } | null {
  if (process.platform !== 'win32') return { file: 'npm', leadingArgs: [] };
  const npmCliPaths = commandCandidatesOnPath('node', env, 'win32').map((nodePath) => path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const npmCliPath = npmCliPaths.find((candidate) => fs.existsSync(candidate));
  return npmCliPath ? { file: 'node', leadingArgs: [npmCliPath] } : null;
}

async function installedLaunchOf(homeDir: string, language: IndexerLanguage): Promise<IndexerLaunch | null> {
  const indexer = INDEXERS[language];
  const installDir = installDirOf(homeDir, indexer);
  const isReady = await fsp.access(path.join(installDir, READY_MARKER)).then(() => true, () => false);
  if (!isReady) return null;
  return { entryPath: entryPathOf(installDir, indexer), env: await indexerEnv() };
}

async function installIndexer(homeDir: string, language: IndexerLanguage): Promise<IndexerOutcome> {
  const indexer = INDEXERS[language];
  const installDir = installDirOf(homeDir, indexer);
  const env = await indexerEnv();
  const npm = npmLaunchOf(env);
  if (!npm) return { ok: false, reason: 'npm-cli.js was not found beside any node on PATH, so the indexer cannot be installed' };
  const stagingDir = path.join(indexersDirOf(homeDir), STAGING_FOLDER, crypto.randomUUID());
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    await fsp.writeFile(path.join(stagingDir, 'package.json'), indexer.packageJsonText);
    await fsp.writeFile(path.join(stagingDir, 'package-lock.json'), indexer.lockfileText);
    const installed = await runCommand(npm.file, [...npm.leadingArgs, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stagingDir, timeoutMs: CODEMAP_TUNABLES.indexerInstallDeadlineMs, maxBuffer: INSTALL_OUTPUT_MAX_BYTES, replaceEnv: env, preferStderr: true });
    if (!installed.ok) return { ok: false, reason: `npm ci of ${indexer.package} ${indexer.version} failed: ${installed.err.trim().split('\n').slice(-3).join(' ')}` };
    await fsp.writeFile(path.join(stagingDir, READY_MARKER), '');
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    await fsp.rename(stagingDir, installDir);
    return { ok: true, launch: { entryPath: entryPathOf(installDir, indexer), env } };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
}

async function sweepStaleFolders(parentDir: string, olderThanMs: number): Promise<void> {
  const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const cutoffMs = clock.nowMs() - olderThanMs;
  for (const entry of entries) {
    const entryPath = path.join(parentDir, entry.name);
    const stats = await fsp.stat(entryPath).catch(() => null);
    if (stats && stats.mtimeMs < cutoffMs) await fsp.rm(entryPath, { recursive: true, force: true }).catch(() => {});
  }
}

function createIndexerProvisioner(homeDir: string) {
  const stateByLanguage = new Map<IndexerLanguage, ProvisionState>();
  const leftoverStagingSwept = sweepStaleFolders(path.join(indexersDirOf(homeDir), STAGING_FOLDER), CODEMAP_TUNABLES.indexerInstallDeadlineMs * 2);

  function fetchIndexer(language: IndexerLanguage): Promise<IndexerOutcome> {
    const fetching = leftoverStagingSwept
      .then(() => installedLaunchOf(homeDir, language))
      .then((installed) => (installed ? { ok: true as const, launch: installed } : installIndexer(homeDir, language)))
      .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        stateByLanguage.set(language, outcome.ok ? { state: 'ready', launch: outcome.launch } : { state: 'failed', reason: outcome.reason, retryAtMs: clock.nowMs() + CODEMAP_TUNABLES.failureRetryMs });
        return outcome;
      });
    stateByLanguage.set(language, { state: 'fetching', fetching });
    return fetching;
  }

  function ensureIndexer(language: IndexerLanguage): Promise<IndexerOutcome> {
    const current = stateByLanguage.get(language);
    if (current?.state === 'ready') return Promise.resolve({ ok: true, launch: current.launch });
    if (current?.state === 'fetching') return current.fetching;
    if (current?.state === 'failed' && clock.nowMs() < current.retryAtMs) return Promise.resolve({ ok: false, reason: current.reason });
    return fetchIndexer(language);
  }

  return { ensureIndexer };
}

type IndexerProvisioner = ReturnType<typeof createIndexerProvisioner>;

export { createIndexerProvisioner, indexedLanguagesOf, sweepStaleFolders };
export type { IndexerLanguage, IndexerProvisioner };
