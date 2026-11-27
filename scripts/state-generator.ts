import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_MESSAGE_CLASS,
  COLLECTION_OF,
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
const COLLECTION_SET = new Set<string>(Object.values(COLLECTION_OF));

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

function writeGeneratedModuleAndRatchets(
  repoRoot: string,
  relativePath: string,
  content: string,
  updatedRatchets: StateRatchetData,
): string {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    writeRatchetsToRoot(repoRoot, updatedRatchets);
  } catch (error) {
    fs.rmSync(filePath, { force: true });
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
  const content = renderActionTemplate(actionType);
  const filePath = writeGeneratedModuleAndRatchets(repoRoot, relativePath, content, updatedRatchets);
  return { filePath, content };
}

export function generateStateCollection(rawName: string | undefined, repoRoot = REPO_ROOT): { filePath: string; content: string } {
  const collectionName = validateNewCollectionName(rawName);
  const relativePath = `public/state/collections/${collectionName}.ts`;
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    throw new Error(`Collection module already exists at ${relativePath}.`);
  }
  const updatedRatchets = removeLegacyCollectionFromRatchets(readRatchetsFromRoot(repoRoot), collectionName);
  const content = renderCollectionTemplate(collectionName);
  const filePath = writeGeneratedModuleAndRatchets(repoRoot, relativePath, content, updatedRatchets);
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
