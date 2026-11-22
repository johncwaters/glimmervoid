import fs from 'node:fs';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser, Query, QueryCapture, Tree } from '@vscode/tree-sitter-wasm';

import type { GrammarScanner } from '../core/import-language-core.ts';
import { expandElixirAlias, expandPhpUseDeclaration, expandRustUseTree, expandScalaImport } from '../core/import-resolvers/use-trees.ts';
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
const MAX_DECLARED_NAMES_PER_FILE = 64;
const DECLARES_CAPTURE = 'declares';
const MAX_ENCLOSING_DEPTH = 256;
const SPECIFIER_EXPANDER_BY_CAPTURE = new Map<string, (capturedText: string) => string[]>([
  ['rust_use_tree', expandRustUseTree],
  ['php_use', expandPhpUseDeclaration],
  ['scala_import', expandScalaImport],
  ['elixir_alias', expandElixirAlias],
]);

interface GrammarImports {
  specifiers: string[];
  declaredNames: string[];
}

interface Declaration {
  importNode: Node;
  name: string;
}

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

function isChainedDeclaration(importNode: Node, root: Node): boolean {
  return importNode.parent?.id === root.id && importNode.childForFieldName('name') !== null && importNode.childForFieldName('body') === null;
}

function qualifiedNamesOf(declarations: readonly Declaration[], root: Node): string[] {
  const nameByNodeId = new Map(declarations.map((declaration) => [declaration.importNode.id, declaration.name]));
  const chainedNames: string[] = [];
  const qualifiedNames: string[] = [];
  let chainName: string | null = null;
  for (const { importNode, name } of declarations) {
    const enclosingNames: string[] = [];
    let ancestor = importNode.parent;
    for (let depth = 0; ancestor && depth < MAX_ENCLOSING_DEPTH; depth++, ancestor = ancestor.parent) {
      const enclosingName = nameByNodeId.get(ancestor.id);
      if (enclosingName) enclosingNames.unshift(enclosingName);
    }
    const qualifiedName = [...chainedNames, ...enclosingNames, name].join('.');
    if (qualifiedName.length > MAX_SPECIFIER_LENGTH) continue;
    if (!isChainedDeclaration(importNode, root)) {
      qualifiedNames.push(qualifiedName);
      continue;
    }
    chainedNames.push(name);
    chainName = qualifiedName;
  }
  return chainName === null ? qualifiedNames : [chainName, ...qualifiedNames];
}

function importsOf(importNodes: Node[], root: Node, importQuery: Query, isPastBudget: () => boolean): GrammarImports | null {
  const specifiers = new Set<string>();
  const declarations: Declaration[] = [];
  for (const importNode of importNodes) {
    if (isPastBudget()) return null;
    for (const capture of importQuery.captures(importNode, { maxStartDepth: 0 })) {
      if (capture.name !== DECLARES_CAPTURE) {
        for (const specifier of specifierOf(capture)) specifiers.add(specifier);
        continue;
      }
      if (declarations.length < MAX_DECLARED_NAMES_PER_FILE && capture.node.endIndex - capture.node.startIndex <= MAX_SPECIFIER_LENGTH) declarations.push({ importNode, name: capture.node.text.replace(/\s+/g, '') });
    }
    if (specifiers.size >= MAX_SPECIFIERS_PER_FILE) break;
  }
  return { specifiers: [...specifiers].slice(0, MAX_SPECIFIERS_PER_FILE), declaredNames: qualifiedNamesOf(declarations, root) };
}

function textThroughLastMatch(sourceText: string, pattern: RegExp): string {
  let importSectionEnd = 0;
  for (const importLine of sourceText.matchAll(new RegExp(pattern))) importSectionEnd = importLine.index + importLine[0].length;
  const closingDirectives = new RegExp(CLOSING_DIRECTIVE_LINES);
  closingDirectives.lastIndex = importSectionEnd;
  return sourceText.slice(0, importSectionEnd + (closingDirectives.exec(sourceText)?.[0].length ?? 0));
}

function importSectionOf(sourceText: string, importSection: GrammarScanner['importSection']): string {
  if (!importSection) return sourceText;
  if (importSection.kind === 'throughLastMatch') return textThroughLastMatch(sourceText, importSection.pattern);
  return Array.from(sourceText.matchAll(new RegExp(importSection.pattern)), (match) => match[1] ?? '').filter(Boolean).join('\n');
}

export async function scanGrammarImports(scanner: GrammarScanner, sourceText: string, budgetMs: number): Promise<GrammarImports | null> {
  const { parser, importQuery } = await grammarFor(scanner);
  const startedAt = threadCpuMs();
  const isPastBudget = () => threadCpuMs() - startedAt > budgetMs;
  const importSection = importSectionOf(sourceText, scanner.importSection);
  if (isPastBudget()) return null;
  const tree = parser.parse(importSection, null, { progressCallback: isPastBudget });
  if (!tree) {
    parser.reset();
    return null;
  }
  const imports = importsOf(importNodesOf(tree, scanner), tree.rootNode, importQuery, isPastBudget);
  tree.delete();
  return imports && { specifiers: [...new Set(imports.specifiers.filter(Boolean))], declaredNames: [...new Set(imports.declaredNames.filter(Boolean))] };
}
