import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { z } from 'zod';

import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { commandCandidatesOnPath } from '../core/node-launch-core.ts';
import { installEnvFrom } from '../git/core/dependency-clone-core.ts';
import { runCommand } from '../git/git-exec.ts';
import { resolveInstallPath } from '../install-path.ts';
import indexerManifestJson from './scip-indexers.json' with { type: 'json' };
import scipPythonLockfile from './scip-python.package-lock.json' with { type: 'json' };
import scipTypescriptLockfile from './scip-typescript.package-lock.json' with { type: 'json' };

const Extensions = z.array(z.string().startsWith('.')).min(1);

const NpmIndexer = z.strictObject({
  kind: z.literal('npm'),
  package: z.string().min(1),
  entry: z.string().min(1),
  extensions: Extensions,
});
type NpmIndexer = z.infer<typeof NpmIndexer>;

const ArchiveIndexer = z.strictObject({
  kind: z.literal('archive'),
  name: z.string().regex(/^[a-z][a-z-]*$/),
  version: z.string().min(1),
  urlPrefix: z.url().startsWith('https://github.com/'),
  executable: z.string().min(1),
  toolchain: z.string().min(1),
  extensions: Extensions,
  assetByHost: z.record(z.string(), z.strictObject({ asset: z.string().regex(/\.(tar\.gz|gz|zip)$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
type ArchiveIndexer = z.infer<typeof ArchiveIndexer>;

const IndexerManifest = z.strictObject({ typescript: NpmIndexer, python: NpmIndexer, go: ArchiveIndexer, rust: ArchiveIndexer });
type IndexerLanguage = keyof z.infer<typeof IndexerManifest>;

const NpmLockfile = z.object({
  name: z.string().min(1),
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.object({ version: z.string().optional(), dependencies: z.record(z.string(), z.string()).optional() })),
});

interface PinnedNpmIndexer extends NpmIndexer {
  version: string;
  lockfileText: string;
  installKey: string;
  packageJsonText: string;
}

type PinnedIndexer = PinnedNpmIndexer | (ArchiveIndexer & { installKey: string });

const PIN_HASH_LENGTH = 12;
const READY_MARKER = '.glimmervoid-ready';
const STAGING_FOLDER = '.staging';
const INSTALL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const WINDOWS_ENV_NAMES = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'ProgramData'];
const TOOLCHAIN_ENV_NAMES = ['GOROOT', 'GOPATH', 'GOMODCACHE', 'GOPROXY', 'GOPRIVATE', 'GONOSUMDB', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN'];
const INDEXED_PROJECT_NAME = 'repo';
const RUST_ANALYZER_CONFIG = { cargo: { buildScripts: { enable: false, overrideCommand: ['cargo', '--version'] } }, procMacro: { enable: false } };
const TSCONFIG_NAME = 'tsconfig.json';
const DERIVED_TSCONFIG_NAME = '.glimmervoid-index.tsconfig.json';
const TSCONFIG_ROOTS_MAX_BYTES = 64 * 1024 * 1024;
const TSCONFIG_ROOTS_SCRIPT = [
  'const [programPath, configPath] = process.argv.slice(1);',
  "const ts = require('node:module').createRequire(programPath)('typescript');",
  "const svelteFileExtension = { extension: '.svelte', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred };",
  'const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => process.exit(2) }, undefined, undefined, [svelteFileExtension]);',
  'if (!parsed || (parsed.projectReferences ?? []).length > 0) process.exit(3);',
  'process.stdout.write(JSON.stringify(parsed.fileNames));',
].join('\n');
const TsconfigRoots = z.array(z.string());
const gunzip = promisify(zlib.gunzip);

function shortHashOf(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, PIN_HASH_LENGTH);
}

function pinnedNpmIndexerOf(indexer: NpmIndexer, lockfileJson: unknown): PinnedNpmIndexer {
  const lockfile = NpmLockfile.parse(lockfileJson);
  const rootDependencies = lockfile.packages['']?.dependencies ?? {};
  const version = lockfile.packages[`node_modules/${indexer.package}`]?.version;
  if (!version || rootDependencies[indexer.package] !== version || Object.keys(rootDependencies).length !== 1) throw new Error(`the shipped lockfile of ${indexer.package} must pin exactly that package to one exact version`);
  const lockfileText = `${JSON.stringify(lockfile, null, 2)}\n`;
  return {
    ...indexer,
    version,
    lockfileText,
    installKey: path.join(indexer.package.replace(/[@/]/g, '_'), `${version}-${shortHashOf(lockfileText)}`),
    packageJsonText: `${JSON.stringify({ name: lockfile.name, private: true, dependencies: rootDependencies }, null, 2)}\n`,
  };
}

function pinnedArchiveIndexerOf(indexer: ArchiveIndexer): PinnedIndexer {
  return { ...indexer, installKey: path.join(indexer.name, `${indexer.version}-${shortHashOf(JSON.stringify(indexer.assetByHost))}`) };
}

const MANIFEST = IndexerManifest.parse(indexerManifestJson);
const INDEXERS: Record<IndexerLanguage, PinnedIndexer> = {
  typescript: pinnedNpmIndexerOf(MANIFEST.typescript, scipTypescriptLockfile),
  python: pinnedNpmIndexerOf(MANIFEST.python, scipPythonLockfile),
  go: pinnedArchiveIndexerOf(MANIFEST.go),
  rust: pinnedArchiveIndexerOf(MANIFEST.rust),
};

interface IndexerLaunch {
  programPath: string;
  env: NodeJS.ProcessEnv;
}

interface IndexCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  indexPath: string;
  pathPrefix: string;
}

interface IndexedTree {
  treeDir: string;
  workDir: string;
  repoPaths: readonly string[];
  isTestPath: (repoPath: string) => boolean;
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

function installDirOf(homeDir: string, indexer: PinnedIndexer): string {
  return path.join(indexersDirOf(homeDir), indexer.installKey);
}

function hostKey(): string {
  return `${process.platform}-${process.arch}`;
}

function executableNameOf(indexer: ArchiveIndexer): string {
  return process.platform === 'win32' ? `${indexer.executable}.exe` : indexer.executable;
}

function programPathOf(installDir: string, indexer: PinnedIndexer): string {
  if (indexer.kind === 'npm') return path.join(installDir, 'node_modules', indexer.package, indexer.entry);
  return path.join(installDir, executableNameOf(indexer));
}

async function indexerEnv(toolNames: readonly string[]): Promise<NodeJS.ProcessEnv> {
  const installPath = await resolveInstallPath(toolNames);
  const env = installEnvFrom(process.env, installPath.extraPathEntries);
  const keptNames = process.platform === 'win32' ? [...TOOLCHAIN_ENV_NAMES, ...WINDOWS_ENV_NAMES] : TOOLCHAIN_ENV_NAMES;
  for (const name of keptNames) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function toolNamesOf(indexer: PinnedIndexer): string[] {
  return indexer.kind === 'npm' ? ['npm', 'node'] : [indexer.toolchain];
}

function npmLaunchOf(env: NodeJS.ProcessEnv): { file: string; leadingArgs: string[] } | null {
  if (process.platform !== 'win32') return { file: 'npm', leadingArgs: [] };
  const npmCliPaths = commandCandidatesOnPath('node', env, 'win32').map((nodePath) => path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const npmCliPath = npmCliPaths.find((candidate) => fs.existsSync(candidate));
  return npmCliPath ? { file: 'node', leadingArgs: [npmCliPath] } : null;
}

function isToolchainOnPath(toolchain: string, env: NodeJS.ProcessEnv): boolean {
  return commandCandidatesOnPath(toolchain, env, process.platform).some((candidate) => fs.existsSync(candidate));
}

async function installedLaunchOf(homeDir: string, language: IndexerLanguage): Promise<IndexerLaunch | null> {
  const indexer = INDEXERS[language];
  const installDir = installDirOf(homeDir, indexer);
  const isReady = await fsp.access(path.join(installDir, READY_MARKER)).then(() => true, () => false);
  if (!isReady) return null;
  return { programPath: programPathOf(installDir, indexer), env: await indexerEnv(toolNamesOf(indexer)) };
}

async function stageNpmIndexer(indexer: PinnedNpmIndexer, stagingDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const npm = npmLaunchOf(env);
  if (!npm) return 'npm-cli.js was not found beside any node on PATH, so the indexer cannot be installed';
  await fsp.writeFile(path.join(stagingDir, 'package.json'), indexer.packageJsonText);
  await fsp.writeFile(path.join(stagingDir, 'package-lock.json'), indexer.lockfileText);
  const installed = await runCommand(npm.file, [...npm.leadingArgs, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stagingDir, timeoutMs: CODEMAP_TUNABLES.indexerInstallDeadlineMs, maxBuffer: INSTALL_OUTPUT_MAX_BYTES, replaceEnv: env, preferStderr: true });
  if (!installed.ok) return `npm ci of ${indexer.package} ${indexer.version} failed: ${installed.err.trim().split('\n').slice(-3).join(' ')}`;
  return null;
}

function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

async function stageArchiveIndexer(indexer: ArchiveIndexer, stagingDir: string): Promise<string | null> {
  const pinned = indexer.assetByHost[hostKey()];
  if (!pinned) return `${indexer.name} ships no build for ${hostKey()}`;
  const assetUrl = `${indexer.urlPrefix}${pinned.asset}`;
  const response = await fetch(assetUrl, { signal: AbortSignal.timeout(CODEMAP_TUNABLES.indexerInstallDeadlineMs) }).catch((error: unknown) => errorMessage(error));
  if (typeof response === 'string') return `${assetUrl} could not be fetched: ${response}`;
  if (!response.ok) return `${assetUrl} answered ${response.status}`;
  const assetBytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = crypto.createHash('sha256').update(assetBytes).digest('hex');
  if (actualSha256 !== pinned.sha256) return `${pinned.asset} has sha256 ${actualSha256}, pinned ${pinned.sha256}`;
  const programPath = path.join(stagingDir, executableNameOf(indexer));
  if (pinned.asset.endsWith('.tar.gz') || pinned.asset.endsWith('.zip')) {
    const archivePath = path.join(stagingDir, pinned.asset);
    await fsp.writeFile(archivePath, assetBytes);
    const unpacked = await runCommand(tarCommand(), ['-xf', archivePath, '-C', stagingDir], { timeoutMs: CODEMAP_TUNABLES.indexerInstallDeadlineMs });
    await fsp.rm(archivePath, { force: true });
    if (!unpacked.ok) return `unpacking ${pinned.asset} failed: ${unpacked.err}`;
  }
  if (!pinned.asset.endsWith('.tar.gz') && !pinned.asset.endsWith('.zip')) await fsp.writeFile(programPath, await gunzip(assetBytes));
  const isUnpacked = await fsp.access(programPath).then(() => true, () => false);
  if (!isUnpacked) return `${pinned.asset} holds no ${executableNameOf(indexer)}`;
  await fsp.chmod(programPath, 0o755);
  return null;
}

async function installIndexer(homeDir: string, language: IndexerLanguage): Promise<IndexerOutcome> {
  const indexer = INDEXERS[language];
  const installDir = installDirOf(homeDir, indexer);
  const env = await indexerEnv(toolNamesOf(indexer));
  const stagingDir = path.join(indexersDirOf(homeDir), STAGING_FOLDER, crypto.randomUUID());
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    const failure = indexer.kind === 'npm' ? await stageNpmIndexer(indexer, stagingDir, env) : await stageArchiveIndexer(indexer, stagingDir);
    if (failure) return { ok: false, reason: failure };
    await fsp.writeFile(path.join(stagingDir, READY_MARKER), '');
    await fsp.rm(installDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    await fsp.rename(stagingDir, installDir);
    return { ok: true, launch: { programPath: programPathOf(installDir, indexer), env } };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
}

function goModuleDirsOf(repoPaths: readonly string[], isTestPath: (repoPath: string) => boolean): string[] {
  return repoPaths.filter((repoPath) => path.posix.basename(repoPath) === 'go.mod' && !isTestPath(repoPath) && !/(^|\/)(vendor|testdata)\//.test(repoPath)).map((repoPath) => path.posix.dirname(repoPath));
}

async function typescriptRootsOf(launch: IndexerLaunch, treeDir: string): Promise<string[] | null> {
  const configPath = path.join(treeDir, TSCONFIG_NAME);
  const hasConfig = await fsp.access(configPath).then(() => true, () => false);
  if (!hasConfig) return null;
  const listed = await runCommand('node', ['--input-type=commonjs', '-e', TSCONFIG_ROOTS_SCRIPT, launch.programPath, configPath], { cwd: treeDir, timeoutMs: CODEMAP_TUNABLES.indexDeadlineMs, maxBuffer: TSCONFIG_ROOTS_MAX_BYTES, replaceEnv: launch.env });
  if (!listed.ok) return null;
  const parsed = TsconfigRoots.safeParse(JSON.parse(listed.out));
  if (!parsed.success) return null;
  return parsed.data.map((rootPath) => path.relative(treeDir, rootPath).split(path.sep).join('/')).filter((repoPath) => !repoPath.startsWith('../'));
}

async function typescriptProjectArgsOf(launch: IndexerLaunch, tree: IndexedTree): Promise<string[]> {
  const roots = await typescriptRootsOf(launch, tree.treeDir);
  const keptRoots = roots?.filter((repoPath) => !tree.isTestPath(repoPath)) ?? [];
  if (keptRoots.length === 0) return ['--infer-tsconfig'];
  const derivedConfigPath = path.join(tree.treeDir, DERIVED_TSCONFIG_NAME);
  await fsp.writeFile(derivedConfigPath, `${JSON.stringify({ extends: `./${TSCONFIG_NAME}`, include: [], files: keptRoots.map((repoPath) => `./${repoPath}`) })}\n`);
  return [derivedConfigPath];
}

async function indexCommandsOf(language: IndexerLanguage, launch: IndexerLaunch, tree: IndexedTree): Promise<IndexCommand[] | { reason: string }> {
  const indexer = INDEXERS[language];
  const { treeDir, workDir } = tree;
  const indexPath = path.join(workDir, `${language}.scip`);
  if (indexer.kind === 'archive' && !isToolchainOnPath(indexer.toolchain, launch.env)) return { reason: `${indexer.name} needs ${indexer.toolchain} on PATH, and none was found` };
  if (language === 'typescript') return [{ file: 'node', args: [launch.programPath, 'index', ...await typescriptProjectArgsOf(launch, tree), '--no-progress-bar', '--output', indexPath], env: launch.env, cwd: treeDir, indexPath, pathPrefix: '' }];
  if (language === 'python') {
    const environmentPath = path.join(workDir, 'python-environment.json');
    await fsp.writeFile(environmentPath, '[]\n');
    return [{ file: 'node', args: [launch.programPath, 'index', '--quiet', '--project-name', INDEXED_PROJECT_NAME, '--project-version', '0', '--environment', environmentPath, '--output', indexPath], env: launch.env, cwd: treeDir, indexPath, pathPrefix: '' }];
  }
  if (language === 'go') {
    const moduleDirs = goModuleDirsOf(tree.repoPaths, tree.isTestPath);
    if (moduleDirs.length === 0) return { reason: 'the tree holds Go files but no go.mod' };
    const goEnv = { ...launch.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' };
    return moduleDirs.map((moduleDir, moduleIndex) => {
      const moduleIndexPath = path.join(workDir, `go-${moduleIndex}.scip`);
      return { file: launch.programPath, args: ['index', '--quiet', '--skip-tests', '--repository-remote', INDEXED_PROJECT_NAME, '--module-version', '0', '--output', moduleIndexPath], env: goEnv, cwd: path.join(treeDir, moduleDir), indexPath: moduleIndexPath, pathPrefix: moduleDir === '.' ? '' : `${moduleDir}/` };
    });
  }
  const configPath = path.join(workDir, 'rust-analyzer.json');
  await fsp.writeFile(configPath, `${JSON.stringify(RUST_ANALYZER_CONFIG)}\n`);
  return [{ file: launch.programPath, args: ['scip', treeDir, '--config-path', configPath, '--output', indexPath], env: launch.env, cwd: treeDir, indexPath, pathPrefix: '' }];
}

function languageOfPath(repoPath: string): IndexerLanguage | null {
  const extension = path.posix.extname(repoPath);
  return (Object.keys(INDEXERS) as IndexerLanguage[]).find((language) => INDEXERS[language].extensions.includes(extension)) ?? null;
}

function indexerPinOf(language: IndexerLanguage): string {
  const indexer = INDEXERS[language];
  return indexer.kind === 'npm' ? `${indexer.package}@${indexer.version}` : `${indexer.name}@${indexer.version}`;
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
      .catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }))
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

export { createIndexerProvisioner, indexCommandsOf, indexedLanguagesOf, indexerPinOf, languageOfPath, sweepStaleFolders, tarCommand };
export type { IndexedTree, IndexerLanguage, IndexerProvisioner };
