import '../helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { grammarWasmPath, treeSitterRuntimeWasmPath } from '../../server/runtime-paths.ts';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const RATCHETS_RELATIVE_PATH = 'tests/gates/tsx-shape-ratchets.json';
const PUBLIC_TSX_PATTERN = /^public\/.*\.tsx$/;
const NEW_TSX_SHAPE_BUDGET = 25;
const MAX_REPORTED_OFFENDERS = 5;

const DECISION_NODE_TYPES = new Set([
  'if_statement',
  'switch_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
]);

const ARRAY_MUTATOR_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
]);

const TRACKED_FIRST_ARG_PRIMITIVES = new Set(['createEffect', 'createRenderEffect', 'createComputed', 'on']);
const TRACKED_ALL_ARGS_PRIMITIVES = new Set(['createMemo', 'createReaction']);
const EVENT_ATTRIBUTE_PATTERN = /^on([A-Z]|:|[a-z])/;
const EVENT_OR_REF_ATTRIBUTE_PATTERN = /^(ref$|on([A-Z]|:|[a-z]))/;
const CONDITION_BINARY_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>=', '&&', '||']);
const FRAMEWORK_IMPORT_PATTERN = /^(['"])(?:solid-js(?:\/.*)?|@solidjs\/.*)\1$/;
const INLINE_LOGIC_ARG_NODE_TYPES = ['arrow_function', 'function_expression', 'ternary_expression'];

const DOM_OR_HOST_TYPE_PATTERN = /\b(Element|HTMLElement|HTML\w+Element|SVG\w*Element|EventTarget|KeyboardEvent|MouseEvent|PointerEvent|FocusEvent|ToggleEvent|ChatFeed|AbortController)\b/;

interface TrackedTsxFile {
  path: string;
  content: string;
}

interface BranchOwnerCount {
  name: string;
  count: number;
}

interface SignalLogicOwnerReport {
  name: string;
  inlineWrites: number;
  directConditions: number;
}

interface TsxShapeReport {
  hasSyntaxError: boolean;
  score: number;
  stateCount: number;
  branchCount: number;
  inlineSignalWriteCount: number;
  directSignalConditionCount: number;
  stateNames: string[];
  branchOwners: BranchOwnerCount[];
  signalLogicOwners: SignalLogicOwnerReport[];
}

interface SignalDeclaration {
  kind: 'solid' | 'solid-tuple' | 'synced' | 'synced-destructured';
  name: string;
  readIdentifier: string | null;
  writeIdentifier: string | null;
  peekIdentifier: string | null;
  nameNodeId: number;
  declaratorNodeId: number;
  scopeNode: Node;
  topLevelFunctionNodeId: number | null;
}

interface ImportedBindings {
  valueNames: Set<string>;
  namespaceNames: Set<string>;
}

let cachedParserPromise: Promise<Parser> | null = null;

function tsxParser(): Promise<Parser> {
  cachedParserPromise ??= (async () => {
    const runtimeWasmPath = treeSitterRuntimeWasmPath();
    assert.ok(runtimeWasmPath, 'tree-sitter runtime (@vscode/tree-sitter-wasm) must be installed');
    await treeSitter.Parser.init({ locateFile: () => runtimeWasmPath });
    const tsxWasmPath = grammarWasmPath('tsx');
    assert.ok(tsxWasmPath, 'tree-sitter tsx grammar (tree-sitter-wasms) must be installed');
    const language = await treeSitter.Language.load(new Uint8Array(await fs.promises.readFile(tsxWasmPath)));
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return cachedParserPromise;
}

function nonCommentNamedChild(node: Node | null, targetIndex = 0): Node | null {
  if (!node) return null;
  let seen = 0;
  for (let childIndex = 0; childIndex < node.namedChildCount; childIndex += 1) {
    const child = node.namedChild(childIndex);
    if (!child || child.type === 'comment') continue;
    if (seen === targetIndex) return child;
    seen += 1;
  }
  return null;
}

function unwrapExpressionWrappers(exprNode: Node | null): Node | null {
  let current = exprNode;
  while (current) {
    if (
      current.type === 'parenthesized_expression' ||
      current.type === 'as_expression' ||
      current.type === 'satisfies_expression' ||
      current.type === 'non_null_expression'
    ) {
      current = nonCommentNamedChild(current, 0);
      continue;
    }
    return current;
  }
  return null;
}

function terminalCalleeNameOf(callExpression: Node): string {
  const callee = callExpression.childForFieldName('function');
  if (!callee) return '';
  if (callee.type === 'member_expression') {
    return callee.childForFieldName('property')?.text ?? '';
  }
  return callee.text;
}

function isSignalInitializer(node: Node): boolean {
  let ancestor = node.parent;
  while (ancestor && ancestor.type === 'arguments') ancestor = ancestor.parent;
  if (ancestor?.type !== 'call_expression') return false;
  const calleeName = terminalCalleeNameOf(ancestor);
  return calleeName === 'createSignal' || calleeName === 'createSyncedSignal';
}

function constructorTerminalNameOf(newExpression: Node): string {
  const ctor = newExpression.childForFieldName('constructor');
  if (!ctor) return '';
  if (ctor.type === 'member_expression') {
    return ctor.childForFieldName('property')?.text ?? '';
  }
  return ctor.text;
}

function hasDomOrHostTypeArguments(newExpression: Node): boolean {
  const typeArgs = newExpression.childForFieldName('type_arguments');
  if (!typeArgs) return false;
  return DOM_OR_HOST_TYPE_PATTERN.test(typeArgs.text);
}

function isDomOrHostNewExpression(newExpression: Node): boolean {
  const ctorName = constructorTerminalNameOf(newExpression);
  if (DOM_OR_HOST_TYPE_PATTERN.test(ctorName)) return true;
  return hasDomOrHostTypeArguments(newExpression);
}

function collectMutatedArrayNames(rootNode: Node): Set<string> {
  const mutated = new Set<string>();
  for (const callNode of rootNode.descendantsOfType('call_expression')) {
    if (!callNode) continue;
    const callee = callNode.childForFieldName('function');
    if (callee?.type !== 'member_expression') continue;
    const propertyName = callee.childForFieldName('property')?.text ?? '';
    if (!ARRAY_MUTATOR_METHODS.has(propertyName)) continue;
    const targetObject = callee.childForFieldName('object');
    if (targetObject?.type === 'identifier') mutated.add(targetObject.text);
  }
  return mutated;
}

function collectImportedBindings(rootNode: Node): ImportedBindings {
  const valueNames = new Set<string>();
  const namespaceNames = new Set<string>();

  for (const importNode of rootNode.descendantsOfType('import_statement')) {
    if (!importNode) continue;
    if (importNode.text.startsWith('import type ')) continue;
    const sourceText = importNode.childForFieldName('source')?.text ?? '';
    if (FRAMEWORK_IMPORT_PATTERN.test(sourceText)) continue;
    const clause = nonCommentNamedChild(importNode, 0);
    if (clause?.type !== 'import_clause') continue;

    for (let index = 0; index < clause.namedChildCount; index += 1) {
      const part = clause.namedChild(index);
      if (!part || part.type === 'comment') continue;
      if (part.type === 'identifier') {
        valueNames.add(part.text);
        continue;
      }
      if (part.type === 'namespace_import') {
        const alias = nonCommentNamedChild(part, 0);
        if (alias?.type === 'identifier') namespaceNames.add(alias.text);
        continue;
      }
      if (part.type === 'named_imports') {
        for (let specIndex = 0; specIndex < part.namedChildCount; specIndex += 1) {
          const spec = part.namedChild(specIndex);
          if (spec?.type !== 'import_specifier' || spec.text.startsWith('type ')) continue;
          const localNode = spec.childForFieldName('alias') ?? spec.childForFieldName('name');
          if (localNode?.type === 'identifier') valueNames.add(localNode.text);
        }
      }
    }
  }

  return { valueNames, namespaceNames };
}

function isFunctionNode(node: Node): boolean {
  return (
    node.type === 'function_declaration' ||
    node.type === 'function_expression' ||
    node.type === 'arrow_function' ||
    node.type === 'method_definition'
  );
}

function enclosingFunctionOf(node: Node): Node | null {
  let ancestor = node.parent;
  while (ancestor) {
    if (isFunctionNode(ancestor)) return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

function enclosingTopLevelFunctionOf(node: Node, rootNode: Node): Node | null {
  let topLevelFunction: Node | null = null;
  let ancestor = node.parent;
  while (ancestor && ancestor !== rootNode) {
    if (isFunctionNode(ancestor)) topLevelFunction = ancestor;
    ancestor = ancestor.parent;
  }
  return topLevelFunction;
}

function topLevelOwnerNameOf(node: Node, rootNode: Node): string {
  const topLevelFn = enclosingTopLevelFunctionOf(node, rootNode);
  if (!topLevelFn) return '<module>';
  if (topLevelFn.type === 'function_declaration') {
    return topLevelFn.childForFieldName('name')?.text ?? '(anonymous)';
  }
  let ancestor = topLevelFn.parent;
  while (ancestor && ancestor !== rootNode) {
    if (ancestor.type === 'variable_declarator') {
      return ancestor.childForFieldName('name')?.text ?? '(anonymous)';
    }
    ancestor = ancestor.parent;
  }
  return '(default)';
}

function isNodeWithin(innerNode: Node, outerNode: Node): boolean {
  return innerNode.startIndex >= outerNode.startIndex && innerNode.endIndex <= outerNode.endIndex;
}

function isConciseZeroArgGetterFor(readNode: Node, arrowNode: Node): boolean {
  const body = unwrapExpressionWrappers(arrowNode.childForFieldName('body'));
  if (!body || body.type === 'statement_block') return false;
  const parameters = arrowNode.childForFieldName('parameters');
  if (parameters && parameters.namedChildCount > 0) return false;
  if (arrowNode.childForFieldName('parameter')) return false;
  return body.id === readNode.id;
}

function isExposedByTopLevelReturn(readNode: Node, returnStatement: Node, topLevelFunctionNodeId: number): boolean {
  if (enclosingFunctionOf(returnStatement)?.id !== topLevelFunctionNodeId) return false;
  const directFunction = enclosingFunctionOf(readNode);
  if (!directFunction) return false;
  if (directFunction.id === topLevelFunctionNodeId) return true;
  if (directFunction.type !== 'arrow_function') return false;
  if (!isConciseZeroArgGetterFor(readNode, directFunction)) return false;
  return enclosingFunctionOf(directFunction)?.id === topLevelFunctionNodeId;
}

function isReactiveSignalRead(readNode: Node, topLevelFunctionNodeId: number | null): boolean {
  let ancestor = readNode.parent;

  while (ancestor) {
    if (ancestor.type === 'call_expression') {
      const calleeName = terminalCalleeNameOf(ancestor);
      if (calleeName === 'untrack') return false;
      if (TRACKED_ALL_ARGS_PRIMITIVES.has(calleeName)) return true;
      if (TRACKED_FIRST_ARG_PRIMITIVES.has(calleeName)) {
        const firstArg = ancestor.childForFieldName('arguments')?.namedChild(0);
        if (firstArg && isNodeWithin(readNode, firstArg)) return true;
      }
    }

    if (ancestor.type === 'jsx_expression') {
      const parentAttr = ancestor.parent;
      if (parentAttr?.type === 'jsx_attribute') {
        const attrName = parentAttr.namedChild(0)?.text ?? '';
        if (EVENT_OR_REF_ATTRIBUTE_PATTERN.test(attrName)) return false;
      }
      return true;
    }

    if (ancestor.type === 'return_statement' && topLevelFunctionNodeId !== null) {
      if (isExposedByTopLevelReturn(readNode, ancestor, topLevelFunctionNodeId)) return true;
    }

    ancestor = ancestor.parent;
  }

  return false;
}

function extractDestructuredSyncedBindings(objectPattern: Node): {
  readIdentifier: string | null;
  writeIdentifier: string | null;
  peekIdentifier: string | null;
  nameNode: Node;
} {
  let firstIdentifier: Node = objectPattern;
  let readIdentifier: string | null = null;
  let writeIdentifier: string | null = null;
  let peekIdentifier: string | null = null;

  for (let childIndex = 0; childIndex < objectPattern.namedChildCount; childIndex += 1) {
    const child = objectPattern.namedChild(childIndex);
    if (!child) continue;
    if (child.type === 'shorthand_property_identifier_pattern') {
      if (firstIdentifier.id === objectPattern.id) firstIdentifier = child;
      if (child.text === 'read') readIdentifier = 'read';
      if (child.text === 'update') writeIdentifier = 'update';
      if (child.text === 'peek') peekIdentifier = 'peek';
      continue;
    }
    if (child.type === 'pair_pattern') {
      const key = child.childForFieldName('key')?.text ?? '';
      const value = child.childForFieldName('value');
      const target = value?.type === 'assignment_pattern' ? value.childForFieldName('left') : value;
      if (target?.type === 'identifier') {
        if (firstIdentifier.id === objectPattern.id) firstIdentifier = target;
        if (key === 'read') readIdentifier = target.text;
        if (key === 'update') writeIdentifier = target.text;
        if (key === 'peek') peekIdentifier = target.text;
      }
      continue;
    }
    if (child.type === 'object_assignment_pattern') {
      const left = child.childForFieldName('left');
      if (left?.type === 'shorthand_property_identifier_pattern') {
        if (firstIdentifier.id === objectPattern.id) firstIdentifier = left;
        if (left.text === 'read') readIdentifier = 'read';
        if (left.text === 'update') writeIdentifier = 'update';
        if (left.text === 'peek') peekIdentifier = 'peek';
      }
    }
  }

  return { readIdentifier, writeIdentifier, peekIdentifier, nameNode: firstIdentifier };
}

function collectUnrenderedSignals(rootNode: Node): SignalDeclaration[] {
  const signalDeclarations: SignalDeclaration[] = [];

  for (const declarator of rootNode.descendantsOfType('variable_declarator')) {
    if (!declarator) continue;
    const initializer = unwrapExpressionWrappers(declarator.childForFieldName('value'));
    if (initializer?.type !== 'call_expression') continue;
    const calleeName = terminalCalleeNameOf(initializer);
    const scopeNode = enclosingFunctionOf(declarator) ?? rootNode;
    const topLevelFunctionNodeId = enclosingTopLevelFunctionOf(declarator, rootNode)?.id ?? null;
    const nameNode = declarator.childForFieldName('name');
    if (!nameNode) continue;

    if (calleeName === 'createSyncedSignal') {
      if (nameNode.type === 'identifier') {
        signalDeclarations.push({
          kind: 'synced',
          name: nameNode.text,
          readIdentifier: nameNode.text,
          writeIdentifier: nameNode.text,
          peekIdentifier: nameNode.text,
          nameNodeId: nameNode.id,
          declaratorNodeId: declarator.id,
          scopeNode,
          topLevelFunctionNodeId,
        });
        continue;
      }
      if (nameNode.type === 'object_pattern') {
        const extracted = extractDestructuredSyncedBindings(nameNode);
        signalDeclarations.push({
          kind: 'synced-destructured',
          name: extracted.readIdentifier ?? extracted.nameNode.text,
          readIdentifier: extracted.readIdentifier,
          writeIdentifier: extracted.writeIdentifier,
          peekIdentifier: extracted.peekIdentifier,
          nameNodeId: extracted.nameNode.id,
          declaratorNodeId: declarator.id,
          scopeNode,
          topLevelFunctionNodeId,
        });
      }
      continue;
    }

    if (calleeName === 'createSignal') {
      if (nameNode.type === 'identifier') {
        signalDeclarations.push({
          kind: 'solid-tuple',
          name: nameNode.text,
          readIdentifier: nameNode.text,
          writeIdentifier: nameNode.text,
          peekIdentifier: nameNode.text,
          nameNodeId: nameNode.id,
          declaratorNodeId: declarator.id,
          scopeNode,
          topLevelFunctionNodeId,
        });
        continue;
      }
      if (nameNode.type === 'array_pattern') {
        let tupleIndex = 0;
        let firstElement: Node | null = null;
        let secondElement: Node | null = null;
        for (let childIndex = 0; childIndex < nameNode.childCount; childIndex += 1) {
          const child = nameNode.child(childIndex);
          if (!child || child.type === 'comment') continue;
          if (child.text === ',') {
            tupleIndex += 1;
            continue;
          }
          if (!child.isNamed) continue;
          if (tupleIndex === 0 && firstElement === null) firstElement = child;
          if (tupleIndex === 1 && secondElement === null) secondElement = child;
        }
        const getterNode =
          firstElement?.type === 'assignment_pattern' ? firstElement.childForFieldName('left') : firstElement;
        const setterNode =
          secondElement?.type === 'assignment_pattern' ? secondElement.childForFieldName('left') : secondElement;
        if (getterNode?.type === 'identifier') {
          signalDeclarations.push({
            kind: 'solid',
            name: getterNode.text,
            readIdentifier: getterNode.text,
            writeIdentifier: setterNode?.type === 'identifier' ? setterNode.text : null,
            peekIdentifier: getterNode.text,
            nameNodeId: getterNode.id,
            declaratorNodeId: declarator.id,
            scopeNode,
            topLevelFunctionNodeId,
          });
          continue;
        }
        if (setterNode?.type === 'identifier') {
          signalDeclarations.push({
            kind: 'solid',
            name: setterNode.text,
            readIdentifier: null,
            writeIdentifier: setterNode.text,
            peekIdentifier: null,
            nameNodeId: setterNode.id,
            declaratorNodeId: declarator.id,
            scopeNode,
            topLevelFunctionNodeId,
          });
        }
      }
    }
  }

  if (signalDeclarations.length === 0) return [];

  const reactiveSignalDeclaratorIds = new Set<number>();
  const signalsByReadName = new Map<string, SignalDeclaration[]>();
  for (const signal of signalDeclarations) {
    if (signal.readIdentifier === null) continue;
    const group = signalsByReadName.get(signal.readIdentifier) ?? [];
    group.push(signal);
    signalsByReadName.set(signal.readIdentifier, group);
  }

  for (const callNode of rootNode.descendantsOfType('call_expression')) {
    if (!callNode) continue;
    const callee = callNode.childForFieldName('function');
    if (!callee) continue;

    if (callee.type === 'member_expression' && callee.childForFieldName('property')?.text === 'read') {
      const target = callee.childForFieldName('object');
      if (target?.type !== 'identifier') continue;
      for (const signal of signalsByReadName.get(target.text) ?? []) {
        if (signal.kind !== 'synced' || !isNodeWithin(callNode, signal.scopeNode)) continue;
        if (isReactiveSignalRead(callNode, signal.topLevelFunctionNodeId)) {
          reactiveSignalDeclaratorIds.add(signal.declaratorNodeId);
        }
      }
      continue;
    }

    if (callee.type === 'subscript_expression') {
      const target = callee.childForFieldName('object');
      const indexNode = callee.childForFieldName('index');
      if (target?.type !== 'identifier' || indexNode?.text !== '0') continue;
      for (const signal of signalsByReadName.get(target.text) ?? []) {
        if (signal.kind !== 'solid-tuple' || !isNodeWithin(callNode, signal.scopeNode)) continue;
        if (isReactiveSignalRead(callNode, signal.topLevelFunctionNodeId)) {
          reactiveSignalDeclaratorIds.add(signal.declaratorNodeId);
        }
      }
      continue;
    }

    if (callee.type === 'identifier') {
      for (const signal of signalsByReadName.get(callee.text) ?? []) {
        if (
          (signal.kind !== 'solid' && signal.kind !== 'synced-destructured') ||
          !isNodeWithin(callNode, signal.scopeNode)
        ) {
          continue;
        }
        if (isReactiveSignalRead(callNode, signal.topLevelFunctionNodeId)) {
          reactiveSignalDeclaratorIds.add(signal.declaratorNodeId);
        }
      }
    }
  }

  for (const idNode of rootNode.descendantsOfType('identifier')) {
    if (!idNode) continue;
    const candidates = signalsByReadName.get(idNode.text);
    if (!candidates) continue;
    const parentType = idNode.parent?.type;
    if (parentType !== 'arguments' && parentType !== 'jsx_expression') continue;
    for (const signal of candidates) {
      if (
        (signal.kind !== 'solid' && signal.kind !== 'synced-destructured') ||
        idNode.id === signal.nameNodeId
      ) {
        continue;
      }
      if (reactiveSignalDeclaratorIds.has(signal.declaratorNodeId)) continue;
      if (!isNodeWithin(idNode, signal.scopeNode)) continue;
      if (isReactiveSignalRead(idNode, signal.topLevelFunctionNodeId)) {
        reactiveSignalDeclaratorIds.add(signal.declaratorNodeId);
      }
    }
  }

  return signalDeclarations.filter((signal) => !reactiveSignalDeclaratorIds.has(signal.declaratorNodeId));
}

function isImportedCallableReference(node: Node | null, imported: ImportedBindings): boolean {
  const unwrapped = unwrapExpressionWrappers(node);
  if (!unwrapped) return false;
  if (unwrapped.type === 'identifier') {
    return imported.valueNames.has(unwrapped.text);
  }
  if (unwrapped.type === 'member_expression') {
    const objectNode = unwrapped.childForFieldName('object');
    return objectNode?.type === 'identifier' && imported.namespaceNames.has(objectNode.text);
  }
  return false;
}

function isDelegatedCallExpression(callNode: Node, imported: ImportedBindings): boolean {
  if (!isImportedCallableReference(callNode.childForFieldName('function'), imported)) return false;
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return true;
  return argsNode.descendantsOfType(INLINE_LOGIC_ARG_NODE_TYPES).length === 0;
}

function isDelegatedSignalUpdater(argNode: Node | null, imported: ImportedBindings): boolean {
  const unwrapped = unwrapExpressionWrappers(argNode);
  if (!unwrapped) return false;
  if (isImportedCallableReference(unwrapped, imported)) return true;
  if (unwrapped.type === 'call_expression') {
    return isDelegatedCallExpression(unwrapped, imported);
  }
  if (unwrapped.type === 'arrow_function') {
    const body = unwrapExpressionWrappers(unwrapped.childForFieldName('body'));
    if (body?.type === 'call_expression') {
      return isDelegatedCallExpression(body, imported);
    }
  }
  return false;
}

function isDirectConditionRead(callNode: Node, imported: ImportedBindings): boolean {
  let ancestor = callNode.parent;
  while (ancestor) {
    if (ancestor.type === 'arguments') {
      const enclosingCall = ancestor.parent;
      if (
        enclosingCall?.type === 'call_expression' &&
        isImportedCallableReference(enclosingCall.childForFieldName('function'), imported)
      ) {
        return false;
      }
      ancestor = enclosingCall?.parent ?? null;
      continue;
    }
    if (
      ancestor.type === 'parenthesized_expression' ||
      ancestor.type === 'member_expression' ||
      ancestor.type === 'subscript_expression' ||
      ancestor.type === 'as_expression' ||
      ancestor.type === 'satisfies_expression' ||
      ancestor.type === 'non_null_expression'
    ) {
      ancestor = ancestor.parent;
      continue;
    }
    if (ancestor.type === 'unary_expression' && ancestor.firstChild?.text === '!') return true;
    if (ancestor.type === 'binary_expression') {
      const operator = ancestor.childForFieldName('operator')?.text ?? '';
      if (CONDITION_BINARY_OPERATORS.has(operator)) return true;
      ancestor = ancestor.parent;
      continue;
    }
    if (ancestor.type === 'ternary_expression') {
      const condition = ancestor.childForFieldName('condition');
      return condition ? isNodeWithin(callNode, condition) : false;
    }
    if (
      ancestor.type === 'if_statement' ||
      ancestor.type === 'while_statement' ||
      ancestor.type === 'do_statement' ||
      ancestor.type === 'switch_statement'
    ) {
      const condition = ancestor.childForFieldName('condition') ?? ancestor.childForFieldName('value');
      return condition ? isNodeWithin(callNode, condition) : false;
    }
    return false;
  }
  return false;
}

function measureUnrenderedSignalLogic(
  rootNode: Node,
  unrenderedSignals: readonly SignalDeclaration[],
  imported: ImportedBindings,
): { inlineWrites: number; directConditions: number; owners: SignalLogicOwnerReport[] } {
  if (unrenderedSignals.length === 0) {
    return { inlineWrites: 0, directConditions: 0, owners: [] };
  }

  const byOwner = new Map<string, { inlineWrites: number; directConditions: number }>();
  const recordOwner = (node: Node, kind: 'write' | 'condition'): void => {
    const ownerName = topLevelOwnerNameOf(node, rootNode);
    const entry = byOwner.get(ownerName) ?? { inlineWrites: 0, directConditions: 0 };
    if (kind === 'write') entry.inlineWrites += 1;
    if (kind === 'condition') entry.directConditions += 1;
    byOwner.set(ownerName, entry);
  };

  const signalsByWriteName = new Map<string, SignalDeclaration[]>();
  const signalsByReadName = new Map<string, SignalDeclaration[]>();
  for (const signal of unrenderedSignals) {
    if (signal.writeIdentifier !== null) {
      const writeGroup = signalsByWriteName.get(signal.writeIdentifier) ?? [];
      writeGroup.push(signal);
      signalsByWriteName.set(signal.writeIdentifier, writeGroup);
    }
    for (const candidateName of [signal.peekIdentifier, signal.readIdentifier]) {
      if (candidateName === null) continue;
      const readGroup = signalsByReadName.get(candidateName) ?? [];
      if (!readGroup.includes(signal)) readGroup.push(signal);
      signalsByReadName.set(candidateName, readGroup);
    }
  }

  let inlineWrites = 0;
  let directConditions = 0;

  for (const callNode of rootNode.descendantsOfType('call_expression')) {
    if (!callNode) continue;
    const callee = callNode.childForFieldName('function');
    if (!callee) continue;

    if (callee.type === 'member_expression') {
      const target = callee.childForFieldName('object');
      const prop = callee.childForFieldName('property')?.text ?? '';
      if (target?.type !== 'identifier') continue;

      if (prop === 'update') {
        const matched = (signalsByWriteName.get(target.text) ?? []).some(
          (signal) => signal.kind === 'synced' && isNodeWithin(callNode, signal.scopeNode),
        );
        if (
          matched &&
          !isDelegatedSignalUpdater(nonCommentNamedChild(callNode.childForFieldName('arguments'), 0), imported)
        ) {
          inlineWrites += 1;
          recordOwner(callNode, 'write');
        }
        continue;
      }

      if (prop === 'peek' || prop === 'read') {
        const matched = (signalsByReadName.get(target.text) ?? []).some(
          (signal) => signal.kind === 'synced' && isNodeWithin(callNode, signal.scopeNode),
        );
        if (matched && isDirectConditionRead(callNode, imported)) {
          directConditions += 1;
          recordOwner(callNode, 'condition');
        }
      }
      continue;
    }

    if (callee.type === 'subscript_expression') {
      const target = callee.childForFieldName('object');
      const indexText = callee.childForFieldName('index')?.text ?? '';
      if (target?.type !== 'identifier') continue;

      if (indexText === '1') {
        const matched = (signalsByWriteName.get(target.text) ?? []).some(
          (signal) => signal.kind === 'solid-tuple' && isNodeWithin(callNode, signal.scopeNode),
        );
        if (
          matched &&
          !isDelegatedSignalUpdater(nonCommentNamedChild(callNode.childForFieldName('arguments'), 0), imported)
        ) {
          inlineWrites += 1;
          recordOwner(callNode, 'write');
        }
        continue;
      }

      if (indexText === '0') {
        const matched = (signalsByReadName.get(target.text) ?? []).some(
          (signal) => signal.kind === 'solid-tuple' && isNodeWithin(callNode, signal.scopeNode),
        );
        if (matched && isDirectConditionRead(callNode, imported)) {
          directConditions += 1;
          recordOwner(callNode, 'condition');
        }
      }
      continue;
    }

    if (callee.type === 'identifier') {
      const matchedWrite = (signalsByWriteName.get(callee.text) ?? []).some(
        (signal) =>
          (signal.kind === 'solid' || signal.kind === 'synced-destructured') &&
          isNodeWithin(callNode, signal.scopeNode),
      );
      if (
        matchedWrite &&
        !isDelegatedSignalUpdater(nonCommentNamedChild(callNode.childForFieldName('arguments'), 0), imported)
      ) {
        inlineWrites += 1;
        recordOwner(callNode, 'write');
        continue;
      }

      const matchedRead = (signalsByReadName.get(callee.text) ?? []).some(
        (signal) =>
          (signal.kind === 'solid' || signal.kind === 'synced-destructured') &&
          isNodeWithin(callNode, signal.scopeNode),
      );
      if (matchedRead && isDirectConditionRead(callNode, imported)) {
        directConditions += 1;
        recordOwner(callNode, 'condition');
      }
    }
  }

  const owners: SignalLogicOwnerReport[] = [...byOwner.entries()]
    .map(([name, counts]) => ({ name, inlineWrites: counts.inlineWrites, directConditions: counts.directConditions }))
    .sort(
      (left, right) =>
        right.inlineWrites + right.directConditions - (left.inlineWrites + left.directConditions) ||
        left.name.localeCompare(right.name),
    );

  return { inlineWrites, directConditions, owners };
}

function unwrapDiscardedExpression(exprNode: Node | null): Node | null {
  let current = exprNode;
  while (current) {
    if (current.type === 'parenthesized_expression' || current.type === 'await_expression') {
      current = nonCommentNamedChild(current, 0);
      continue;
    }
    if (current.type === 'unary_expression') {
      const operator = current.firstChild?.text ?? '';
      if (operator === 'void' || operator === '!') {
        current = nonCommentNamedChild(current, 0);
        continue;
      }
    }
    return current;
  }
  return null;
}

function countDiscardedExpressionBranches(exprNode: Node | null, onBranch: () => void): void {
  const inner = unwrapDiscardedExpression(exprNode);
  if (!inner) return;

  if (inner.type === 'sequence_expression') {
    const lastElement = inner.namedChild(inner.namedChildCount - 1);
    countDiscardedExpressionBranches(lastElement, onBranch);
    return;
  }

  if (inner.type === 'ternary_expression') {
    onBranch();
    countDiscardedExpressionBranches(inner.childForFieldName('consequence'), onBranch);
    countDiscardedExpressionBranches(inner.childForFieldName('alternative'), onBranch);
    return;
  }

  if (inner.type === 'binary_expression') {
    const operator = inner.childForFieldName('operator')?.text;
    if (operator !== '&&' && operator !== '||') return;
    onBranch();
    countDiscardedExpressionBranches(inner.childForFieldName('left'), onBranch);
    countDiscardedExpressionBranches(inner.childForFieldName('right'), onBranch);
  }
}

interface ConciseArrowBinding {
  bodyNode: Node;
  scopeNode: Node;
  ownerName: string;
}

function collectConciseArrowBindings(rootNode: Node): Map<string, ConciseArrowBinding[]> {
  const bindingsByName = new Map<string, ConciseArrowBinding[]>();
  for (const declarator of rootNode.descendantsOfType('variable_declarator')) {
    if (!declarator) continue;
    const nameNode = declarator.childForFieldName('name');
    const initializer = unwrapExpressionWrappers(declarator.childForFieldName('value'));
    if (nameNode?.type !== 'identifier' || initializer?.type !== 'arrow_function') continue;
    const arrowBody = initializer.childForFieldName('body');
    if (!arrowBody || arrowBody.type === 'statement_block') continue;
    const scopeNode = enclosingFunctionOf(declarator) ?? rootNode;
    const group = bindingsByName.get(nameNode.text) ?? [];
    group.push({ bodyNode: arrowBody, scopeNode, ownerName: nameNode.text });
    bindingsByName.set(nameNode.text, group);
  }
  return bindingsByName;
}

function measureTsxShape(parser: Parser, sourceText: string): TsxShapeReport {
  const tree = parser.parse(sourceText);
  assert.ok(tree, 'tree-sitter failed to produce a parse tree for .tsx source');
  try {
    const rootNode = tree.rootNode;
    if (rootNode.hasError) {
      return {
        hasSyntaxError: true,
        score: 0,
        stateCount: 0,
        branchCount: 0,
        inlineSignalWriteCount: 0,
        directSignalConditionCount: 0,
        stateNames: [],
        branchOwners: [],
        signalLogicOwners: [],
      };
    }

    const mutatedArrayNames = collectMutatedArrayNames(rootNode);
    const importedBindings = collectImportedBindings(rootNode);
    const unrenderedSignals = collectUnrenderedSignals(rootNode);
    const unrenderedSignalByDeclaratorId = new Map<number, string>(
      unrenderedSignals.map((signal) => [signal.declaratorNodeId, signal.name]),
    );
    const signalLogic = measureUnrenderedSignalLogic(rootNode, unrenderedSignals, importedBindings);
    const conciseArrowBindings = collectConciseArrowBindings(rootNode);
    const countedArrowBodyIds = new Set<number>();

    const stateNames: string[] = [];
    const branchCountByOwner = new Map<string, number>();

    const recordBranch = (owner: string): void => {
      branchCountByOwner.set(owner, (branchCountByOwner.get(owner) ?? 0) + 1);
    };

    const visit = (node: Node, owner: string): void => {
      if (node.type === 'function_declaration') {
        const functionName = node.childForFieldName('name')?.text ?? '(anonymous)';
        const parameters = node.childForFieldName('parameters');
        if (parameters) visit(parameters, functionName);
        const body = node.childForFieldName('body');
        if (body) visit(body, functionName);
        return;
      }

      if (node.type === 'variable_declarator') {
        const nameNode = node.childForFieldName('name');
        const variableName = nameNode?.text ?? '(var)';
        const typeAnnotation = node.childForFieldName('type')?.text ?? '';
        const initializer = node.childForFieldName('value');
        const declarationKeyword = node.parent?.firstChild?.text ?? '';
        const isMutableDeclaration = declarationKeyword === 'let' || declarationKeyword === 'var';
        const hasDomType = DOM_OR_HOST_TYPE_PATTERN.test(typeAnnotation);

        if (nameNode) visit(nameNode, variableName);

        const unrenderedSignalName = unrenderedSignalByDeclaratorId.get(node.id);
        if (unrenderedSignalName !== undefined) {
          stateNames.push(`${unrenderedSignalName} (unrendered signal)`);
          if (initializer) visit(initializer, variableName);
          return;
        }

        if (initializer?.type === 'new_expression') {
          const constructorName = constructorTerminalNameOf(initializer);
          const isCollection = constructorName === 'Map' || constructorName === 'Set';
          if (isCollection) {
            if (!hasDomType && !hasDomOrHostTypeArguments(initializer)) {
              stateNames.push(`${variableName} (${constructorName})`);
            }
            visit(initializer, variableName);
            return;
          }
        }

        if (nameNode?.type === 'identifier' && mutatedArrayNames.has(variableName) && !hasDomType) {
          stateNames.push(`${variableName} (Array)`);
          if (initializer) visit(initializer, variableName);
          return;
        }

        const isDomHostInitializer = initializer?.type === 'new_expression' && isDomOrHostNewExpression(initializer);
        if (isMutableDeclaration && !hasDomType && !isDomHostInitializer) {
          stateNames.push(variableName);
        }

        if (initializer) visit(initializer, variableName);
        return;
      }

      if (node.type === 'new_expression') {
        const constructorName = constructorTerminalNameOf(node);
        const isStandaloneCollection =
          (constructorName === 'Map' || constructorName === 'Set') &&
          node.parent?.type !== 'variable_declarator' &&
          !isSignalInitializer(node) &&
          !hasDomOrHostTypeArguments(node);
        if (isStandaloneCollection) {
          stateNames.push(`${owner}: new ${constructorName}`);
        }
      }

      if (DECISION_NODE_TYPES.has(node.type)) {
        recordBranch(owner);
      }

      if (node.type === 'expression_statement') {
        countDiscardedExpressionBranches(node.namedChild(0), () => recordBranch(owner));
      }

      if (node.type === 'sequence_expression') {
        for (let childIndex = 0; childIndex < node.namedChildCount - 1; childIndex += 1) {
          countDiscardedExpressionBranches(node.namedChild(childIndex), () => recordBranch(owner));
        }
      }

      if (node.type === 'jsx_attribute') {
        const attrName = node.namedChild(0)?.text ?? '';
        const attrValue = node.namedChild(1);
        const exprChild = unwrapExpressionWrappers(
          attrValue?.type === 'jsx_expression' ? attrValue.namedChild(0) : null,
        );
        if (EVENT_ATTRIBUTE_PATTERN.test(attrName) && exprChild) {
          if (exprChild.type === 'arrow_function') {
            const arrowBody = exprChild.childForFieldName('body');
            if (arrowBody && arrowBody.type !== 'statement_block') {
              countDiscardedExpressionBranches(arrowBody, () => recordBranch(owner));
            }
          }
          if (exprChild.type === 'identifier') {
            for (const binding of conciseArrowBindings.get(exprChild.text) ?? []) {
              if (countedArrowBodyIds.has(binding.bodyNode.id) || !isNodeWithin(exprChild, binding.scopeNode)) {
                continue;
              }
              countedArrowBodyIds.add(binding.bodyNode.id);
              countDiscardedExpressionBranches(binding.bodyNode, () => recordBranch(binding.ownerName));
            }
          }
        }
      }

      for (let childIndex = 0; childIndex < node.namedChildCount; childIndex += 1) {
        const child = node.namedChild(childIndex);
        if (child) visit(child, owner);
      }
    };

    visit(rootNode, '<module>');

    const branchOwners: BranchOwnerCount[] = [...branchCountByOwner.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    const branchCount = branchOwners.reduce((total, entry) => total + entry.count, 0);

    return {
      hasSyntaxError: false,
      score: stateNames.length + branchCount + signalLogic.inlineWrites + signalLogic.directConditions,
      stateCount: stateNames.length,
      branchCount,
      inlineSignalWriteCount: signalLogic.inlineWrites,
      directSignalConditionCount: signalLogic.directConditions,
      stateNames,
      branchOwners,
      signalLogicOwners: signalLogic.owners,
    };
  } finally {
    tree.delete();
  }
}

function siblingCorePathOf(repoPath: string): string {
  const directory = path.posix.dirname(repoPath);
  const stem = path.posix.basename(repoPath, '.tsx');
  const kebabStem = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `${directory}/${kebabStem}-core.ts`;
}

function formatOffenders(report: TsxShapeReport): string {
  const parts: string[] = [];
  if (report.stateNames.length > 0) {
    const shown = report.stateNames.slice(0, MAX_REPORTED_OFFENDERS).join(', ');
    const overflow =
      report.stateNames.length > MAX_REPORTED_OFFENDERS
        ? `, +${report.stateNames.length - MAX_REPORTED_OFFENDERS} more`
        : '';
    parts.push(`state: ${shown}${overflow}`);
  }
  if (report.branchOwners.length > 0) {
    const shown = report.branchOwners
      .slice(0, MAX_REPORTED_OFFENDERS)
      .map((entry) => `${entry.name} (${entry.count})`)
      .join(', ');
    const overflow =
      report.branchOwners.length > MAX_REPORTED_OFFENDERS
        ? `, +${report.branchOwners.length - MAX_REPORTED_OFFENDERS} more`
        : '';
    parts.push(`decisions: ${shown}${overflow}`);
  }
  if (report.signalLogicOwners.length > 0) {
    const shown = report.signalLogicOwners
      .slice(0, MAX_REPORTED_OFFENDERS)
      .map((entry) => `${entry.name} (${entry.inlineWrites} inline writes, ${entry.directConditions} direct conditions)`)
      .join(', ');
    const overflow =
      report.signalLogicOwners.length > MAX_REPORTED_OFFENDERS
        ? `, +${report.signalLogicOwners.length - MAX_REPORTED_OFFENDERS} more`
        : '';
    parts.push(`signal-logic: ${shown}${overflow}`);
  }
  return parts.join('; ');
}

function formatBreakdown(report: TsxShapeReport): string {
  const counts = [`${report.stateCount} state`, `${report.branchCount} branches`];
  const signalLogicTotal = report.inlineSignalWriteCount + report.directSignalConditionCount;
  if (signalLogicTotal > 0) {
    counts.push(
      `${report.inlineSignalWriteCount} inline signal writes`,
      `${report.directSignalConditionCount} direct signal conditions`,
    );
  }
  const offenders = formatOffenders(report);
  return offenders.length > 0 ? `${counts.join(', ')}; ${offenders}` : counts.join(', ');
}

function readRecordedTsxShapes(): Record<string, number> {
  const raw = fs.readFileSync(path.join(REPO_ROOT, RATCHETS_RELATIVE_PATH), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `${RATCHETS_RELATIVE_PATH} must be a JSON object mapping repo-relative .tsx paths to non-negative integer scores`,
  );
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [repoPath, score] of entries) {
    assert.ok(
      typeof score === 'number' && Number.isInteger(score) && score >= 0,
      `${RATCHETS_RELATIVE_PATH}: "${repoPath}" must map to a non-negative integer score`,
    );
  }
  return parsed as Record<string, number>;
}

function findTsxShapeViolations(
  parser: Parser,
  sourceFiles: readonly TrackedTsxFile[],
  recordedScores: Readonly<Record<string, number>>,
): string[] {
  const violations: string[] = [];
  const recordedPaths = Object.keys(recordedScores);

  for (let index = 1; index < recordedPaths.length; index += 1) {
    const previous = recordedPaths[index - 1] ?? '';
    const current = recordedPaths[index] ?? '';
    if (current < previous) {
      violations.push(`${current}: ${RATCHETS_RELATIVE_PATH} is not sorted -> keep entries in lexicographical order`);
    }
  }

  const livePaths = new Set<string>();
  for (const sourceFile of sourceFiles) {
    livePaths.add(sourceFile.path);
    const report = measureTsxShape(parser, sourceFile.content);
    if (report.hasSyntaxError) {
      violations.push(`${sourceFile.path}: tree-sitter-tsx reported a syntax error -> fix the syntax error before landing`);
      continue;
    }

    const corePath = siblingCorePathOf(sourceFile.path);
    const recordedScore = Object.hasOwn(recordedScores, sourceFile.path) ? recordedScores[sourceFile.path] : undefined;

    if (recordedScore === undefined) {
      if (report.score > NEW_TSX_SHAPE_BUDGET) {
        violations.push(
          `${sourceFile.path}: tsx-shape score ${report.score} exceeds new-file budget ${NEW_TSX_SHAPE_BUDGET} (${formatBreakdown(report)}) -> move state and decisions to ${corePath}`,
        );
      }
      continue;
    }

    if (report.score > recordedScore) {
      violations.push(
        `${sourceFile.path}: tsx-shape score ${report.score} exceeds recorded ${recordedScore} (${formatBreakdown(report)}) -> move state and decisions to ${corePath}`,
      );
      continue;
    }

    if (report.score < recordedScore) {
      violations.push(
        `${sourceFile.path}: tsx-shape score shrank to ${report.score} (${recordedScore} recorded) -> lower its recorded score in ${RATCHETS_RELATIVE_PATH}`,
      );
    }
  }

  for (const recordedPath of recordedPaths) {
    if (livePaths.has(recordedPath)) continue;
    violations.push(`${recordedPath}: recorded .tsx file is gone -> remove it from ${RATCHETS_RELATIVE_PATH}`);
  }

  return violations;
}

test('public/**/*.tsx files stay within their recorded tsx-shape score or the new-file budget', async () => {
  const tsxPaths = trackedFiles(PUBLIC_TSX_PATTERN);
  assert.ok(tsxPaths.length > 0, 'expected tracked public/**/*.tsx files so this gate cannot pass vacuously');

  const parser = await tsxParser();
  const sourceFiles = tsxPaths.map((repoPath) => ({ path: repoPath, content: readTracked(repoPath) }));
  const recordedScores = readRecordedTsxShapes();
  const violations = findTsxShapeViolations(parser, sourceFiles, recordedScores);

  assert.deepEqual(
    violations,
    [],
    `Solid .tsx shape violations (keep .tsx to markup and wiring; put state and decisions in *-core.ts):\n  ${violations.join('\n  ')}`,
  );
});

test('tsx-shape gate fails on over-budget new files, regressed recorded files, shrunk scores, stale ledger entries, and AST edge cases', async () => {
  const parser = await tsxParser();

  const bloatedLines = [
    'export function BloatedPanel(props: { items: string[] }) {',
    '  const indexByKey = new Map<string, number>();',
    '  const seenIds = new Set<string>();',
    '  const queue: string[] = [];',
    '  let activeIndex = 0;',
    '  const computeRows = (items: string[]) => {',
    '    for (const item of items) {',
    '      if (seenIds.has(item)) continue;',
    '      seenIds.add(item);',
    '      queue.push(item);',
    '      indexByKey.set(item, activeIndex);',
    '      activeIndex += 1;',
    '    }',
  ];
  for (let branchNumber = 0; branchNumber < 22; branchNumber += 1) {
    bloatedLines.push(`    if (activeIndex === ${branchNumber}) return queue.slice(0, ${branchNumber});`);
  }
  bloatedLines.push(
    '    return queue;',
    '  };',
    '  return <div>{computeRows(props.items).length}</div>;',
    '}',
  );

  const cleanFile = 'export function ThinBadge(props: { label: string }) {\n  return <span>{props.label}</span>;\n}\n';
  const regressedExisting = [
    'export function SmallWidget(props: { count: number }) {',
    '  let pendingCount = 0;',
    '  const decide = () => {',
    '    if (props.count > 0) pendingCount += 1;',
    '    if (props.count > 10) return "many";',
    '    return String(pendingCount);',
    '  };',
    '  return <div>{decide()}</div>;',
    '}',
  ].join('\n');

  const violations = findTsxShapeViolations(
    parser,
    [
      { path: 'public/board-session/BloatedPanel.tsx', content: bloatedLines.join('\n') },
      { path: 'public/ui/ThinBadge.tsx', content: cleanFile },
      { path: 'public/ui/SmallWidget.tsx', content: regressedExisting },
    ],
    {
      'public/ui/DeletedView.tsx': 4,
      'public/ui/SmallWidget.tsx': 1,
      'public/ui/ThinBadge.tsx': 3,
    },
  );

  assert.ok(
    violations.some(
      (entry) =>
        entry.includes('public/board-session/BloatedPanel.tsx:') &&
        entry.includes(`exceeds new-file budget ${NEW_TSX_SHAPE_BUDGET}`) &&
        entry.includes('indexByKey (Map)') &&
        entry.includes('seenIds (Set)') &&
        entry.includes('queue (Array)') &&
        entry.includes('computeRows') &&
        entry.includes('public/board-session/bloated-panel-core.ts'),
    ),
    `expected over-budget new-file violation naming state, decisions, and sibling core, got: ${violations.join(' | ')}`,
  );

  assert.ok(
    violations.some(
      (entry) =>
        entry.includes('public/ui/SmallWidget.tsx:') &&
        entry.includes('exceeds recorded 1') &&
        entry.includes('pendingCount') &&
        entry.includes('public/ui/small-widget-core.ts'),
    ),
    `expected regressed existing-file violation, got: ${violations.join(' | ')}`,
  );

  assert.ok(
    violations.some(
      (entry) =>
        entry.includes('public/ui/ThinBadge.tsx:') &&
        entry.includes('shrank to 0 (3 recorded)') &&
        entry.includes(RATCHETS_RELATIVE_PATH),
    ),
    `expected shrink-ratchet violation, got: ${violations.join(' | ')}`,
  );

  assert.ok(
    violations.some(
      (entry) =>
        entry.includes('public/ui/DeletedView.tsx:') &&
        entry.includes('is gone') &&
        entry.includes(RATCHETS_RELATIVE_PATH),
    ),
    `expected stale ledger violation, got: ${violations.join(' | ')}`,
  );

  const edgeCaseReport = measureTsxShape(
    parser,
    [
      'export function EdgeCases(',
      '  props: { run?: () => number },',
      '  fallback = () => { const cache = new globalThis.Map<string, number>(); if (cache.size > 0) return 1; return 0; },',
      ') {',
      '  const { run = () => { const seen = new window.Set<string>(); if (seen.size > 0) return 1; return 0; } } = props;',
      '  let startedAt = new Date();',
      '  let mode = "Event";',
      '  let stateElement = 0;',
      '  const typedList = [] as string[];',
      '  typedList.push("a");',
      '  return <div>{run() + fallback() + Number(startedAt) + mode.length + stateElement + typedList.length}</div>;',
      '}',
    ].join('\n'),
  );
  assert.equal(edgeCaseReport.stateCount, 6, `expected all 6 edge-case state items counted, got ${edgeCaseReport.stateNames.join(', ')}`);
  assert.equal(edgeCaseReport.branchCount, 2, `expected both default-param and destructuring branches counted, got ${edgeCaseReport.branchCount}`);
});

test('tsx-shape gate catches unrendered signals, statement-level expression branches, and inline unrendered-signal controller logic while keeping delegated cores and JSX ternaries cheap', async () => {
  const parser = await tsxParser();

  const signalReport = measureTsxShape(
    parser,
    [
      'export function SignalFlags(props: { onFire: () => void }) {',
      '  const [renderedCount, setRenderedCount] = createSignal(0);',
      '  const [hiddenFlag, setHiddenFlag] = createSignal(false);',
      '  const syncedFlag = createSyncedSignal(false);',
      '  const renderedSynced = createSyncedSignal("ready");',
      '  const tupleFlag = createSignal(false);',
      '  const { read: destructuredRead, update: destructuredUpdate } = createSyncedSignal(false);',
      '  const [castedFlag, setCastedFlag] = createSignal(false) as [() => boolean, (v: boolean) => void];',
      '  const [defaultedFlag = () => false, setDefaultedFlag] = createSignal(false);',
      '  return (',
      '    <button',
      '      ref={(el) => { if (hiddenFlag()) el.focus(); }}',
      '      onClick={() => {',
      '        setRenderedCount(1);',
      '        setHiddenFlag(!hiddenFlag());',
      '        syncedFlag.update(!syncedFlag.read());',
      '        tupleFlag[1](!tupleFlag[0]());',
      '        destructuredUpdate(!destructuredRead());',
      '        setCastedFlag(!castedFlag());',
      '        setDefaultedFlag(!defaultedFlag());',
      '        props.onFire();',
      '      }}',
      '    >',
      '      {renderedCount()}{renderedSynced.read()}',
      '    </button>',
      '  );',
      '}',
    ].join('\n'),
  );
  assert.equal(signalReport.stateCount, 6, `expected 6 unrendered signals, got ${signalReport.stateNames.join(', ')}`);
  assert.deepEqual(signalReport.stateNames, [
    'hiddenFlag (unrendered signal)',
    'syncedFlag (unrendered signal)',
    'tupleFlag (unrendered signal)',
    'destructuredRead (unrendered signal)',
    'castedFlag (unrendered signal)',
    'defaultedFlag (unrendered signal)',
  ]);
  assert.equal(signalReport.inlineSignalWriteCount, 6);
  assert.equal(signalReport.directSignalConditionCount, 7);

  const expressionBranchReport = measureTsxShape(
    parser,
    [
      'export function ExpressionBranches(props: { ok: boolean; extra: boolean; onA: () => Promise<void>; onB: () => void }) {',
      '  const localClick = () => (props.ok ? props.onA() : props.onB());',
      '  const handle = async () => {',
      '    props.ok ? props.onA() : (props.extra ? props.onB() : undefined);',
      '    props.ok && props.onA();',
      '    0, props.ok ? props.onA() : props.onB();',
      '    await (props.ok ? props.onA() : props.onB());',
      '    !(props.ok && props.onB());',
      '  };',
      '  return (',
      '    <button',
      '      data-ok={props.ok ? "" : undefined}',
      '      onClick={localClick}',
      '      on:click={(() => (props.ok ? props.onA() : props.onB()))}',
      '      onclick={() => (props.ok && props.onA(), props.extra && props.onB())}',
      '    >',
      '      {props.ok ? "Yes" : "No"}',
      '    </button>',
      '  );',
      '}',
    ].join('\n'),
  );
  assert.equal(expressionBranchReport.branchCount, 10, `expected 10 statement/handler expression branches (JSX ternaries free), got ${expressionBranchReport.branchCount}`);
  assert.equal(expressionBranchReport.score, 10);

  const delegatedCoreReport = measureTsxShape(
    parser,
    [
      'import { closeState, decideNext, withReset } from "./my-core.ts";',
      'export function createDelegatedHandle() {',
      '  const stateSignal = createSyncedSignal({ closed: false });',
      '  return {',
      '    run: () => { const decision = decideNext(stateSignal.peek()); if (decision.shouldReset) stateSignal.update((prev) => withReset(prev, true)); },',
      '    close: () => { stateSignal.update(closeState); },',
      '  };',
      '}',
      'export function ThinView() { return <div />; }',
    ].join('\n'),
  );
  assert.equal(delegatedCoreReport.stateCount, 1);
  assert.equal(delegatedCoreReport.inlineSignalWriteCount, 0);
  assert.equal(delegatedCoreReport.directSignalConditionCount, 0);
  assert.equal(delegatedCoreReport.score, 2);

  const inlineControllerReport = measureTsxShape(
    parser,
    [
      'import { batch, untrack } from "solid-js";',
      'export function createInlineController() {',
      '  const isClosed = createSyncedSignal(false);',
      '  const generation = createSyncedSignal({ count: 0 });',
      '  const [, setRetries] = createSignal(0);',
      '  const isReady = (closed: boolean) => !closed;',
      '  return {',
      '    run: (expected: number) => {',
      '      if (isReady(isClosed.peek()) && !Boolean(isClosed.peek()) && generation.peek().count + 1 > expected) {',
      '        generation.update((n) => untrack(() => ({ count: n.count + 1 })));',
      '        setRetries((count) => count + 1);',
      '      }',
      '    },',
      '    close: () => { isClosed.update(batch(() => true)); },',
      '  };',
      '}',
      'export function ThinView() { return <div />; }',
    ].join('\n'),
  );
  assert.equal(inlineControllerReport.stateCount, 3);
  assert.equal(inlineControllerReport.inlineSignalWriteCount, 3);
  assert.equal(inlineControllerReport.directSignalConditionCount, 3);
  assert.equal(inlineControllerReport.signalLogicOwners[0]?.name, 'createInlineController');

  const commentResilientReport = measureTsxShape(
    parser,
    [
      'import /* core */ { closeState } from "./my-core.ts";',
      'export function createCommentedHandle() {',
      '  const stateSignal = createSyncedSignal({ closed: false });',
      '  const [/* getter */ hiddenFlag, setHiddenFlag] = createSignal(false);',
      '  return {',
      '    close: () => {',
      '      stateSignal.update(/* reset */ closeState);',
      '      setHiddenFlag(true);',
      '    },',
      '  };',
      '}',
      'export function ThinView() { return <div />; }',
    ].join('\n'),
  );
  assert.equal(commentResilientReport.stateCount, 2);
  assert.equal(commentResilientReport.inlineSignalWriteCount, 1);
  assert.equal(commentResilientReport.directSignalConditionCount, 0);
});
