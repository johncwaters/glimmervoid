import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_MESSAGE_CLASS,
  wireCollectionNames,
} from '../shared/contracts/control/message-classes.ts';
import type { CollectionName } from '../shared/contracts/control/message-classes.ts';
import {
  STATE_RATCHETS_RELATIVE_PATH,
  formatStateRatchetData,
} from './state-inventory.ts';
import type { StateRatchetData } from './state-inventory.ts';

type MutatingClientMessageType = {
  [Type in keyof typeof CLIENT_MESSAGE_CLASS]: (typeof CLIENT_MESSAGE_CLASS)[Type] extends 'mutating' ? Type : never;
}[keyof typeof CLIENT_MESSAGE_CLASS];

const REPO_ROOT = path.join(import.meta.dirname, '..');
const COLLECTION_SET = new Set<string>(wireCollectionNames());
export const CONTINUITY_CASES_RELATIVE_PATH = 'harness/browser/continuity-cases.ts';
const ACTION_CASES_HEADER = 'export const ACTION_CONTINUITY_CASES: readonly ActionContinuityCase[] = [';
const COLLECTION_CASES_HEADER = 'export const COLLECTION_CONTINUITY_CASES: readonly CollectionContinuityCase[] = [';

function toPascalCase(kebabName: string): string {
  return kebabName
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0].toUpperCase()}${segment.slice(1)}`)
    .join('');
}

function toCamelCase(kebabName: string): string {
  const pascal = toPascalCase(kebabName);
  if (pascal.length === 0) return '';
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`;
}

export function validateNewActionType(rawType: string | undefined): MutatingClientMessageType {
  const candidate = rawType?.trim();
  if (!candidate) {
    throw new Error('Missing client message type. Usage: npm run state:new-action -- <client-type>');
  }
  if (!Object.hasOwn(CLIENT_MESSAGE_CLASS, candidate)) {
    throw new Error(`Unknown client message type "${candidate}". Classify it in shared/contracts/control/message-classes.ts CLIENT_MESSAGE_CLASS first.`);
  }
  const messageClass = CLIENT_MESSAGE_CLASS[candidate as keyof typeof CLIENT_MESSAGE_CLASS];
  if (messageClass !== 'mutating') {
    throw new Error(`Client message type "${candidate}" is classified as "${messageClass}", not "mutating".`);
  }
  return candidate as MutatingClientMessageType;
}

export function validateNewCollectionName(rawName: string | undefined): CollectionName {
  const candidate = rawName?.trim();
  if (!candidate) {
    throw new Error('Missing collection name. Usage: npm run state:new-collection -- <name>');
  }
  if (!COLLECTION_SET.has(candidate)) {
    throw new Error(`Unknown collection "${candidate}". Classify a server message for it in shared/contracts/control/message-classes.ts COLLECTION_OF first.`);
  }
  return candidate as CollectionName;
}

export function renderActionTemplate(type: MutatingClientMessageType): string {
  const inputTypeName = `${toPascalCase(type)}Input`;
  const bindingName = `${toCamelCase(type)}Action`;
  return [
    "import { defineAction } from '../define-action.ts';",
    '',
    `type ${inputTypeName} = Record<string, unknown>;`,
    '',
    `const ${bindingName} = defineAction<${inputTypeName}>({`,
    `  type: '${type}',`,
    `  rollbackNotice: 'Could not complete ${type}. Try again.',`,
    '});',
    '',
    `export default ${bindingName};`,
    '',
  ].join('\n');
}

export function renderCollectionTemplate(name: CollectionName): string {
  const stateTypeName = `${toPascalCase(name)}CollectionState`;
  const bindingName = `${toCamelCase(name)}Collection`;
  return [
    "import { defineCollection } from '../define-collection.ts';",
    '',
    `interface ${stateTypeName} {`,
    '  byId: Record<string, unknown>;',
    '}',
    '',
    `const INITIAL_STATE: ${stateTypeName} = {`,
    '  byId: {},',
    '};',
    '',
    `const ${bindingName} = defineCollection<${stateTypeName}>({`,
    `  name: '${name}',`,
    "  key: 'id',",
    '  initial: INITIAL_STATE,',
    '  apply() {},',
    '});',
    '',
    `export default ${bindingName};`,
    '',
  ].join('\n');
}

export function renderActionStubContinuityCase(type: MutatingClientMessageType): string {
  return [
    '  {',
    `    name: '${type}',`,
    "    checks: ['C1', 'C2', 'C5'],",
    '    stub: true,',
    '    async prepare() {',
    `      throw new Error('Stub continuity case "${type}" is not implemented yet.');`,
    '    },',
    '  },',
  ].join('\n');
}

export function renderCollectionStubContinuityCase(name: CollectionName): string {
  return [
    '  {',
    `    name: '${name}',`,
    "    checks: ['C3', 'C4'],",
    '    stub: true,',
    '    async prepare() {',
    `      throw new Error('Stub continuity case "${name}" is not implemented yet.');`,
    '    },',
    '  },',
  ].join('\n');
}

