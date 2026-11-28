import '../helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import treeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Parser } from '@vscode/tree-sitter-wasm';
import { grammarWasmPath, treeSitterRuntimeWasmPath } from '../../server/runtime-paths.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const UI_DIR = path.join(REPO_ROOT, 'public/ui');
const DESCRIPTOR_FN_PATTERN = /(?:Descriptor|Attributes)$/;

const SOLID_ONLY_CORES = new Set([
  'dialog',
]);

const ALLOWED_OMITTED_INPUTS = new Map<string, string>([
  ['public/ui/Button.tsx|OutlineIconButton|buttonDescriptor|shortcutKey', 'matches button.ts Omit<CommonButtonOptions, shortcutKey>'],
  ['public/ui/Checkbox.tsx|Checkbox|choiceDescriptor|name', 'matches checkbox.ts where only Radio accepts name'],
  ['public/ui/notice.ts|createNotice|noticeDescriptor|tone', 'initial hidden call; show() passes tone'],
  ['public/ui/notice.ts|createNotice|noticeDescriptor|command', 'initial hidden call; show() passes command'],
  ['public/ui/notice.ts|createNotice|noticeDescriptor|meta', 'initial hidden call; show() passes meta'],
  ['public/ui/TextInput.tsx|TextInput|textInputDescriptor|value', 'applies props.value via ref and createEffect to avoid Solid 2 uncommitted input overwrites'],
  ['public/ui/TextInput.tsx|TextArea|textAreaDescriptor|value', 'applies props.value via ref and createEffect to avoid Solid 2 uncommitted input overwrites'],
]);

const ALLOWED_UNREAD_OUTPUTS = new Map<string, string>([
  ['public/ui/Button.tsx|OutlineIconButton|buttonDescriptor|visibleLabel', 'outline-icon variant is icon-only and renders ariaLabel, never visibleLabel'],
  ['public/ui/Button.tsx|OutlineIconButton|buttonDescriptor|shortcutKey', 'matches button.ts Omit<CommonButtonOptions, shortcutKey>'],
  ['public/ui/Button.tsx|OutlineIconButton|buttonDescriptor|ariaKeyShortcuts', 'matches button.ts Omit<CommonButtonOptions, shortcutKey>'],
  ['public/ui/Checkbox.tsx|Checkbox|choiceDescriptor|name', 'checkboxes have no radio group name; Radio reads descriptor().name'],
  ['public/ui/EmptyState.tsx|EmptyState|emptyStateDescriptor|rootTag', 'renders static JSX <p> or <div> switched on descriptor().isTextOnly'],
  ['public/ui/field.ts|field|fieldDescriptor|hintHidden', 'sets hint visibility via setText() calling fieldMessageState()'],
  ['public/ui/field.ts|field|fieldDescriptor|errorHidden', 'sets error visibility via setText() calling fieldMessageState()'],
  ['public/ui/field.ts|field|fieldDescriptor|ariaInvalid', 'mutates aria-invalid imperatively via setError()'],
  ['public/ui/meter.ts|meter|meterDescriptor|fraction', 'binds cssValue to --meter-value; fraction is for core unit tests'],
  ['public/ui/meter.ts|meter|meterDescriptor|cssValue', 'initial value applied via setValue() calling meterValueState()'],
  ['public/ui/meter.ts|meter|meterDescriptor|ariaValueNow', 'initial value applied via setValue() calling meterValueState()'],
  ['public/ui/meter.ts|meter|meterDescriptor|ariaValueText', 'initial value applied via setValue() calling meterValueState()'],
  ['public/ui/Meter.tsx|Meter|meterDescriptor|fraction', 'binds cssValue to --meter-value; fraction is for core unit tests'],
  ['public/ui/notice.ts|createNotice|noticeDescriptor|shown', 'tracks visibility through element.hidden'],
  ['public/ui/notice.ts|createNotice|noticeDescriptor|metaHidden', 'sets meta visibility via setMeta() calling noticeMetaState()'],
  ['public/ui/Notice.tsx|Notice|noticeDescriptor|shown', 'tracks visibility through descriptor().hidden'],
  ['public/ui/section-heading.ts|sectionHeading|sectionHeadingDescriptor|count', 'sets initial count via setCount() calling sectionHeadingCountState()'],
  ['public/ui/Segmented.tsx|Segmented|segmentedDescriptor|role', 'Biome a11y lint requires literal role="radiogroup" on the JSX div with onKeyDown and aria-label'],
  ['public/ui/TextInput.tsx|TextInput|textInputDescriptor|value', 'applies props.value via ref and createEffect'],
  ['public/ui/TextInput.tsx|TextArea|textAreaDescriptor|value', 'applies props.value via ref and createEffect'],
]);

