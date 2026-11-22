import fs from 'node:fs';
import path from 'node:path';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node } from '@vscode/tree-sitter-wasm';
import { grammarWasmPath, treeSitterRuntimeWasmPath } from '../server/runtime-paths.ts';

const USAGE = 'usage: node harness/code-shape.ts <dir> [--json <out.json>] [--compare <old.json>]';
const FUNCTION_NODE_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'arrow_function', 'method_definition']);
const LONGEST_SHOWN_PER_FILE = 3;
const LONGEST_SHOWN_OVERALL = 10;

interface FunctionShape {
  name: string;
  lines: number;
}

interface FileShape {
  path: string;
  lines: number;
  functions: number;
  longest: FunctionShape[];
  moduleMutables: number;
}

interface DirectoryShape {
  directory: string;
  totalLines: number;
  totalFunctions: number;
  files: FileShape[];
  longestOverall: (FunctionShape & { path: string })[];
}

function optionValue(argumentList: readonly string[], flag: string): string | null {
  const flagIndex = argumentList.indexOf(flag);
  return flagIndex === -1 ? null : argumentList[flagIndex + 1] ?? null;
}

async function createTypeScriptParser(): Promise<treeSitter.Parser> {
  const runtimeWasmPath = treeSitterRuntimeWasmPath();
  const grammarPath = grammarWasmPath('typescript');
  if (!runtimeWasmPath || !grammarPath) throw new Error('the tree-sitter runtime or its TypeScript grammar is not installed');
  await treeSitter.Parser.init({ locateFile: () => runtimeWasmPath });
  const language = await treeSitter.Language.load(new Uint8Array(fs.readFileSync(grammarPath)));
  const parser = new treeSitter.Parser();
  parser.setLanguage(language);
  return parser;
}

function functionNameOf(functionNode: Node): string {
  const ownName = functionNode.childForFieldName('name')?.text;
  if (ownName) return ownName;
  const holder = functionNode.parent;
  const holderName = holder?.childForFieldName('name')?.text ?? holder?.childForFieldName('key')?.text ?? holder?.childForFieldName('left')?.text;
  return holderName ?? `anonymous@${functionNode.startPosition.row + 1}`;
}

function functionsOf(rootNode: Node): FunctionShape[] {
  const functions: FunctionShape[] = [];
  const pendingNodes: Node[] = [rootNode];
  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop();
    if (!node) continue;
    if (FUNCTION_NODE_TYPES.has(node.type)) functions.push({ name: functionNameOf(node), lines: node.endPosition.row - node.startPosition.row + 1 });
    pendingNodes.push(...node.namedChildren.filter((child): child is Node => child !== null));
  }
  return functions;
}

const MUTABLE_COLLECTION_CONSTRUCTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const READONLY_COLLECTION_TYPES = new Set(['ReadonlyMap', 'ReadonlySet']);

function isMutableCollectionInitializer(valueNode: Node | null): boolean {
  if (valueNode?.type !== 'new_expression') return false;
  const constructorName = valueNode.childForFieldName('constructor')?.text ?? '';
  return MUTABLE_COLLECTION_CONSTRUCTORS.has(constructorName);
}

function isReadonlyAnnotated(declarator: Node): boolean {
  const typeText = declarator.childForFieldName('type')?.text ?? '';
  return [...READONLY_COLLECTION_TYPES].some((typeName) => typeText.includes(typeName));
}

function isModuleMutable(statement: Node): boolean {
  const declaration = statement.type === 'export_statement' ? statement.namedChildren[0] : statement;
  if (declaration?.type !== 'lexical_declaration') return false;
  if (declaration.text.startsWith('let ')) return true;
  return declaration.namedChildren.some(
    (child) => child !== null && child.type === 'variable_declarator' && !isReadonlyAnnotated(child) && isMutableCollectionInitializer(child.childForFieldName('value')),
  );
}