function skipQuotedOrComment(source: string, index: number): number {
  const current = source[index];
  const next = source[index + 1];
  if (current === '/' && next === '/') {
    const newlineIndex = source.indexOf('\n', index + 2);
    return newlineIndex === -1 ? source.length : newlineIndex + 1;
  }
  if (current === '/' && next === '*') {
    const closeIndex = source.indexOf('*/', index + 2);
    return closeIndex === -1 ? source.length : closeIndex + 2;
  }
  if (current !== '\'' && current !== '"' && current !== '`') return -1;
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === current) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function findMatchingArrayClose(source: string, openBracketIndex: number): number {
  let depth = 0;
  let cursor = openBracketIndex;
  while (cursor < source.length) {
    const skipped = skipQuotedOrComment(source, cursor);
    if (skipped !== -1) {
      cursor = skipped;
      continue;
    }
    const character = source[cursor];
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function extractTopLevelArrayElements(
  source: string,
  openBracketIndex: number,
  closeBracketIndex: number,
): Array<{ start: number; text: string }> {
  const elements: Array<{ start: number; text: string }> = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let elementStart = openBracketIndex + 1;
  let cursor = openBracketIndex + 1;

  const pushSlice = (endIndex: number): void => {
    const rawSlice = source.slice(elementStart, endIndex);
    const trimmed = rawSlice.trim();
    if (trimmed.length === 0) return;
    const leadingWhitespace = rawSlice.indexOf(trimmed[0]);
    elements.push({ start: elementStart + leadingWhitespace, text: trimmed });
  };

  while (cursor < closeBracketIndex) {
    const skipped = skipQuotedOrComment(source, cursor);
    if (skipped !== -1) {
      cursor = skipped;
      continue;
    }
    const character = source[cursor];
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth -= 1;
    if (character === '[') bracketDepth += 1;
    if (character === ']') bracketDepth -= 1;
    if (character === '(') parenDepth += 1;
    if (character === ')') parenDepth -= 1;
    if (character === ',' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      pushSlice(cursor);
      elementStart = cursor + 1;
    }
    cursor += 1;
  }
  pushSlice(closeBracketIndex);
  return elements;
}

function resolveCaseElementName(elementText: string, sourceBeforeArray: string): string | null {
  const inlineMatch = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(elementText);
  if (inlineMatch?.[1]) return inlineMatch[1];
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(elementText)) return null;
  const bindingPattern = new RegExp(
    `\\b(?:const|let|var)\\s+${elementText}\\b[^=]*=[\\s\\S]*?\\bname\\s*:\\s*['"]([^'"]+)['"]`,
  );
  const bindingMatch = bindingPattern.exec(sourceBeforeArray);
  return bindingMatch?.[1] ?? null;
}

function lineStartOffset(source: string, index: number): number {
  const previousNewline = source.lastIndexOf('\n', index - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

export function insertContinuityCaseStub(
  source: string,
  kind: 'action' | 'collection',
  name: string,
  stubBlock: string,
): string {
  const header = kind === 'action' ? ACTION_CASES_HEADER : COLLECTION_CASES_HEADER;
  const headerIndex = source.indexOf(header);
  if (headerIndex === -1) {
    throw new Error(`Invalid continuity cases file at ${CONTINUITY_CASES_RELATIVE_PATH}: missing "${header}".`);
  }
  const openBracketIndex = headerIndex + header.length - 1;
  const closeBracketIndex = findMatchingArrayClose(source, openBracketIndex);
  if (closeBracketIndex === -1) {
    throw new Error(`Invalid continuity cases file at ${CONTINUITY_CASES_RELATIVE_PATH}: missing closing "];" for ${kind} cases.`);
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const normalizedStub = stubBlock.replace(/\r?\n/g, eol);
  const sourceBeforeArray = source.slice(0, headerIndex);
  const elements = extractTopLevelArrayElements(source, openBracketIndex, closeBracketIndex);

  let insertionOffset = lineStartOffset(source, closeBracketIndex);
  let hasChosenInsertionOffset = false;
  for (const element of elements) {
    const existingName = resolveCaseElementName(element.text, sourceBeforeArray);
    if (existingName === name) {
      throw new Error(`Continuity case "${name}" already exists in ${CONTINUITY_CASES_RELATIVE_PATH}.`);
    }
    if (!hasChosenInsertionOffset && existingName !== null && existingName > name) {
      insertionOffset = lineStartOffset(source, element.start);
      hasChosenInsertionOffset = true;
    }
  }

  return `${source.slice(0, insertionOffset)}${normalizedStub}${eol}${source.slice(insertionOffset)}`;
}

export function removeLegacyActionFromRatchets(ratchets: StateRatchetData, type: string): StateRatchetData {
  return {
    ...ratchets,
    legacyMutatingActions: ratchets.legacyMutatingActions.filter((entry) => entry !== type),
  };
}

export function removeLegacyCollectionFromRatchets(ratchets: StateRatchetData, name: string): StateRatchetData {
  return {
    ...ratchets,
    legacyCollections: ratchets.legacyCollections.filter((entry) => entry !== name),
  };
}

function readRatchetsFromRoot(repoRoot: string): StateRatchetData {
  const ratchetsPath = path.join(repoRoot, STATE_RATCHETS_RELATIVE_PATH);
  const parsed: unknown = JSON.parse(fs.readFileSync(ratchetsPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid ratchet file at ${STATE_RATCHETS_RELATIVE_PATH}: expected a JSON object.`);
  }
  const candidate = parsed as Partial<StateRatchetData>;
  if (!Array.isArray(candidate.legacyMutatingActions) || !Array.isArray(candidate.legacyCollections)) {
    throw new Error(`Invalid ratchet file at ${STATE_RATCHETS_RELATIVE_PATH}: missing legacyMutatingActions or legacyCollections array.`);
  }
  return candidate as StateRatchetData;
}

function writeRatchetsToRoot(repoRoot: string, ratchets: StateRatchetData): void {
  const ratchetsPath = path.join(repoRoot, STATE_RATCHETS_RELATIVE_PATH);
  fs.writeFileSync(ratchetsPath, formatStateRatchetData(ratchets), 'utf8');
}

function readContinuityCasesFromRoot(repoRoot: string): string {
  const casesPath = path.join(repoRoot, CONTINUITY_CASES_RELATIVE_PATH);
  if (!fs.existsSync(casesPath)) {
    throw new Error(`Missing continuity cases file at ${CONTINUITY_CASES_RELATIVE_PATH}.`);
  }
  return fs.readFileSync(casesPath, 'utf8');
}

function writeGeneratedFilesAtomically(
  repoRoot: string,
  relativePath: string,
  content: string,
  updatedRatchets: StateRatchetData,
  updatedContinuityCases: string,
): string {
  const filePath = path.join(repoRoot, relativePath);
  const ratchetsPath = path.join(repoRoot, STATE_RATCHETS_RELATIVE_PATH);
  const casesPath = path.join(repoRoot, CONTINUITY_CASES_RELATIVE_PATH);
  const previousRatchetsRaw = fs.readFileSync(ratchetsPath, 'utf8');
  const previousCasesRaw = fs.readFileSync(casesPath, 'utf8');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    writeRatchetsToRoot(repoRoot, updatedRatchets);
    fs.writeFileSync(casesPath, updatedContinuityCases, 'utf8');
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    fs.writeFileSync(ratchetsPath, previousRatchetsRaw, 'utf8');
    fs.writeFileSync(casesPath, previousCasesRaw, 'utf8');
    throw error;
  }
  return filePath;
}

export function generateStateAction(rawType: string | undefined, repoRoot = REPO_ROOT): { filePath: string; content: string } {
  const actionType = validateNewActionType(rawType);
  const relativePath = `public/state/actions/${actionType}.ts`;
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    throw new Error(`Action module already exists at ${relativePath}.`);
  }
  const updatedRatchets = removeLegacyActionFromRatchets(readRatchetsFromRoot(repoRoot), actionType);
  const updatedContinuityCases = insertContinuityCaseStub(
    readContinuityCasesFromRoot(repoRoot),
    'action',
    actionType,
    renderActionStubContinuityCase(actionType),
  );
  const content = renderActionTemplate(actionType);
  const filePath = writeGeneratedFilesAtomically(
    repoRoot,
    relativePath,
    content,
    updatedRatchets,
    updatedContinuityCases,
  );
  return { filePath, content };
}

export function generateStateCollection(rawName: string | undefined, repoRoot = REPO_ROOT): { filePath: string; content: string } {
  const collectionName = validateNewCollectionName(rawName);
  const relativePath = `public/state/collections/${collectionName}.ts`;
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    throw new Error(`Collection module already exists at ${relativePath}.`);
  }
  const updatedRatchets = removeLegacyCollectionFromRatchets(readRatchetsFromRoot(repoRoot), collectionName);
  const updatedContinuityCases = insertContinuityCaseStub(
    readContinuityCasesFromRoot(repoRoot),
    'collection',
    collectionName,
    renderCollectionStubContinuityCase(collectionName),
  );
  const content = renderCollectionTemplate(collectionName);
  const filePath = writeGeneratedFilesAtomically(
    repoRoot,
    relativePath,
    content,
    updatedRatchets,
    updatedContinuityCases,
  );
  return { filePath, content };
}

function runCli(argv: readonly string[]): void {
  const [subcommand, targetName, ...rest] = argv;
  if (rest.length > 0) {
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (subcommand === 'action') {
    const { filePath } = generateStateAction(targetName);
    process.stdout.write(`Created ${path.relative(REPO_ROOT, filePath)}\n`);
    return;
  }
  if (subcommand === 'collection') {
    const { filePath } = generateStateCollection(targetName);
    process.stdout.write(`Created ${path.relative(REPO_ROOT, filePath)}\n`);
    return;
  }
  throw new Error('Usage: node scripts/state-generator.ts <action|collection> <name>');
}

if (import.meta.main) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