interface CoreContract {
  readonly fnName: string;
  readonly optionsParamIndex: number | null;
  readonly inputKeys: readonly string[];
  readonly outputKeys: readonly string[];
}

interface ShellAuditResult {
  readonly violations: string[];
  readonly usedInputAllowlistKeys: Set<string>;
  readonly usedOutputAllowlistKeys: Set<string>;
}

interface Parsers {
  readonly tsParser: Parser;
  readonly tsxParser: Parser;
}

type TypeResolver = (typeNode: Node | null, seen?: Set<string>) => Set<string>;

let cachedParsersPromise: Promise<Parsers> | null = null;

function loadParsers(): Promise<Parsers> {
  cachedParsersPromise ??= (async () => {
    const runtimeWasmPath = treeSitterRuntimeWasmPath();
    assert.ok(runtimeWasmPath, 'tree-sitter runtime (@vscode/tree-sitter-wasm) must be installed');
    await treeSitter.Parser.init({ locateFile: () => runtimeWasmPath });
    const tsWasmPath = grammarWasmPath('typescript');
    const tsxWasmPath = grammarWasmPath('tsx');
    assert.ok(tsWasmPath, 'tree-sitter typescript grammar must be installed');
    assert.ok(tsxWasmPath, 'tree-sitter tsx grammar must be installed');
    const tsLanguage = await treeSitter.Language.load(new Uint8Array(await fs.promises.readFile(tsWasmPath)));
    const tsxLanguage = await treeSitter.Language.load(new Uint8Array(await fs.promises.readFile(tsxWasmPath)));
    const tsParser = new treeSitter.Parser();
    tsParser.setLanguage(tsLanguage);
    const tsxParser = new treeSitter.Parser();
    tsxParser.setLanguage(tsxLanguage);
    return { tsParser, tsxParser };
  })();
  return cachedParsersPromise;
}

