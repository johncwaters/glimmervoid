import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ChangeMap } from '../shared/contracts/change-map.ts';
import type { ChangedFile, ChangeNarrative, NarratorState, RepoChangeMap } from '../shared/contracts/change-map.ts';
import type { ChangeScope } from '../session/session-worktree-lifecycle.ts';
import { execFile } from './child-process-safe.ts';
import {
  isAgentsDocPath,
  isSourcePath,
  mergeChangedFiles,
  parseNameStatus,
  parseNulSeparatedPaths,
  presentPaths,
  readImportsMap,
} from './core/change-map-core.ts';
import { CO_CHANGE_LOG_ARGS, computeCoChange, parseCoChangeLog } from './core/co-change-core.ts';
import type { CommitFiles } from './core/co-change-core.ts';
import { computeCollisions, computeSubsystems, readAgentsTitle } from './core/change-ownership-core.ts';
import { buildImportGraph, computeBlastRadius, extractImportSpecifiers } from './core/import-graph-core.ts';

const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const FILE_READ_BATCH = 64;
const MAX_CACHED_FILES = 50000;
const MAX_CACHED_LOGS = 16;
const SIBLING_SCOPE_TTL_MS = 15000;
const MAX_FACT_FILE_BYTES = 512 * 1024;
const MAX_CACHED_COMMON_DIRS = 256;
const MAX_MEMOIZED_REPO_FACTS = 64;

export interface ChangeMapSession {
  id: string;
  name: string;
  getChangeScopes(): Promise<ChangeScope[]>;
}

export interface ChangeMapNarration {
  narrative: ChangeNarrative | null;
  narratorState: NarratorState;
}

export interface ChangeMapNarrator {
  narrationFor(map: ChangeMap, onSettled: () => void, options?: { mayStart?: boolean }): ChangeMapNarration;
}

export interface ChangeMapBuildOptions {
  mayStartNarration?: boolean;
}

interface ChangeMapServiceOptions {
  sessions: Map<string, ChangeMapSession>;
  narrator?: ChangeMapNarrator | null;
  onNarrationSettled?: (sessionId: string) => void;
  runGit?: (args: string[], cwd: string) => Promise<string>;
  nowFn?: () => number;
}

interface CachedFileFact<Value> {
  mtimeMs: number;
  size: number;
  value: Value;
}

interface SiblingScopes {
  expiresAt: number;
  scopes: { commonDir: string; changedPaths: string[] }[];
}

interface MemoizedRepoFacts {
  memoKey: string;
  repoFacts: RepoChangeMap;
}

interface QueuedAssembly {
  mayStartNarration: boolean;
  promise: Promise<ChangeMap>;
}

function runGitAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES }, (_error: unknown, stdout: unknown) => {
      resolve(stdout != null ? String(stdout) : '');
    });
  });
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

function createFileFactCache<Value>(derive: (text: string) => Value, oversizedValue: Value | null) {
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
    base: scope.base,
    files: [],
    subsystems: [],
    coChangeGaps: [],
    hotspots: [],
    blastRadius: [],
    untestedFiles: [],
    collisions: [],
    error: null,
  };
}

function changedFilesOf(scope: ChangeScope) {
  return mergeChangedFiles(
    parseNameStatus({ repoName: scope.name, nameStatusText: scope.committedNameStatus, isCommitted: true }),
    parseNameStatus({ repoName: scope.name, nameStatusText: scope.uncommittedNameStatus, isCommitted: false }),
  );
}

