import fs from 'node:fs';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Query, QueryCapture, Tree } from '@vscode/tree-sitter-wasm';

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

const MAX_SPECIFIER_LENGTH = 1024;

function specifierOf(capture: QueryCapture): string[] {
  if (capture.node.endIndex - capture.node.startIndex > MAX_SPECIFIER_LENGTH) return [];
  const specifier = unquoted(capture.node.text);
  if (capture.name === 'specifier') return [specifier];
  if (capture.name === 'relative') return [specifier.startsWith('.') ? specifier : `./${specifier}`];
  return [];
}

const MICROSECONDS_PER_MILLISECOND = 1000;

export function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / MICROSECONDS_PER_MILLISECOND;
}

function importNodesOf(tree: Tree, scanner: GrammarScanner): Node[] {
  const root = tree.rootNode;
  const importNodes = root.descendantsOfType([...scanner.importNodeTypes]).filter((importNode) => importNode !== null);
  return scanner.isTopLevelOnly ? importNodes.filter((importNode) => importNode.parent?.id === root.id) : importNodes;
}

function specifiersOf(importNodes: Node[], importQuery: Query, isPastBudget: () => boolean): string[] | null {
  const specifiers: string[] = [];
  for (const importNode of importNodes) {
    if (isPastBudget()) return null;
    specifiers.push(...importQuery.captures(importNode, { maxStartDepth: 0 }).flatMap(specifierOf));
  }
  return specifiers;
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
  const specifiers = specifiersOf(importNodesOf(tree, scanner), importQuery, isPastBudget);
  tree.delete();
  return specifiers && [...new Set(specifiers.filter(Boolean))];
}