function kebabToPascal(kebabName: string): string {
  return kebabName
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

function stripQuotes(rawText: string): string {
  return rawText.replace(/^['"]|['"]$/g, '');
}

function firstNamedChild(node: Node | null): Node | null {
  if (!node) return null;
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child && child.type !== 'comment') return child;
  }
  return null;
}

function extractStringLiteralUnion(typeNode: Node | null): Set<string> {
  const literals = new Set<string>();
  if (!typeNode) return literals;
  for (const strNode of typeNode.descendantsOfType('string')) {
    if (strNode) literals.add(stripQuotes(strNode.text));
  }
  return literals;
}

function buildTypeResolver(rootNode: Node, fallbackLookup?: (typeName: string) => Set<string>): {
  resolveNode: TypeResolver;
  resolveByName: (typeName: string, seen?: Set<string>) => Set<string>;
} {
  const declarations = new Map<string, Node>();

  for (const node of rootNode.descendantsOfType(['type_alias_declaration', 'interface_declaration'])) {
    if (!node) continue;
    const typeName = node.childForFieldName('name')?.text;
    if (typeName) declarations.set(typeName, node);
  }

  const resolveByName = (typeName: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(typeName)) return new Set();
    seen.add(typeName);
    const decl = declarations.get(typeName);
    if (!decl) return fallbackLookup ? fallbackLookup(typeName) : new Set();
    if (decl.type === 'type_alias_declaration') {
      return resolveNode(decl.childForFieldName('value'), seen);
    }
    const keys = new Set<string>();
    const body = decl.childForFieldName('body');
    for (const key of resolveNode(body, seen)) keys.add(key);
    for (const ext of decl.descendantsOfType('extends_type_clause')) {
      if (!ext) continue;
      for (const child of ext.namedChildren) {
        if (!child) continue;
        for (const key of resolveNode(child, seen)) keys.add(key);
      }
    }
    return keys;
  };

  const resolveNode: TypeResolver = (typeNode, seen = new Set<string>()): Set<string> => {
    if (!typeNode) return new Set();
    if (typeNode.type === 'type_annotation' || typeNode.type === 'parenthesized_type') {
      return resolveNode(firstNamedChild(typeNode), seen);
    }
    if (typeNode.type === 'object_type') {
      const keys = new Set<string>();
      for (const child of typeNode.namedChildren) {
        if (child?.type !== 'property_signature') continue;
        const keyText = child.childForFieldName('name')?.text;
        if (keyText) keys.add(stripQuotes(keyText));
      }
      return keys;
    }
    if (typeNode.type === 'type_identifier') {
      return resolveByName(typeNode.text, seen);
    }
    if (typeNode.type === 'intersection_type' || typeNode.type === 'union_type') {
      const keys = new Set<string>();
      for (const child of typeNode.namedChildren) {
        if (!child) continue;
        for (const key of resolveNode(child, new Set(seen))) keys.add(key);
      }
      return keys;
    }
    if (typeNode.type === 'generic_type') {
      const baseName = typeNode.childForFieldName('name')?.text ?? '';
      const typeArgs = typeNode.childForFieldName('type_arguments');
      const firstArg = typeArgs?.namedChild(0) ?? null;
      const secondArg = typeArgs?.namedChild(1) ?? null;
      if (baseName === 'Omit') {
        const baseKeys = resolveNode(firstArg, new Set(seen));
        const omitted = extractStringLiteralUnion(secondArg);
        for (const key of omitted) baseKeys.delete(key);
        return baseKeys;
      }
      if (baseName === 'Pick') {
        const baseKeys = resolveNode(firstArg, new Set(seen));
        const picked = extractStringLiteralUnion(secondArg);
        return new Set([...baseKeys].filter((key) => picked.has(key)));
      }
      if (baseName === 'Partial' || baseName === 'Required' || baseName === 'Readonly') {
        return resolveNode(firstArg, new Set(seen));
      }
      return resolveByName(baseName, seen);
    }
    return new Set();
  };

  return { resolveNode, resolveByName };
}

function extractCoreContracts(coreRoot: Node): CoreContract[] {
  const { resolveNode } = buildTypeResolver(coreRoot);
  const contracts: CoreContract[] = [];

  for (const fnNode of coreRoot.descendantsOfType('function_declaration')) {
    if (fnNode?.parent?.type !== 'export_statement') continue;
    const fnName = fnNode.childForFieldName('name')?.text;
    if (!fnName || !DESCRIPTOR_FN_PATTERN.test(fnName)) continue;

    let optionsParamIndex: number | null = null;
    const inputKeys = new Set<string>();
    const paramsNode = fnNode.childForFieldName('parameters');
    const namedParams = (paramsNode?.namedChildren ?? []).filter((child): child is Node => child !== null && child.type !== 'comment');
    for (let paramIndex = 0; paramIndex < namedParams.length; paramIndex += 1) {
      const param = namedParams[paramIndex];
      const resolved = resolveNode(param.childForFieldName('type'));
      if (resolved.size === 0) continue;
      optionsParamIndex = paramIndex;
      for (const key of resolved) inputKeys.add(key);
      break;
    }

    const returnKeys = resolveNode(fnNode.childForFieldName('return_type'));
    contracts.push({
      fnName,
      optionsParamIndex,
      inputKeys: [...inputKeys],
      outputKeys: [...returnKeys],
    });
  }

  return contracts;
}

function enclosingFunctionNode(node: Node): Node | null {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'function_declaration') return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function enclosingFunctionName(node: Node): string {
  return enclosingFunctionNode(node)?.childForFieldName('name')?.text ?? '<module>';
}

function findParameterTypeNode(fnNode: Node | null, paramName: string): Node | null {
  if (!fnNode) return null;
  const paramsNode = fnNode.childForFieldName('parameters');
  for (const param of paramsNode?.namedChildren ?? []) {
    if (!param) continue;
    const pattern = param.childForFieldName('pattern');
    if (pattern?.text === paramName) return param.childForFieldName('type');
  }
  return null;
}

