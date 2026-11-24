import fsp from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '../../shared/text.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import type { SymbolGraph, UnjudgedLanguage } from '../core/codemap-structure-core.ts';
import { isTestPath } from '../core/import-graph-core.ts';
import { runCommand, runGit } from '../git/git-exec.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import type { CodemapClient } from './codemap-client.ts';
import { createIndexerProvisioner, indexedLanguagesOf, sweepStaleFolders } from './scip-indexers.ts';
import type { IndexerLanguage, IndexerProvisioner } from './scip-indexers.ts';

const TREE_LISTING_MAX_BYTES = 256 * 1024 * 1024;
const INDEXER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const WORK_FOLDER = 'structure-work';

interface StructureRunnerOptions {
  homeDir: string;
  client: CodemapClient;
  provisioner?: IndexerProvisioner;
}

function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
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

  async function indexLanguage(language: IndexerLanguage, treeDir: string, indexPath: string): Promise<string | null> {
    const indexer = await provisioner.ensureIndexer(language);
    if (!indexer.ok) return indexer.reason;
    const indexed = await runCommand('node', [indexer.launch.entryPath, 'index', '--infer-tsconfig', '--no-progress-bar', '--output', indexPath], { cwd: treeDir, timeoutMs: CODEMAP_TUNABLES.indexDeadlineMs, maxBuffer: INDEXER_OUTPUT_MAX_BYTES, replaceEnv: indexer.launch.env, preferStderr: true });
    if (indexed.timedOut) return `its indexer ran past the ${CODEMAP_TUNABLES.indexDeadlineMs} ms deadline`;
    if (!indexed.ok) return `its indexer failed: ${lastLineOf(indexed.err)}`;
    return null;
  }

  async function indexTree(repoDir: string, treeSha: string, languages: readonly IndexerLanguage[]): Promise<SymbolGraph> {
    await leftoverWorkSwept;
    await fsp.mkdir(workRoot, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(workRoot, 'tree-'));
    try {
      const treeDir = await exportTree(repoDir, treeSha, workDir);
      const unjudgedLanguages: UnjudgedLanguage[] = [];
      const indexPaths: string[] = [];
      for (const language of languages) {
        const indexPath = path.join(workDir, `${language}.scip`);
        const failure = await indexLanguage(language, treeDir, indexPath).catch((error: unknown) => errorMessage(error));
        if (failure === null) indexPaths.push(indexPath);
        if (failure !== null) unjudgedLanguages.push({ language, reason: failure });
      }
      if (indexPaths.length === 0) return emptyGraphOf(treeSha, unjudgedLanguages);
      return { ...(await client.symbolGraph(indexPaths, treeSha)), unjudgedLanguages };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  async function symbolGraphOf(repoDir: string, treeSha: string): Promise<SymbolGraph> {
    const listed = await runGit(['ls-tree', '-r', '--name-only', '-z', treeSha], { cwd: repoDir, maxBuffer: TREE_LISTING_MAX_BYTES, trim: false });
    if (!listed.ok) throw new Error(`git ls-tree of ${treeSha.slice(0, 7)} failed: ${listed.err}`);
    const languages = indexedLanguagesOf(listed.out.split(String.fromCharCode(0)).filter(Boolean), isTestPath);
    if (languages.length === 0) return emptyGraphOf(treeSha, []);
    return indexQueue.run(() => indexTree(repoDir, treeSha, languages));
  }

  return { symbolGraphOf };
}

type StructureRunner = ReturnType<typeof createStructureRunner>;

export { createStructureRunner };
export type { StructureRunner };
