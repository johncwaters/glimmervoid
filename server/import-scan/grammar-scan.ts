import fs from 'node:fs';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Query, QueryCapture, Tree } from '@vscode/tree-sitter-wasm';

import type { GrammarScanner } from '../core/import-language-core.ts';
import { expandPhpUseDeclaration, expandRustUseTree } from '../core/import-resolvers/use-trees.ts';
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

const CLOSING_DIRECTIVE_LINES = /(?:\r?\n[ \t]*#(?:endif|else|elseif)\b[^\n]*)*/y;
const MAX_SPECIFIER_LENGTH = 1024;
const MAX_SPECIFIERS_PER_FILE = 512;
const SPECIFIER_EXPANDER_BY_CAPTURE = new Map<string, (capturedText: string) => string[]>([
  ['rust_use_tree', expandRustUseTree],
  ['php_use', expandPhpUseDeclaration],
]);

function specifierOf(capture: QueryCapture): string[] {
  const expandSpecifiers = SPECIFIER_EXPANDER_BY_CAPTURE.get(capture.name);
  if (expandSpecifiers) return expandSpecifiers(capture.node.text).filter((specifier) => specifier.length <= MAX_SPECIFIER_LENGTH);
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
    if (specifiers.length >= MAX_SPECIFIERS_PER_FILE) return specifiers.slice(0, MAX_SPECIFIERS_PER_FILE);
  }
  return specifiers;
}

function importSectionOf(sourceText: string, importLinePattern: RegExp | null): string {
  if (!importLinePattern) return sourceText;
  let importSectionEnd = 0;
  for (const importLine of sourceText.matchAll(new RegExp(importLinePattern))) importSectionEnd = importLine.index + importLine[0].length;
  const closingDirectives = new RegExp(CLOSING_DIRECTIVE_LINES);
  closingDirectives.lastIndex = importSectionEnd;
  return sourceText.slice(0, importSectionEnd + (closingDirectives.exec(sourceText)?.[0].length ?? 0));
}

export async function scanGrammarImports(scanner: GrammarScanner, sourceText: string, budgetMs: number): Promise<string[] | null> {
  const { parser, importQuery } = await grammarFor(scanner);
  const startedAt = threadCpuMs();
  const isPastBudget = () => threadCpuMs() - startedAt > budgetMs;
  const tree = parser.parse(importSectionOf(sourceText, scanner.importLinePattern), null, { progressCallback: isPastBudget });
  if (!tree) {
    parser.reset();
    return null;
  }
  const specifiers = specifiersOf(importNodesOf(tree, scanner), importQuery, isPastBudget);
  tree.delete();
  return specifiers && [...new Set(specifiers.filter(Boolean))];
}