function findDescriptorBinding(callNode: Node): { bindingName: string | null; scopeNode: Node } {
  let cursor: Node | null = callNode.parent;
  while (cursor) {
    if (cursor.type === 'variable_declarator') {
      const nameNode = cursor.childForFieldName('name');
      const scope = enclosingFunctionNode(cursor) ?? cursor.tree.rootNode;
      return { bindingName: nameNode?.type === 'identifier' ? nameNode.text : null, scopeNode: scope };
    }
    if (cursor.type === 'function_declaration') {
      break;
    }
    if (cursor.type === 'statement_block' && cursor.parent?.type !== 'arrow_function') {
      break;
    }
    cursor = cursor.parent;
  }
  return { bindingName: null, scopeNode: enclosingFunctionNode(callNode) ?? callNode.tree.rootNode };
}

function collectLocalFunctionsByName(shellRoot: Node): Map<string, Node> {
  const functions = new Map<string, Node>();
  for (const fnNode of shellRoot.descendantsOfType('function_declaration')) {
    if (!fnNode) continue;
    const name = fnNode.childForFieldName('name')?.text;
    if (name) functions.set(name, fnNode);
  }
  for (const declarator of shellRoot.descendantsOfType('variable_declarator')) {
    if (!declarator) continue;
    const name = declarator.childForFieldName('name')?.text;
    const value = declarator.childForFieldName('value');
    if (name && (value?.type === 'arrow_function' || value?.type === 'function_expression')) {
      functions.set(name, value);
    }
  }
  return functions;
}

function unwrapReceiverName(node: Node | null): string | null {
  let current = node;
  while (current) {
    if (
      current.type === 'parenthesized_expression' ||
      current.type === 'non_null_expression' ||
      current.type === 'as_expression'
    ) {
      current = firstNamedChild(current);
      continue;
    }
    if (current.type === 'call_expression') {
      const callee = current.childForFieldName('function');
      if (callee?.type === 'identifier') return callee.text;
      return null;
    }
    if (current.type === 'identifier') return current.text;
    return null;
  }
  return null;
}

function collectBindingPropertyReads(
  scopeNode: Node,
  bindingName: string,
  localFunctions: ReadonlyMap<string, Node>,
  visited = new Set<string>(),
): Set<string> {
  const visitKey = `${scopeNode.id}:${bindingName}`;
  if (visited.has(visitKey)) return new Set();
  visited.add(visitKey);

  const reads = new Set<string>();
  const aliases = new Set<string>([bindingName]);

  for (const declarator of scopeNode.descendantsOfType('variable_declarator')) {
    if (!declarator) continue;
    const valueReceiver = unwrapReceiverName(declarator.childForFieldName('value'));
    if (!valueReceiver || !aliases.has(valueReceiver)) continue;
    const nameNode = declarator.childForFieldName('name');
    if (nameNode?.type === 'identifier') {
      aliases.add(nameNode.text);
      continue;
    }
    if (nameNode?.type === 'object_pattern') {
      for (const shorthand of nameNode.descendantsOfType('shorthand_property_identifier_pattern')) {
        if (shorthand) reads.add(shorthand.text);
      }
      for (const pair of nameNode.descendantsOfType('pair_pattern')) {
        const keyText = pair?.childForFieldName('key')?.text;
        if (keyText) reads.add(stripQuotes(keyText));
      }
    }
  }

  for (const member of scopeNode.descendantsOfType('member_expression')) {
    if (!member) continue;
    const receiverName = unwrapReceiverName(member.childForFieldName('object'));
    if (!receiverName || !aliases.has(receiverName)) continue;
    const propName = member.childForFieldName('property')?.text;
    if (propName) reads.add(propName);
  }

  for (const callExpr of scopeNode.descendantsOfType('call_expression')) {
    if (!callExpr) continue;
    const calleeName = callExpr.childForFieldName('function')?.text;
    if (!calleeName) continue;
    const targetFn = localFunctions.get(calleeName);
    if (!targetFn) continue;
    const callArgs = (callExpr.childForFieldName('arguments')?.namedChildren ?? []).filter(
      (arg): arg is Node => arg !== null && arg.type !== 'comment',
    );
    const fnParams = (targetFn.childForFieldName('parameters')?.namedChildren ?? []).filter(
      (param): param is Node => param !== null && param.type !== 'comment',
    );
    for (let argIndex = 0; argIndex < callArgs.length; argIndex += 1) {
      const argReceiver = unwrapReceiverName(callArgs[argIndex]);
      if (!argReceiver || !aliases.has(argReceiver)) continue;
      const paramName = fnParams[argIndex]?.childForFieldName('pattern')?.text;
      if (!paramName) continue;
      for (const nestedRead of collectBindingPropertyReads(targetFn, paramName, localFunctions, visited)) {
        reads.add(nestedRead);
      }
    }
  }

  return reads;
}

