import fsp from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '../../shared/text.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { splicedGraphOf } from '../core/codemap-structure-core.ts';
import type { SymbolGraph, UnjudgedLanguage } from '../core/codemap-structure-core.ts';
import { isTestPath } from '../core/import-graph-core.ts';
import { runCommand, runGit } from '../git/git-exec.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import type { CodemapClient, ScipIndexFile } from './codemap-client.ts';
import { createIndexerProvisioner, indexCommandsOf, indexedLanguagesOf, languageOfPath, sweepStaleFolders, tarCommand } from './scip-indexers.ts';
import type { IndexedTree, IndexerLanguage, IndexerProvisioner } from './scip-indexers.ts';

const TREE_LISTING_MAX_BYTES = 256 * 1024 * 1024;
const INDEXER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const WORK_FOLDER = 'structure-work';
const PROGRAM_CONFIG_PATTERN = /^(?:[tj]sconfig.*\.json|package\.json)$/;
const EXPORT_FROM_PATTERN = /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s/m;
const IMPORT_CLAUSE_PATTERN = /^\s*import\s+(?:type\s+)?([^'";]+?)\s+from\s/gm;
const EXPORT_LIST_PATTERN = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*;?\s*$/gm;
const BINDING_NAME_PATTERN = /[\w$]+(?=\s*(?:,|\}|$))/g;

interface IncrementalBase {
  base: SymbolGraph;
  importersOf: (changedPaths: readonly string[]) => Iterable<string>;
}

interface IndexedLanguage {
  indexes: ScipIndexFile[];
  coversWholeTree: boolean;
}

interface StructureRunnerOptions {
  homeDir: string;
  client: CodemapClient;
  provisioner?: IndexerProvisioner;
}

function lastLineOf(text: string): string {
  return text.trim().split('\n').slice(-1)[0] ?? '';
}

function bindingNamesOf(clauses: Iterable<RegExpMatchArray>): Set<string> {
  return new Set([...clauses].flatMap((clause) => clause[1].match(BINDING_NAME_PATTERN) ?? []));
}

async function reexportsFrom(treeDir: string, repoPath: string): Promise<boolean> {
  const text = await fsp.readFile(path.join(treeDir, repoPath), 'utf8').catch(() => '');
  if (EXPORT_FROM_PATTERN.test(text)) return true;
  const importedNames = bindingNamesOf(text.matchAll(IMPORT_CLAUSE_PATTERN));
  return [...bindingNamesOf(text.matchAll(EXPORT_LIST_PATTERN))].some((exportedName) => importedNames.has(exportedName));
}

async function replacedPathsOf(treeDir: string, changedPaths: readonly string[], importersOf: (changedPaths: readonly string[]) => Iterable<string>): Promise<Set<string> | null> {
  if (changedPaths.some((repoPath) => PROGRAM_CONFIG_PATTERN.test(path.posix.basename(repoPath)) && !isTestPath(repoPath))) return null;
  const replacedPaths = new Set([...changedPaths, ...importersOf(changedPaths)]);
  const pending = [...replacedPaths];
  for (let position = 0; position < pending.length; position++) {
    if (!await reexportsFrom(treeDir, pending[position])) continue;
    for (const importer of importersOf([pending[position]])) {
      if (replacedPaths.has(importer)) continue;
      replacedPaths.add(importer);
      pending.push(importer);
    }
  }
  return replacedPaths;
}

function emptyGraphOf(treeSha: string, unjudgedLanguages: readonly UnjudgedLanguage[]): SymbolGraph {
  return { treeSha, symbols: [], fileOfSymbol: new Int32Array(0), files: [], edgesFrom: new Int32Array(0), edgesTo: new Int32Array(0), outsideEdgesFrom: new Int32Array(0), outsideEdgeTargets: [], unjudgedLanguages };
}

async function exportTree(repoDir: string, treeSha: string, workDir: string): Promise<string> {
  const archivePath = path.join(workDir, 'tree.tar');
  const treeDir = path.join(workDir, 'tree');
  await fsp.mkdir(treeDir);
  const archived = await runGit(['archive', '--format=tar', '-o', archivePath, treeSha], { cwd: repoDir, timeoutMs: CODEMAP_TUNABLES.extractDeadlineMs });
  if (!archived.ok) throw new Error(`git archive of ${treeSha.slice(0, 7)} failed: ${archived.err}`);
  const unpacked = await runCommand(tarCommand(), ['-xf', archivePath, '-C', treeDir], { timeoutMs: CODEMAP_TUNABLES.extractDeadlineMs });
  if (!unpacked.ok) throw new Error(`unpacking the export of ${treeSha.slice(0, 7)} failed: ${unpacked.err}`);
  await fsp.rm(archivePath, { force: true });
  return treeDir;
}

function createStructureRunner({ homeDir, client, provisioner = createIndexerProvisioner(homeDir) }: StructureRunnerOptions) {
  const indexQueue = createSerialQueue();
  const workRoot = path.join(homeDir, WORK_FOLDER);
  const leftoverWorkSwept = sweepStaleFolders(workRoot, CODEMAP_TUNABLES.indexDeadlineMs * 2);

  async function indexLanguage(language: IndexerLanguage, tree: IndexedTree): Promise<IndexedLanguage | { reason: string }> {
    const indexer = await provisioner.ensureIndexer(language);
    if (!indexer.ok) return { reason: indexer.reason };
    const planned = await indexCommandsOf(language, indexer.launch, tree);
    if ('reason' in planned) return planned;
    for (const command of planned.commands) {
      const indexed = await runCommand(command.file, command.args, { cwd: command.cwd, timeoutMs: CODEMAP_TUNABLES.indexDeadlineMs, maxBuffer: INDEXER_OUTPUT_MAX_BYTES, replaceEnv: command.env, preferStderr: true });
      if (indexed.timedOut) return { reason: `its indexer ran past the ${CODEMAP_TUNABLES.indexDeadlineMs} ms deadline` };
      if (!indexed.ok) return { reason: `its indexer failed: ${lastLineOf(indexed.err)}` };
    }
    return { indexes: planned.commands.map((command) => ({ indexPath: command.indexPath, pathPrefix: command.pathPrefix })), coversWholeTree: planned.coversWholeTree };
  }

  async function freshGraphOf(indexes: readonly ScipIndexFile[], treeSha: string, keepsOutsideEdges: boolean): Promise<SymbolGraph> {
    if (indexes.length === 0) return emptyGraphOf(treeSha, []);
    return client.symbolGraph(indexes, treeSha, keepsOutsideEdges);
  }

  async function splicedOntoBase(tree: IndexedTree, treeSha: string, base: SymbolGraph, fresh: SymbolGraph, partialLanguages: ReadonlySet<IndexerLanguage>, replacedPaths: ReadonlySet<string>): Promise<SymbolGraph> {
    const isPartiallyIndexed = (repoPath: string) => {
      const language = languageOfPath(repoPath);
      return language !== null && partialLanguages.has(language);
    };
    const replacedFiles = new Set([...replacedPaths, ...base.files.filter((repoPath) => !isPartiallyIndexed(repoPath))]);
    const spliced = splicedGraphOf(base, fresh, replacedFiles);
    if (spliced.staleOwnerFiles.length === 0) return spliced.graph;
    const staleOwnerPaths = new Set(spliced.staleOwnerFiles);
    const reindexed = await indexLanguage('typescript', { ...tree, partial: { replacedPaths: staleOwnerPaths, basePaths: new Set(spliced.graph.files) } });
    if ('reason' in reindexed) throw new Error(`re-indexing files whose references moved failed: ${reindexed.reason}`);
    return splicedGraphOf(spliced.graph, await freshGraphOf(reindexed.indexes, treeSha, true), staleOwnerPaths).graph;
  }

  async function indexTree(repoDir: string, treeSha: string, languages: readonly IndexerLanguage[], repoPaths: readonly string[], changedPaths: readonly string[] | null, incrementalBase: IncrementalBase | null): Promise<SymbolGraph> {
    await leftoverWorkSwept;
    await fsp.mkdir(workRoot, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(workRoot, 'tree-'));
    try {
      const treeDir = await exportTree(repoDir, treeSha, workDir);
      const replacedPaths = incrementalBase && changedPaths ? await replacedPathsOf(treeDir, changedPaths, incrementalBase.importersOf) : null;
      const incremental = incrementalBase && replacedPaths ? { base: incrementalBase.base, replacedPaths } : null;
      const tree = { treeDir, workDir, repoPaths, isTestPath, partial: incremental ? { replacedPaths: incremental.replacedPaths, basePaths: new Set(incremental.base.files) } : null };
      const unjudgedLanguages: UnjudgedLanguage[] = [];
      const indexes: ScipIndexFile[] = [];
      const judgedLanguages: IndexerLanguage[] = [];
      const partialLanguages = new Set<IndexerLanguage>();
      for (const language of languages) {
        const outcome = await indexLanguage(language, tree).catch((error: unknown) => ({ reason: errorMessage(error) }));
        if ('reason' in outcome) unjudgedLanguages.push({ language, reason: outcome.reason });
        if ('reason' in outcome) continue;
        indexes.push(...outcome.indexes);
        judgedLanguages.push(language);
        if (!outcome.coversWholeTree) partialLanguages.add(language);
      }
      const spliceBase = partialLanguages.size > 0 ? incremental : null;
      if (!spliceBase && indexes.length === 0) return emptyGraphOf(treeSha, unjudgedLanguages);
      const fresh = await freshGraphOf(indexes, treeSha, spliceBase !== null);
      const graph = spliceBase ? await splicedOntoBase(tree, treeSha, spliceBase.base, fresh, partialLanguages, spliceBase.replacedPaths) : fresh;
      const languagesWithSymbols = new Set(Array.from(graph.fileOfSymbol, (fileIndex) => languageOfPath(graph.files[fileIndex])));
      const emptyLanguages = judgedLanguages.filter((language) => !languagesWithSymbols.has(language)).map((language) => ({ language, reason: 'its indexer reported no symbols for its files, so nothing there could be judged' }));
      return { ...graph, unjudgedLanguages: [...unjudgedLanguages, ...emptyLanguages] };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  async function changedPathsOf(repoDir: string, base: SymbolGraph, treeSha: string): Promise<string[] | null> {
    const listed = await runGit(['diff', '--name-only', '--no-renames', '-z', base.treeSha, treeSha], { cwd: repoDir, maxBuffer: TREE_LISTING_MAX_BYTES, trim: false });
    if (!listed.ok) return null;
    return listed.out.split(String.fromCharCode(0)).filter(Boolean);
  }

  async function symbolGraphOf(repoDir: string, treeSha: string, incrementalBase: IncrementalBase | null = null): Promise<SymbolGraph> {
    const listed = await runGit(['ls-tree', '-r', '--name-only', '-z', treeSha], { cwd: repoDir, maxBuffer: TREE_LISTING_MAX_BYTES, trim: false });
    if (!listed.ok) throw new Error(`git ls-tree of ${treeSha.slice(0, 7)} failed: ${listed.err}`);
    const repoPaths = listed.out.split(String.fromCharCode(0)).filter(Boolean);
    const languages = indexedLanguagesOf(repoPaths, isTestPath);
    if (languages.length === 0) return emptyGraphOf(treeSha, []);
    const changedPaths = incrementalBase ? await changedPathsOf(repoDir, incrementalBase.base, treeSha) : null;
    return indexQueue.run(() => indexTree(repoDir, treeSha, languages, repoPaths, changedPaths, incrementalBase));
  }

  return { symbolGraphOf };
}

type StructureRunner = ReturnType<typeof createStructureRunner>;

export { createStructureRunner };
export type { StructureRunner };
