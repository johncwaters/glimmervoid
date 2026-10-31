import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChangeMap } from '../../shared/contracts/change-map.ts';
import type { ChangedFile, RepoChangeMap } from '../../shared/contracts/change-map.ts';
import type { ChangeScope } from '../../session/session-worktree-lifecycle.ts';
import { gitCommandFailure, runGit } from '../git/git-exec.ts';
import {
  isAgentsDocPath,
  isSourcePath,
  mergeChangedFiles,
  parseNameStatus,
  parseNulSeparatedPaths,
  presentPaths,
  readImportsMap,
} from './core/change-map-core.ts';
import { CO_CHANGE_LOG_ARGS, computeCoChange, parseCoChangeLog } from '../core/co-change-core.ts';
import type { CommitFiles } from '../core/co-change-core.ts';
import { collisionCandidates, computeCollisions, computeSubsystems, parseZeroContextDiff, readAgentsTitle } from './core/change-ownership-core.ts';
import type { FileEditsByPath } from './core/change-ownership-core.ts';
import { buildImportGraph, computeBlastRadius, extractImportSpecifiers, extractPythonImportSpecifiers } from '../core/import-graph-core.ts';
import { createTsconfigPathsResolver, parseTsconfigJsonc, resolveExtendsPath } from '../core/tsconfig-paths-core.ts';
import type { TsconfigPaths } from '../core/tsconfig-paths-core.ts';
import { computeCrossRepoLinks, indexImportersByPackage, readPackageManifest } from '../core/workspace-links-core.ts';
import type { PackageManifest, RepoPackageFacts } from '../core/workspace-links-core.ts';
import { errorMessage } from '../../shared/text.ts';

const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const FILE_READ_BATCH = 64;
const MAX_CACHED_FILES = 50000;
const MAX_CACHED_LOGS = 16;
const SIBLING_SCOPE_TTL_MS = 15000;
const MAX_FACT_FILE_BYTES = 512 * 1024;
const MAX_CACHED_COMMON_DIRS = 256;
const MAX_MEMOIZED_REPO_FACTS = 64;
const MAX_CACHED_STARTING_POINTS = 256;
const MAX_CACHED_EDIT_READS = 64;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ChangeMapSession {
  id: string;
  name: string;
  getChangeScopes(): Promise<ChangeScope[]>;
}

interface ChangeMapSessionSource {
  values(): Iterable<ChangeMapSession>;
  has(id: string): boolean;
}

export function joinSessionRegistries(...registries: ReadonlyMap<string, ChangeMapSession>[]): ChangeMapSessionSource {
  return {
    *values() {
      for (const registry of registries) yield* registry.values();
    },
    has: (id) => registries.some((registry) => registry.has(id)),
  };
}

interface ChangeMapServiceOptions {
  sessions: ChangeMapSessionSource;
  runGit?: (args: string[], cwd: string) => Promise<string>;
  nowFn?: () => number;
}

interface CachedFileFact<Value> {
  mtimeMs: number;
  size: number;
  value: Value;
}

interface WorktreeChanges {
  root: string;
  base: string | null;
  changedPaths: string[];
  untrackedPaths: Set<string>;
}

interface SiblingScopes {
  expiresAt: number;
  scopes: (WorktreeChanges & { commonDir: string })[];
}

interface CachedEditRead {
  expiresAt: number;
  editsByPath: Promise<FileEditsByPath | null>;
}

interface MemoizedRepoFacts {
  memoKey: string;
  repoFacts: RepoChangeMap;
}

interface RepoInputs {
  repoPathsText: string;
  repoPaths: string[];
  specifiersByPath: Map<string, string[]>;
  configsByPath: Map<string, TsconfigPaths>;
}

interface MemoizedImporterIndex {
  memoKey: string;
  importersByPackage: Map<string, string[]>;
}

async function runGitAsync(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, trim: false });
  if (!result.ok) throw gitCommandFailure(args, result, GIT_TIMEOUT_MS);
  return result.out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function ignoreOutcome(): void {}