function collectImportedTypeNames(shellRoot: Node): Set<string> {
  const names = new Set<string>();
  for (const spec of shellRoot.descendantsOfType('import_specifier')) {
    if (!spec) continue;
    const importedName = spec.childForFieldName('name')?.text;
    if (importedName) names.add(importedName);
  }
  return names;
}

function auditShellAgainstCore(
  corePath: string,
  shellPath: string,
  contracts: readonly CoreContract[],
  coreRoot: Node,
  shellRoot: Node,
  allowedOmittedInputs: ReadonlyMap<string, string>,
  allowedUnreadOutputs: ReadonlyMap<string, string>,
): ShellAuditResult {
  const violations: string[] = [];
  const usedInputAllowlistKeys = new Set<string>();
  const usedOutputAllowlistKeys = new Set<string>();

  const coreResolver = buildTypeResolver(coreRoot);
  const importedTypeNames = collectImportedTypeNames(shellRoot);
  const shellResolver = buildTypeResolver(shellRoot, (typeName) => (
    importedTypeNames.has(typeName) ? coreResolver.resolveByName(typeName) : new Set()
  ));
  const localFunctions = collectLocalFunctionsByName(shellRoot);

  for (const contract of contracts) {
    const matchingCalls = shellRoot
      .descendantsOfType('call_expression')
      .filter((callNode): callNode is Node => callNode !== null && callNode.childForFieldName('function')?.text === contract.fnName);

    if (matchingCalls.length === 0) {
      violations.push(`${shellPath}: never calls ${contract.fnName}() defined in ${corePath}`);
      continue;
    }

    const readsByOwner = new Map<string, Set<string>>();

    for (const callNode of matchingCalls) {
      const ownerFn = enclosingFunctionNode(callNode);
      const owner = enclosingFunctionName(callNode);
      const argsList = (callNode.childForFieldName('arguments')?.namedChildren ?? []).filter(
        (arg): arg is Node => arg !== null && arg.type !== 'comment',
      );

      if (contract.optionsParamIndex !== null && contract.inputKeys.length > 0) {
        const optionsArg = argsList[contract.optionsParamIndex] ?? null;

        if (!optionsArg) {
          for (const inputKey of contract.inputKeys) {
            const allowKey = `${shellPath}|${owner}|${contract.fnName}|${inputKey}`;
            if (allowedOmittedInputs.has(allowKey)) {
              usedInputAllowlistKeys.add(allowKey);
              continue;
            }
            violations.push(
              `${shellPath} (${owner} -> ${contract.fnName}): omits options argument carrying "${inputKey}" defined in ${corePath}`,
            );
          }
        }

        if (optionsArg?.type === 'object') {
          const passedKeys = new Set<string>();
          let hasUnverifiableSpread = false;
          for (const child of optionsArg.namedChildren) {
            if (!child) continue;
            if (child.type === 'pair') {
              const keyText = child.childForFieldName('key')?.text;
              if (keyText) passedKeys.add(stripQuotes(keyText));
              continue;
            }
            if (child.type === 'shorthand_property_identifier') {
              passedKeys.add(child.text);
              continue;
            }
            if (child.type === 'spread_element') {
              const spreadTarget = firstNamedChild(child);
              const paramType = spreadTarget?.type === 'identifier'
                ? findParameterTypeNode(ownerFn, spreadTarget.text)
                : null;
              const spreadKeys = shellResolver.resolveNode(paramType);
              if (spreadKeys.size === 0) {
                hasUnverifiableSpread = true;
                continue;
              }
              for (const key of spreadKeys) passedKeys.add(key);
            }
          }
          if (hasUnverifiableSpread) {
            violations.push(
              `${shellPath} (${owner} -> ${contract.fnName}): uses unverifiable spread in options argument for ${corePath}`,
            );
          }
          if (!hasUnverifiableSpread) {
            for (const inputKey of contract.inputKeys) {
              if (passedKeys.has(inputKey)) continue;
              const allowKey = `${shellPath}|${owner}|${contract.fnName}|${inputKey}`;
              if (allowedOmittedInputs.has(allowKey)) {
                usedInputAllowlistKeys.add(allowKey);
                continue;
              }
              violations.push(
                `${shellPath} (${owner} -> ${contract.fnName}): drops core input option "${inputKey}" defined in ${corePath}`,
              );
            }
          }
        }

        if (optionsArg?.type === 'identifier') {
          const paramType = findParameterTypeNode(ownerFn, optionsArg.text);
          const declaredKeys = shellResolver.resolveNode(paramType);
          for (const inputKey of contract.inputKeys) {
            if (declaredKeys.has(inputKey)) continue;
            const allowKey = `${shellPath}|${owner}|${contract.fnName}|${inputKey}`;
            if (allowedOmittedInputs.has(allowKey)) {
              usedInputAllowlistKeys.add(allowKey);
              continue;
            }
            violations.push(
              `${shellPath} (${owner} -> ${contract.fnName}): options type omits core input option "${inputKey}" defined in ${corePath}`,
            );
          }
        }

        if (optionsArg && optionsArg.type !== 'object' && optionsArg.type !== 'identifier') {
          violations.push(
            `${shellPath} (${owner} -> ${contract.fnName}): passes unverifiable ${optionsArg.type} argument for ${corePath}`,
          );
        }
      }

      const { bindingName, scopeNode } = findDescriptorBinding(callNode);
      const ownerReads = readsByOwner.get(owner) ?? new Set<string>();
      if (bindingName) {
        for (const readProp of collectBindingPropertyReads(scopeNode, bindingName, localFunctions)) {
          ownerReads.add(readProp);
        }
      }
      readsByOwner.set(owner, ownerReads);
    }

    for (const [owner, ownerReads] of readsByOwner.entries()) {
      for (const outputKey of contract.outputKeys) {
        if (ownerReads.has(outputKey)) continue;
        const allowKey = `${shellPath}|${owner}|${contract.fnName}|${outputKey}`;
        if (allowedUnreadOutputs.has(allowKey)) {
          usedOutputAllowlistKeys.add(allowKey);
          continue;
        }
        violations.push(
          `${shellPath} (${owner} -> ${contract.fnName}): ignores core descriptor field "${outputKey}" defined in ${corePath}`,
        );
      }
    }
  }

  return { violations, usedInputAllowlistKeys, usedOutputAllowlistKeys };
}