function parsedFileShapeOf(parser: treeSitter.Parser, filePath: string, directory: string): { file: FileShape; allFunctions: FunctionShape[] } {
  const source = fs.readFileSync(filePath, 'utf8');
  const tree = parser.parse(source);
  if (!tree) throw new Error(`could not parse ${filePath}`);
  const allFunctions = functionsOf(tree.rootNode).sort((first, second) => second.lines - first.lines);
  const moduleMutables = tree.rootNode.namedChildren.filter((statement): statement is Node => statement !== null && isModuleMutable(statement)).length;
  tree.delete();
  const file: FileShape = {
    path: path.relative(directory, filePath),
    lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    functions: allFunctions.length,
    longest: allFunctions.slice(0, LONGEST_SHOWN_PER_FILE),
    moduleMutables,
  };
  return { file, allFunctions };
}

function sourceFilesOf(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => path.join(directory, entry))
    .sort();
}

async function directoryShapeOf(directory: string): Promise<DirectoryShape> {
  const parser = await createTypeScriptParser();
  const parsed = sourceFilesOf(directory).map((filePath) => parsedFileShapeOf(parser, filePath, directory));
  const files = parsed.map((entry) => entry.file);
  const longestOverall = parsed.flatMap((entry) => entry.allFunctions.map((shape) => ({ ...shape, path: entry.file.path })))
    .sort((first, second) => second.lines - first.lines)
    .slice(0, LONGEST_SHOWN_OVERALL);
  return {
    directory,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalFunctions: files.reduce((sum, file) => sum + file.functions, 0),
    files,
    longestOverall,
  };
}

function signedText(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function deltaText(current: number, previous: number | undefined): string {
  if (previous === undefined) return 'new';
  return signedText(current - previous);
}

function printShape(shape: DirectoryShape, previous: DirectoryShape | null): void {
  const previousByPath = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  const rows = shape.files.map((file) => {
    const previousFile = previousByPath.get(file.path);
    const longest = file.longest[0];
    const comparison = previous === null ? '' : ` (${deltaText(file.lines, previousFile?.lines)})`;
    return `${file.path.padEnd(28)} ${String(file.lines).padStart(5)}${comparison.padEnd(previous === null ? 0 : 8)} fns ${String(file.functions).padStart(3)}  mutables ${String(file.moduleMutables).padStart(2)}  longest ${longest ? `${longest.name} ${longest.lines}` : '-'}`;
  });
  const goneFiles = previous?.files.filter((file) => !shape.files.some((current) => current.path === file.path)).map((file) => `${file.path.padEnd(28)} gone (-${file.lines})`) ?? [];
  console.log([...rows, ...goneFiles].join('\n'));
  const totalComparison = previous === null ? '' : ` (${signedText(shape.totalLines - previous.totalLines)})`;
  console.log(`\ntotal ${shape.totalLines} lines${totalComparison}, ${shape.totalFunctions} functions`);
  console.log(`longest functions: ${shape.longestOverall.map((shape) => `${shape.path}:${shape.name} ${shape.lines}`).join(', ')}`);
  if (previous !== null) console.log(`longest before:    ${previous.longestOverall.map((shape) => `${shape.path}:${shape.name} ${shape.lines}`).join(', ')}`);
}

async function main(): Promise<void> {
  const argumentList = process.argv.slice(2);
  const directory = argumentList[0];
  if (!directory || directory.startsWith('--')) {
    console.error(USAGE);
    process.exit(2);
  }
  const shape = await directoryShapeOf(path.resolve(directory));
  const comparePath = optionValue(argumentList, '--compare');
  const previous: DirectoryShape | null = comparePath === null ? null : JSON.parse(fs.readFileSync(comparePath, 'utf8'));
  printShape(shape, previous);
  const jsonPath = optionValue(argumentList, '--json');
  if (jsonPath !== null) fs.writeFileSync(jsonPath, `${JSON.stringify(shape, null, 2)}\n`);
}

await main();
