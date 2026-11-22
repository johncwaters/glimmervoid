import fs from 'node:fs';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Query, Tree } from '@vscode/tree-sitter-wasm';

import type { GrammarScanner } from '../core/import-language-core.ts';
import { grammarWasmPath, treeSitterRuntimeWasmPath } from '../runtime-paths.ts';

interface LoadedGrammar {
  parser: Parser;
  importQuery: Query;
}

let runtimeReady: Promise<void> | null = null;
const loadedGrammarByName = new Map<string, Promise<LoadedGrammar>>();

function initRuntime(): Promise<void> {
  runtimeReady ??= (async () => {
    const runtimeWasmPath = treeSitterRuntimeWasmPath();
    if (!runtimeWasmPath) throw new Error('the tree-sitter runtime (@vscode/tree-sitter-wasm) is not installed');
    await treeSitter.Parser.init({ locateFile: () => runtimeWasmPath });
  })();
  return runtimeReady;
}

async function loadGrammar(scanner: GrammarScanner): Promise<LoadedGrammar> {
  await initRuntime();
  const wasmPath = grammarWasmPath(scanner.grammar);
  if (!wasmPath) throw new Error(`the ${scanner.grammar} grammar (tree-sitter-wasms) is not installed`);
  const language = await treeSitter.Language.load(new Uint8Array(await fs.promises.readFile(wasmPath)));
  const parser = new treeSitter.Parser();
  parser.setLanguage(language);
  return { parser, importQuery: new treeSitter.Query(language, scanner.importQuery) };
}

function grammarFor(scanner: GrammarScanner): Promise<LoadedGrammar> {
  const loaded = loadedGrammarByName.get(scanner.grammar) ?? loadGrammar(scanner);
  loadedGrammarByName.set(scanner.grammar, loaded);
  return loaded;
}

function unquoted(literal: string): string {
  return literal.replace(/^["'`]|["'`]$/g, '');
}

const NODES_PER_BUDGET_CHECK = 1024;
const MICROSECONDS_PER_MILLISECOND = 1000;

export function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / MICROSECONDS_PER_MILLISECOND;
}

function importNodesOf(tree: Tree, scanner: GrammarScanner, isPastBudget: () => boolean): Node[] | null {
  const cursor = tree.walk();
  const importNodes: Node[] = [];
  let depth = 0;
  for (let visitedNodes = 1; ; visitedNodes++) {
    if (visitedNodes % NODES_PER_BUDGET_CHECK === 0 && isPastBudget()) {
      cursor.delete();
      return null;
    }
    const isImportNode = scanner.importNodeTypes.includes(cursor.nodeType);
    if (isImportNode) importNodes.push(cursor.currentNode);
    if (!isImportNode && depth < scanner.maxImportDepth && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    while (!cursor.gotoNextSibling()) {
      if (depth === 0) {
        cursor.delete();
        return importNodes;
      }
      cursor.gotoParent();
      depth--;
    }
  }
}

export async function scanGrammarImports(scanner: GrammarScanner, sourceText: string, budgetMs: number): Promise<string[] | null> {
  const { parser, importQuery } = await grammarFor(scanner);
  const startedAt = threadCpuMs();
  const isPastBudget = () => threadCpuMs() - startedAt > budgetMs;
  const tree = parser.parse(sourceText, null, { progressCallback: isPastBudget });
  if (!tree) {
    parser.reset();
    return null;
  }
  const importNodes = importNodesOf(tree, scanner, isPastBudget);
  const specifiers = (importNodes ?? []).flatMap((importNode) => importQuery.captures(importNode).map((capture) => unquoted(capture.node.text)));
  tree.delete();
  if (!importNodes) return null;
  return [...new Set(specifiers.filter(Boolean))];
}