test('every public/ui core option and descriptor field is consumed by both imperative and Solid shells', async () => {
  const { tsParser, tsxParser } = await loadParsers();
  const coreFiles = fs
    .readdirSync(UI_DIR)
    .filter((fileName) => fileName.endsWith('-core.ts'))
    .sort();

  assert.ok(coreFiles.length >= 18, `expected at least 18 cores under public/ui/, found ${coreFiles.length}`);

  const allViolations: string[] = [];
  const usedInputAllowlistKeys = new Set<string>();
  const usedOutputAllowlistKeys = new Set<string>();

  for (const coreFile of coreFiles) {
    const baseName = coreFile.replace(/-core\.ts$/, '');
    const coreRelPath = `public/ui/${coreFile}`;
    const coreSource = fs.readFileSync(path.join(UI_DIR, coreFile), 'utf8');
    const coreTree = tsParser.parse(coreSource);
    assert.ok(coreTree, `failed to parse ${coreRelPath}`);
    const contracts = extractCoreContracts(coreTree.rootNode);
    assert.ok(contracts.length > 0, `${coreRelPath}: expected at least one exported *Descriptor or *Attributes function`);

    const solidFile = `${kebabToPascal(baseName)}.tsx`;
    const solidFullPath = path.join(UI_DIR, solidFile);
    if (!fs.existsSync(solidFullPath)) {
      allViolations.push(`${coreRelPath}: missing Solid shell public/ui/${solidFile}`);
    }
    if (fs.existsSync(solidFullPath)) {
      const solidTree = tsxParser.parse(fs.readFileSync(solidFullPath, 'utf8'));
      assert.ok(solidTree, `failed to parse public/ui/${solidFile}`);
      const solidAudit = auditShellAgainstCore(
        coreRelPath,
        `public/ui/${solidFile}`,
        contracts,
        coreTree.rootNode,
        solidTree.rootNode,
        ALLOWED_OMITTED_INPUTS,
        ALLOWED_UNREAD_OUTPUTS,
      );
      allViolations.push(...solidAudit.violations);
      for (const key of solidAudit.usedInputAllowlistKeys) usedInputAllowlistKeys.add(key);
      for (const key of solidAudit.usedOutputAllowlistKeys) usedOutputAllowlistKeys.add(key);
    }

    if (SOLID_ONLY_CORES.has(baseName)) continue;

    const imperativeFile = `${baseName}.ts`;
    const imperativeFullPath = path.join(UI_DIR, imperativeFile);
    if (!fs.existsSync(imperativeFullPath)) {
      allViolations.push(`${coreRelPath}: missing imperative shell public/ui/${imperativeFile}`);
      continue;
    }
    const imperativeTree = tsParser.parse(fs.readFileSync(imperativeFullPath, 'utf8'));
    assert.ok(imperativeTree, `failed to parse public/ui/${imperativeFile}`);
    const imperativeAudit = auditShellAgainstCore(
      coreRelPath,
      `public/ui/${imperativeFile}`,
      contracts,
      coreTree.rootNode,
      imperativeTree.rootNode,
      ALLOWED_OMITTED_INPUTS,
      ALLOWED_UNREAD_OUTPUTS,
    );
    allViolations.push(...imperativeAudit.violations);
    for (const key of imperativeAudit.usedInputAllowlistKeys) usedInputAllowlistKeys.add(key);
    for (const key of imperativeAudit.usedOutputAllowlistKeys) usedOutputAllowlistKeys.add(key);
  }

  for (const allowKey of ALLOWED_OMITTED_INPUTS.keys()) {
    if (!usedInputAllowlistKeys.has(allowKey)) {
      allViolations.push(`stale ALLOWED_OMITTED_INPUTS entry: ${allowKey}`);
    }
  }
  for (const allowKey of ALLOWED_UNREAD_OUTPUTS.keys()) {
    if (!usedOutputAllowlistKeys.has(allowKey)) {
      allViolations.push(`stale ALLOWED_UNREAD_OUTPUTS entry: ${allowKey}`);
    }
  }

  assert.deepEqual(
    allViolations,
    [],
    `UI shell parity violations (every core option and descriptor field must reach both shells):\n  ${allViolations.join('\n  ')}`,
  );
});

