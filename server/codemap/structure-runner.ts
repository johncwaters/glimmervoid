import fsp from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '../../shared/text.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
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

interface StructureRunnerOptions {
  homeDir: string;
  client: CodemapClient;
  provisioner?: IndexerProvisioner;
}

function lastLineOf(text: string): string {
  return text.trim().split('\n').slice(-1)[0] ?? '';
}

function emptyGraphOf(treeSha: string, unjudgedLanguages: readonly UnjudgedLanguage[]): SymbolGraph {
  return { treeSha, symbols: [], fileOfSymbol: new Int32Array(0), files: [], edgesFrom: new Int32Array(0), edgesTo: new Int32Array(0), unjudgedLanguages };
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

  async function indexLanguage(language: IndexerLanguage, tree: IndexedTree): Promise<{ indexes: ScipIndexFile[] } | { reason: string }> {
    const indexer = await provisioner.ensureIndexer(language);
    if (!indexer.ok) return { reason: indexer.reason };
    const commands = await indexCommandsOf(language, indexer.launch, tree);
    if ('reason' in commands) return commands;
    for (const command of commands) {
      const indexed = await runCommand(command.file, command.args, { cwd: command.cwd, timeoutMs: CODEMAP_TUNABLES.indexDeadlineMs, maxBuffer: INDEXER_OUTPUT_MAX_BYTES, replaceEnv: command.env, preferStderr: true });
      if (indexed.timedOut) return { reason: `its indexer ran past the ${CODEMAP_TUNABLES.indexDeadlineMs} ms deadline` };
      if (!indexed.ok) return { reason: `its indexer failed: ${lastLineOf(indexed.err)}` };
    }
    return { indexes: commands.map((command) => ({ indexPath: command.indexPath, pathPrefix: command.pathPrefix })) };
  }

  async function indexTree(repoDir: string, treeSha: string, languages: readonly IndexerLanguage[], repoPaths: readonly string[]): Promise<SymbolGraph> {
    await leftoverWorkSwept;
    await fsp.mkdir(workRoot, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(workRoot, 'tree-'));
    try {
      const tree = { treeDir: await exportTree(repoDir, treeSha, workDir), workDir, repoPaths, isTestPath };
      const unjudgedLanguages: UnjudgedLanguage[] = [];
      const indexes: ScipIndexFile[] = [];
      const judgedLanguages: IndexerLanguage[] = [];
      for (const language of languages) {
        const outcome = await indexLanguage(language, tree).catch((error: unknown) => ({ reason: errorMessage(error) }));
        if ('reason' in outcome) unjudgedLanguages.push({ language, reason: outcome.reason });
        if ('reason' in outcome) continue;
        indexes.push(...outcome.indexes);
        judgedLanguages.push(language);
      }
      if (indexes.length === 0) return emptyGraphOf(treeSha, unjudgedLanguages);
      const graph = await client.symbolGraph(indexes, treeSha);
      const languagesWithSymbols = new Set(Array.from(graph.fileOfSymbol, (fileIndex) => languageOfPath(graph.files[fileIndex])));
      const emptyLanguages = judgedLanguages.filter((language) => !languagesWithSymbols.has(language)).map((language) => ({ language, reason: 'its indexer reported no symbols for its files, so nothing there could be judged' }));
      return { ...graph, unjudgedLanguages: [...unjudgedLanguages, ...emptyLanguages] };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  async function symbolGraphOf(repoDir: string, treeSha: string): Promise<SymbolGraph> {
    const listed = await runGit(['ls-tree', '-r', '--name-only', '-z', treeSha], { cwd: repoDir, maxBuffer: TREE_LISTING_MAX_BYTES, trim: false });
    if (!listed.ok) throw new Error(`git ls-tree of ${treeSha.slice(0, 7)} failed: ${listed.err}`);
    const repoPaths = listed.out.split(String.fromCharCode(0)).filter(Boolean);
    const languages = indexedLanguagesOf(repoPaths, isTestPath);
    if (languages.length === 0) return emptyGraphOf(treeSha, []);
    return indexQueue.run(() => indexTree(repoDir, treeSha, languages, repoPaths));
  }

  return { symbolGraphOf };
}

type StructureRunner = ReturnType<typeof createStructureRunner>;

export { createStructureRunner };
export type { StructureRunner };