function rememberBounded<Value>(valueByKey: Map<string, Value>, key: string, value: Value, maxEntries: number): void {
  valueByKey.delete(key);
  if (valueByKey.size >= maxEntries) valueByKey.delete(valueByKey.keys().next().value ?? '');
  valueByKey.set(key, value);
}

function createFileFactCache<Value>(derive: (text: string) => Value | null, oversizedValue: Value | null) {
  const factByAbsolutePath = new Map<string, CachedFileFact<Value>>();
  let missGeneration = 0;

  async function deriveFromFile(absolutePath: string, sizeBytes: number): Promise<Value | null> {
    if (sizeBytes > MAX_FACT_FILE_BYTES) return oversizedValue;
    const text = await fs.promises.readFile(absolutePath, 'utf8').catch(() => null);
    return text === null ? null : derive(text);
  }

  async function read(absolutePath: string): Promise<Value | null> {
    const stats = await fs.promises.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) return null;
    const cached = factByAbsolutePath.get(absolutePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.value;
    const value = await deriveFromFile(absolutePath, stats.size);
    if (value === null) return null;
    missGeneration++;
    if (factByAbsolutePath.size >= MAX_CACHED_FILES) factByAbsolutePath.clear();
    factByAbsolutePath.set(absolutePath, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    return value;
  }

  async function readMany(root: string, repoPaths: string[]): Promise<Map<string, Value>> {
    const valueByPath = new Map<string, Value>();
    for (let batchStart = 0; batchStart < repoPaths.length; batchStart += FILE_READ_BATCH) {
      const batch = repoPaths.slice(batchStart, batchStart + FILE_READ_BATCH);
      const values = await Promise.all(batch.map((repoPath) => read(path.join(root, repoPath))));
      batch.forEach((repoPath, index) => {
        const value = values[index];
        if (value !== null) valueByPath.set(repoPath, value);
      });
      await yieldToEventLoop();
    }
    return valueByPath;
  }

  return { readMany, generation: () => missGeneration };
}

function emptyRepoMap(scope: ChangeScope): RepoChangeMap {
  return {
    name: scope.name,
    root: scope.root,
    sessionPathPrefix: scope.sessionPathPrefix,
    base: scope.base,
    files: [],
    subsystems: [],
    coChangeGaps: [],
    hotspots: [],
    blastRadius: [],
    collisions: [],
    links: [],
    error: null,
  };
}

function worktreeChangesOf(scope: ChangeScope): WorktreeChanges {
  const files = changedFilesOf(scope);
  return {
    root: scope.root,
    base: scope.base,
    changedPaths: files.map((file) => file.path),
    untrackedPaths: new Set(files.filter((file) => file.status === 'untracked').map((file) => file.path)),
  };
}

function changedFilesOf(scope: ChangeScope) {
  return mergeChangedFiles(
    parseNameStatus({ repoName: scope.name, nameStatusText: scope.committedNameStatus, isCommitted: true }),
    parseNameStatus({ repoName: scope.name, nameStatusText: scope.uncommittedNameStatus, isCommitted: false }),
  );
}

export type ChangeMapService = ReturnType<typeof createChangeMapService>;

export function createChangeMapService({
  sessions,
  runGit = runGitAsync,
  nowFn = Date.now,
}: ChangeMapServiceOptions) {
  const specifierCache = createFileFactCache(extractImportSpecifiers, []);
  const pythonSpecifierCache = createFileFactCache(extractPythonImportSpecifiers, []);
  const tsconfigCache = createFileFactCache((text) => ({ config: parseTsconfigJsonc(text) }), { config: null });
  const agentsTitleCache = createFileFactCache(readAgentsTitle, null);
  const packageManifestCache = createFileFactCache<PackageManifest>(readPackageManifest, null);
  const commonDirByRoot = new Map<string, string>();
  const commitsByLogKey = new Map<string, CommitFiles[]>();
  const siblingScopesById = new Map<string, SiblingScopes>();
  const repoFactsByRoot = new Map<string, MemoizedRepoFacts>();
  const importerIndexByRoot = new Map<string, MemoizedImporterIndex>();
  const startingPointByBasePair = new Map<string, Promise<string | null>>();
  const editReadByKey = new Map<string, CachedEditRead>();
  const runningBySessionId = new Map<string, Promise<ChangeMap>>();
  const queuedBySessionId = new Map<string, Promise<ChangeMap>>();

  async function commonDirFor(root: string): Promise<string> {
    const cached = commonDirByRoot.get(root);
    if (cached) return cached;
    const reported = (await runGit(['rev-parse', '--git-common-dir'], root)).trim();
    const commonDir = reported ? path.resolve(root, reported) : root;
    rememberBounded(commonDirByRoot, root, commonDir, MAX_CACHED_COMMON_DIRS);
    return commonDir;
  }

  async function commitsFor(root: string, commonDir: string, historyTip: string): Promise<CommitFiles[]> {
    if (!historyTip) return [];
    const logKey = `${commonDir}:${historyTip}`;
    const cached = commitsByLogKey.get(logKey);
    if (cached) return cached;
    const commits = parseCoChangeLog(await runGit([...CO_CHANGE_LOG_ARGS, historyTip], root));
    if (commitsByLogKey.size >= MAX_CACHED_LOGS) commitsByLogKey.delete(commitsByLogKey.keys().next().value ?? '');
    commitsByLogKey.set(logKey, commits);
    return commits;
  }

  async function siblingScopesOf(sibling: ChangeMapSession): Promise<SiblingScopes['scopes']> {
    const cached = siblingScopesById.get(sibling.id);
    if (cached && cached.expiresAt > nowFn()) return cached.scopes;
    const scopes = await sibling.getChangeScopes().catch((error: unknown) => {
      console.warn(`[change-map] sibling session ${sibling.id} changes could not be read: ${errorMessage(error)}`);
      return [];
    });
    const summarized = await Promise.all(scopes.map(async (scope) => ({
      commonDir: await commonDirFor(scope.root),
      ...worktreeChangesOf(scope),
    })));
    siblingScopesById.set(sibling.id, { expiresAt: nowFn() + SIBLING_SCOPE_TTL_MS, scopes: summarized });
    return summarized;
  }

  function forgetEndedSiblings(): void {
    for (const siblingId of siblingScopesById.keys()) {
      if (!sessions.has(siblingId)) siblingScopesById.delete(siblingId);
    }
  }

  async function otherSessionsOn(commonDir: string, selfId: string) {
    const otherSessions: { id: string; name: string; changedPaths: string[]; worktrees: WorktreeChanges[] }[] = [];
    for (const sibling of sessions.values()) {
      if (sibling.id === selfId) continue;
      const matching = (await siblingScopesOf(sibling)).filter((scope) => scope.commonDir === commonDir);
      const changedPaths = matching.flatMap((scope) => scope.changedPaths);
      if (changedPaths.length > 0) otherSessions.push({ id: sibling.id, name: sibling.name, changedPaths, worktrees: matching });
    }
    return otherSessions;
  }

  function readStartingPoint(root: string, selfBase: string, otherBase: string): Promise<string | null> {
    return runGit(['merge-base', selfBase, otherBase], root).then((output) => output.trim() || null, () => null);
  }

  function sharedStartingPoint(root: string, commonDir: string, selfBase: string | null, otherBase: string | null): Promise<string | null> {
    if (!selfBase || !otherBase) return Promise.resolve(null);
    if (selfBase === otherBase) return Promise.resolve(selfBase);
    if (!FULL_COMMIT_SHA.test(selfBase) || !FULL_COMMIT_SHA.test(otherBase)) return readStartingPoint(root, selfBase, otherBase);
    const basePairKey = `${commonDir}:${[selfBase, otherBase].sort().join(':')}`;
    const cached = startingPointByBasePair.get(basePairKey);
    if (cached) return cached;
    const startingPoint = readStartingPoint(root, selfBase, otherBase);
    rememberBounded(startingPointByBasePair, basePairKey, startingPoint, MAX_CACHED_STARTING_POINTS);
    void startingPoint.then((resolved) => {
      if (resolved === null) startingPointByBasePair.delete(basePairKey);
    });
    return startingPoint;
  }

  async function readEditsSince(worktree: WorktreeChanges, startingPoint: string, paths: string[]): Promise<FileEditsByPath | null> {
    const diffText = await runGit(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', startingPoint, '--', ...paths], worktree.root).catch(() => null);
    if (diffText === null) return null;
    const editsByPath = parseZeroContextDiff(diffText);
    for (const path of paths) {
      if (editsByPath.has(path)) continue;
      editsByPath.set(path, { isAdded: worktree.untrackedPaths.has(path), isComparable: true, baseRanges: [] });
    }
    return editsByPath;
  }

  function editsSince(worktree: WorktreeChanges, startingPoint: string | null, paths: string[]): Promise<FileEditsByPath | null> {
    if (!startingPoint || paths.length === 0) return Promise.resolve(null);
    const editReadKey = `${worktree.root}:${startingPoint}:${paths.join(':')}`;
    const cached = editReadByKey.get(editReadKey);
    if (cached && cached.expiresAt > nowFn()) return cached.editsByPath;
    const editsByPath = readEditsSince(worktree, startingPoint, paths);
    rememberBounded(editReadByKey, editReadKey, { expiresAt: nowFn() + SIBLING_SCOPE_TTL_MS, editsByPath }, MAX_CACHED_EDIT_READS);
    return editsByPath;
  }

  async function rateCollisions(scope: ChangeScope, commonDir: string, selfId: string, changedPaths: string[]) {
    const self = worktreeChangesOf(scope);
    const otherSessions = await otherSessionsOn(commonDir, selfId);
    const candidates = collisionCandidates({ changedPaths, otherSessions });
    const sharedPathsByOtherSessionId = new Map<string, string[]>();
    for (const candidate of candidates) {
      const sharedPaths = sharedPathsByOtherSessionId.get(candidate.otherSessionId) ?? [];
      sharedPaths.push(candidate.path);
      sharedPathsByOtherSessionId.set(candidate.otherSessionId, sharedPaths);
    }
    const editsByOtherSessionId = new Map<string, { selfEditsByPath: FileEditsByPath | null; otherEditsByPath: FileEditsByPath | null }>();
    await Promise.all(otherSessions.map(async (otherSession) => {
      const sharedPaths = sharedPathsByOtherSessionId.get(otherSession.id);
      const otherWorktree = sharedPaths && otherSession.worktrees.find((worktree) => sharedPaths.some((path) => worktree.changedPaths.includes(path)));
      if (!sharedPaths || !otherWorktree) return;
      const startingPoint = await sharedStartingPoint(scope.root, commonDir, self.base, otherWorktree.base);
      const [selfEditsByPath, otherEditsByPath] = await Promise.all([
        editsSince(self, startingPoint, sharedPaths),
        editsSince(otherWorktree, startingPoint, sharedPaths),
      ]);
      editsByOtherSessionId.set(otherSession.id, { selfEditsByPath, otherEditsByPath });
    }));
    return computeCollisions({
      repoName: scope.name,
      candidates,
      editsFor: (candidate) => {
        const edits = editsByOtherSessionId.get(candidate.otherSessionId);
        return { selfEdits: edits?.selfEditsByPath?.get(candidate.path), otherEdits: edits?.otherEditsByPath?.get(candidate.path) };
      },
    });
  }

  async function repoFactsFor(scope: ChangeScope, files: ChangedFile[], commonDir: string, inputs: RepoInputs): Promise<RepoChangeMap> {
    const repoName = scope.name;
    const changedPaths = files.map((file) => file.path);
    const { repoPathsText, repoPaths, specifiersByPath, configsByPath } = inputs;
    const agentsTitleByPath = await agentsTitleCache.readMany(scope.root, repoPaths.filter(isAgentsDocPath));
    const packageJsonText = await fs.promises.readFile(path.join(scope.root, 'package.json'), 'utf8').catch(() => null);
    const historyTip = scope.base || (await runGit(['rev-parse', 'HEAD'], scope.root)).trim();
    const memoKey = hashText(JSON.stringify([
      scope.name, scope.base, scope.committedNameStatus, scope.uncommittedNameStatus, hashText(repoPathsText),
      specifierCache.generation(), pythonSpecifierCache.generation(), tsconfigCache.generation(), agentsTitleCache.generation(), packageJsonText, historyTip,
    ]));
    const memoized = repoFactsByRoot.get(scope.root);
    if (memoized && memoized.memoKey === memoKey) return memoized.repoFacts;
    const graph = buildImportGraph({ specifiersByPath, importsMap: readImportsMap(packageJsonText), tsconfigTargets: createTsconfigPathsResolver(configsByPath) });
    const blastRadius = computeBlastRadius({ repoName, graph, changedPaths: presentPaths(files) });
    const agentsDocs = [...agentsTitleByPath].map(([agentsPath, title]) => ({ path: agentsPath, title }));
    const commits = await commitsFor(scope.root, commonDir, historyTip);
    const { coChangeGaps, hotspots } = computeCoChange({ repoName, commits, changedPaths });
    const repoFacts: RepoChangeMap = {
      ...emptyRepoMap(scope),
      files,
      subsystems: computeSubsystems({ repoName, changedPaths, agentsDocs }),
      coChangeGaps,
      hotspots,
      blastRadius,
    };
    rememberBounded(repoFactsByRoot, scope.root, { memoKey, repoFacts }, MAX_MEMOIZED_REPO_FACTS);
    return repoFacts;
  }

  async function buildRepoMap(scope: ChangeScope, selfId: string, repoInputsFor: (root: string) => Promise<RepoInputs>): Promise<RepoChangeMap> {
    const files = changedFilesOf(scope);
    if (files.length === 0) return emptyRepoMap(scope);
    const commonDir = await commonDirFor(scope.root);
    const repoFacts = await repoFactsFor(scope, files, commonDir, await repoInputsFor(scope.root));
    const changedPaths = files.map((file) => file.path);
    return { ...repoFacts, collisions: await rateCollisions(scope, commonDir, selfId, changedPaths) };
  }

  async function buildRepoMapSafely(scope: ChangeScope, selfId: string, repoInputsFor: (root: string) => Promise<RepoInputs>): Promise<RepoChangeMap> {
    try {
      return await buildRepoMap(scope, selfId, repoInputsFor);
    } catch (error) {
      console.warn(`[change-map] ${scope.name} map could not be built for session ${selfId}: ${errorMessage(error)}`);
      return { ...emptyRepoMap(scope), files: changedFilesOf(scope), error: errorMessage(error) };
    }
  }

  async function assemble(session: ChangeMapSession): Promise<ChangeMap> {
    forgetEndedSiblings();
    const scopes = await session.getChangeScopes();
    const inputsByRoot = new Map<string, Promise<RepoInputs>>();
    function repoInputsFor(root: string): Promise<RepoInputs> {
      const cached = inputsByRoot.get(root);
      if (cached) return cached;
      const inputs = (async () => {
        const repoPathsText = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
        const repoPaths = parseNulSeparatedPaths(repoPathsText);
        const sourcePaths = repoPaths.filter(isSourcePath);
        const [javascriptSpecifiers, pythonSpecifiers] = await Promise.all([
          specifierCache.readMany(root, sourcePaths.filter((repoPath) => !repoPath.endsWith('.py'))),
          pythonSpecifierCache.readMany(root, sourcePaths.filter((repoPath) => repoPath.endsWith('.py'))),
        ]);
        const specifiersByPath = new Map([...javascriptSpecifiers, ...pythonSpecifiers]);
        const listedPaths = new Set(repoPaths);
        const configsByPath = new Map<string, TsconfigPaths>();
        const visitedConfigs = new Set<string>();
        let pendingConfigs = repoPaths.filter((repoPath) => path.posix.basename(repoPath) === 'tsconfig.json');
        while (pendingConfigs.length > 0) {
          const unreadConfigs = pendingConfigs.filter((repoPath) => !visitedConfigs.has(repoPath));
          if (unreadConfigs.length === 0) break;
          for (const repoPath of unreadConfigs) visitedConfigs.add(repoPath);
          const configs = await tsconfigCache.readMany(root, unreadConfigs);
          pendingConfigs = [];
          for (const [configPath, { config }] of configs) {
            if (!config) continue;
            configsByPath.set(configPath, config);
            if (!config.extendsPath) continue;
            const parentPath = resolveExtendsPath(configPath, config.extendsPath);
            if (listedPaths.has(parentPath) && !visitedConfigs.has(parentPath)) pendingConfigs.push(parentPath);
          }
        }
        return { repoPathsText, repoPaths, specifiersByPath, configsByPath };
      })();
      inputsByRoot.set(root, inputs);
      return inputs;
    }
    const repos: RepoChangeMap[] = [];
    for (const scope of scopes) repos.push(await buildRepoMapSafely(scope, session.id, repoInputsFor));
    if (scopes.length > 1) {
      const packageFacts = await Promise.allSettled(scopes.map(async (scope): Promise<RepoPackageFacts> => {
        const inputs = await repoInputsFor(scope.root);
        const manifestsByPath = await packageManifestCache.readMany(scope.root, inputs.repoPaths.filter((repoPath) => path.posix.basename(repoPath) === 'package.json'));
        const memoKey = hashText(JSON.stringify([specifierCache.generation(), pythonSpecifierCache.generation(), hashText(inputs.repoPathsText)]));
        const memoized = importerIndexByRoot.get(scope.root);
        const importersByPackage = memoized && memoized.memoKey === memoKey
          ? memoized.importersByPackage
          : indexImportersByPackage(inputs.specifiersByPath);
        if (!memoized || memoized.memoKey !== memoKey) {
          rememberBounded(importerIndexByRoot, scope.root, { memoKey, importersByPackage }, MAX_MEMOIZED_REPO_FACTS);
        }
        return {
          repoName: scope.name,
          manifests: [...manifestsByPath].map(([manifestPath, manifest]) => ({ path: manifestPath, manifest })),
          importersByPackage,
          changedPaths: changedFilesOf(scope).map((file) => file.path),
        };
      }));
      try {
        const linksByConsumer = computeCrossRepoLinks(packageFacts.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []));
        for (const repo of repos) repo.links = linksByConsumer.get(repo.name) ?? [];
      } catch {
        for (const repo of repos) repo.links = [];
      }
    }
    return ChangeMap.parse({
      sessionId: session.id,
      sig: hashText(JSON.stringify(scopes)),
      generatedAt: nowFn(),
      repos,
    });
  }

  function startAssembly(session: ChangeMapSession): Promise<ChangeMap> {
    const running = assemble(session).finally(() => {
      if (runningBySessionId.get(session.id) === running) runningBySessionId.delete(session.id);
    });
    runningBySessionId.set(session.id, running);
    return running;
  }

  function build(session: ChangeMapSession): Promise<ChangeMap> {
    const queued = queuedBySessionId.get(session.id);
    if (queued) return queued;
    const running = runningBySessionId.get(session.id);
    if (!running) return startAssembly(session);
    const followUp = running.then(ignoreOutcome, ignoreOutcome).then(() => {
      queuedBySessionId.delete(session.id);
      return startAssembly(session);
    });
    queuedBySessionId.set(session.id, followUp);
    return followUp;
  }

  return { build };
}