test('ui-shell-parity gate catches dropped inputs, unread outputs, non-first options params, sibling type leaks, and spreads', async () => {
  const { tsParser, tsxParser } = await loadParsers();
  const sampleCore = `
    type WidgetOptions = { label: string; shape?: 'box' | 'pill' };
    type WidgetDescriptor = { readonly className: 'ui-widget'; readonly shape?: 'pill' };
    export function widgetDescriptor(options: WidgetOptions): WidgetDescriptor {
      return { className: 'ui-widget', ...(options.shape === 'pill' ? { shape: 'pill' } : {}) };
    }
    export type Tone = 'neutral' | 'accent';
    type InlineDescriptor = { readonly text: string; readonly tone?: 'accent' };
    export function inlineDescriptor(text: string, options: { tone?: Tone } = {}): InlineDescriptor {
      return { text, tone: options.tone === 'accent' ? 'accent' : undefined };
    }
  `;
  const coreTree = tsParser.parse(sampleCore);
  assert.ok(coreTree);
  const contracts = extractCoreContracts(coreTree.rootNode);
  const widgetContracts = contracts.filter((contract) => contract.fnName === 'widgetDescriptor');
  const inlineContracts = contracts.filter((contract) => contract.fnName === 'inlineDescriptor');

  const solidPassedButUnrendered = `
    export function Widget(props: { label: string; shape?: 'box' | 'pill' }) {
      const descriptor = createMemo(() => widgetDescriptor({ label: props.label, shape: props.shape }));
      return <div class={descriptor().className} />;
    }
  `;
  const solidUnrenderedTree = tsxParser.parse(solidPassedButUnrendered);
  assert.ok(solidUnrenderedTree);
  const solidUnrenderedResult = auditShellAgainstCore(
    'public/ui/widget-core.ts',
    'public/ui/Widget.tsx',
    widgetContracts,
    coreTree.rootNode,
    solidUnrenderedTree.rootNode,
    new Map(),
    new Map(),
  );
  assert.equal(solidUnrenderedResult.violations.length, 1);
  assert.match(solidUnrenderedResult.violations[0], /public\/ui\/Widget\.tsx.*ignores core descriptor field "shape"/);

  const imperativeSiblingLeak = `
    type OtherOptions = { shape?: 'box' | 'pill' };
    type WidgetShellOptions = { label: string };
    export function widget(options: WidgetShellOptions) {
      const descriptor = widgetDescriptor(options);
      return [descriptor.className, descriptor.shape];
    }
  `;
  const siblingTree = tsParser.parse(imperativeSiblingLeak);
  assert.ok(siblingTree);
  const siblingResult = auditShellAgainstCore(
    'public/ui/widget-core.ts',
    'public/ui/widget.ts',
    widgetContracts,
    coreTree.rootNode,
    siblingTree.rootNode,
    new Map(),
    new Map(),
  );
  assert.equal(siblingResult.violations.length, 1);
  assert.match(siblingResult.violations[0], /public\/ui\/widget\.ts.*options type omits core input option "shape"/);

  const solidSpreadOmit = `
    export function Widget(props: { label: string }) {
      const descriptor = createMemo(() => widgetDescriptor({ ...props }));
      return <div class={descriptor().className} data-shape={descriptor().shape} />;
    }
  `;
  const spreadTree = tsxParser.parse(solidSpreadOmit);
  assert.ok(spreadTree);
  const spreadResult = auditShellAgainstCore(
    'public/ui/widget-core.ts',
    'public/ui/Widget.tsx',
    widgetContracts,
    coreTree.rootNode,
    spreadTree.rootNode,
    new Map(),
    new Map(),
  );
  assert.equal(spreadResult.violations.length, 1);
  assert.match(spreadResult.violations[0], /public\/ui\/Widget\.tsx.*drops core input option "shape"/);

  const solidTypeAssertion = `
    export function Widget(props: { label: string }) {
      const descriptor = createMemo(() => widgetDescriptor(props as never));
      return <div class={descriptor().className} data-shape={descriptor().shape} />;
    }
  `;
  const castTree = tsxParser.parse(solidTypeAssertion);
  assert.ok(castTree);
  const castResult = auditShellAgainstCore(
    'public/ui/widget-core.ts',
    'public/ui/Widget.tsx',
    widgetContracts,
    coreTree.rootNode,
    castTree.rootNode,
    new Map(),
    new Map(),
  );
  assert.equal(castResult.violations.length, 1);
  assert.match(castResult.violations[0], /public\/ui\/Widget\.tsx.*unverifiable as_expression/);

  const solidInlineDrop = `
    export function Inline(props: { text: string }) {
      const descriptor = createMemo(() => inlineDescriptor(props.text));
      return <kbd data-tone={descriptor().tone}>{descriptor().text}</kbd>;
    }
  `;
  const inlineTree = tsxParser.parse(solidInlineDrop);
  assert.ok(inlineTree);
  const inlineResult = auditShellAgainstCore(
    'public/ui/inline-core.ts',
    'public/ui/Inline.tsx',
    inlineContracts,
    coreTree.rootNode,
    inlineTree.rootNode,
    new Map(),
    new Map(),
  );
  assert.equal(inlineResult.violations.length, 1);
  assert.match(inlineResult.violations[0], /public\/ui\/Inline\.tsx.*omits options argument carrying "tone"/);
});