export function createChangeMapService({
  sessions,
  narrator = null,
  onNarrationSettled = () => {},
  runGit = runGitAsync,
  nowFn = Date.now,
}: ChangeMapServiceOptions) {
  const specifierCache = createFileFactCache(extractImportSpecifiers, []);
  const agentsTitleCache = createFileFactCache(readAgentsTitle, null);
  const commonDirByRoot = new Map<string, string>();
  const commitsByLogKey = new Map<string, CommitFiles[]>();
  const siblingScopesById = new Map<string, SiblingScopes>();
  const repoFactsByRoot = new Map<string, MemoizedRepoFacts>();
  const runningBySessionId = new Map<string, Promise<ChangeMap>>();
  const queuedBySessionId = new Map<string, QueuedAssembly>();

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
    const scopes = await sibling.getChangeScopes().catch(() => []);
    const summarized = await Promise.all(scopes.map(async (scope) => ({
      commonDir: await commonDirFor(scope.root),
      changedPaths: changedFilesOf(scope).map((file) => file.path),
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
    const otherSessions: { id: string; name: string; changedPaths: string[] }[] = [];
    for (const sibling of sessions.values()) {
      if (sibling.id === selfId) continue;
      const matching = (await siblingScopesOf(sibling)).filter((scope) => scope.commonDir === commonDir);
      const changedPaths = matching.flatMap((scope) => scope.changedPaths);
      if (changedPaths.length > 0) otherSessions.push({ id: sibling.id, name: sibling.name, changedPaths });
    }
    return otherSessions;
  }

  async function repoFactsFor(scope: ChangeScope, files: ChangedFile[], commonDir: string): Promise<RepoChangeMap> {
    const repoName = scope.name;
    const changedPaths = files.map((file) => file.path);
    const repoPathsText = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], scope.root);
    const repoPaths = parseNulSeparatedPaths(repoPathsText);
    const specifiersByPath = await specifierCache.readMany(scope.root, repoPaths.filter(isSourcePath));
    const agentsTitleByPath = await agentsTitleCache.readMany(scope.root, repoPaths.filter(isAgentsDocPath));
    const packageJsonText = await fs.promises.readFile(path.join(scope.root, 'package.json'), 'utf8').catch(() => null);
    const historyTip = scope.base || (await runGit(['rev-parse', 'HEAD'], scope.root)).trim();
    const memoKey = hashText(JSON.stringify([
      scope.name, scope.base, scope.committedNameStatus, scope.uncommittedNameStatus, hashText(repoPathsText),
      specifierCache.generation(), agentsTitleCache.generation(), packageJsonText, historyTip,
    ]));
    const memoized = repoFactsByRoot.get(scope.root);
    if (memoized && memoized.memoKey === memoKey) return memoized.repoFacts;
    const graph = buildImportGraph({ specifiersByPath, importsMap: readImportsMap(packageJsonText) });
    const { blastRadius, untestedFiles } = computeBlastRadius({ repoName, graph, changedPaths: presentPaths(files) });
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
      untestedFiles,
    };
    rememberBounded(repoFactsByRoot, scope.root, { memoKey, repoFacts }, MAX_MEMOIZED_REPO_FACTS);
    return repoFacts;
  }

  async function buildRepoMap(scope: ChangeScope, selfId: string): Promise<RepoChangeMap> {
    const files = changedFilesOf(scope);
    if (files.length === 0) return emptyRepoMap(scope);
    const commonDir = await commonDirFor(scope.root);
    const repoFacts = await repoFactsFor(scope, files, commonDir);
    const otherSessions = await otherSessionsOn(commonDir, selfId);
    const changedPaths = files.map((file) => file.path);
    return { ...repoFacts, collisions: computeCollisions({ repoName: scope.name, changedPaths, otherSessions }) };
  }

  async function buildRepoMapSafely(scope: ChangeScope, selfId: string): Promise<RepoChangeMap> {
    try {
      return await buildRepoMap(scope, selfId);
    } catch (error) {
      return { ...emptyRepoMap(scope), files: changedFilesOf(scope), error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function assemble(session: ChangeMapSession, mayStartNarration: boolean): Promise<ChangeMap> {
    forgetEndedSiblings();
    const scopes = await session.getChangeScopes();
    const repos: RepoChangeMap[] = [];
    for (const scope of scopes) repos.push(await buildRepoMapSafely(scope, session.id));
    const factsOnly: ChangeMap = {
      sessionId: session.id,
      sig: hashText(JSON.stringify(scopes)),
      generatedAt: nowFn(),
      repos,
      narrative: null,
      narratorState: 'disabled',
    };
    const narration = narrator ? narrator.narrationFor(factsOnly, () => onNarrationSettled(session.id), { mayStart: mayStartNarration }) : null;
    return ChangeMap.parse(narration ? { ...factsOnly, ...narration } : factsOnly);
  }

  function startAssembly(session: ChangeMapSession, mayStartNarration: boolean): Promise<ChangeMap> {
    const running = assemble(session, mayStartNarration).finally(() => {
      if (runningBySessionId.get(session.id) === running) runningBySessionId.delete(session.id);
    });
    runningBySessionId.set(session.id, running);
    return running;
  }

  function build(session: ChangeMapSession, { mayStartNarration = true }: ChangeMapBuildOptions = {}): Promise<ChangeMap> {
    const queued = queuedBySessionId.get(session.id);
    if (queued) {
      queued.mayStartNarration ||= mayStartNarration;
      return queued.promise;
    }
    const running = runningBySessionId.get(session.id);
    if (!running) return startAssembly(session, mayStartNarration);
    const followUp: QueuedAssembly = {
      mayStartNarration,
      promise: running.then(ignoreOutcome, ignoreOutcome).then(() => {
        queuedBySessionId.delete(session.id);
        return startAssembly(session, followUp.mayStartNarration);
      }),
    };
    queuedBySessionId.set(session.id, followUp);
    return followUp.promise;
  }

  return { build };
}
