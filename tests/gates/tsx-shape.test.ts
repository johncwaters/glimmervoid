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

const DOM_OR_HOST_TYPE_PATTERN = /\b(Element|HTMLElement|HTML\w+Element|SVG\w*Element|EventTarget|KeyboardEvent|MouseEvent|PointerEvent|FocusEvent|ToggleEvent|ChatFeed|AbortController)\b/;

interface TrackedTsxFile {
  path: string;
  content: string;
}

interface BranchOwnerCount {
  name: string;
  count: number;
}

interface TsxShapeReport {
  hasSyntaxError: boolean;
  score: number;
  stateCount: number;
  branchCount: number;
  stateNames: string[];
  branchOwners: BranchOwnerCount[];
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

function isSignalInitializer(node: Node): boolean {
  let ancestor = node.parent;
  while (ancestor && ancestor.type === 'arguments') ancestor = ancestor.parent;
  if (ancestor?.type !== 'call_expression') return false;
  const calleeName = ancestor.childForFieldName('function')?.text ?? '';
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
        stateNames: [],
        branchOwners: [],
      };
    }

    const mutatedArrayNames = collectMutatedArrayNames(rootNode);
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
      score: stateNames.length + branchCount,
      stateCount: stateNames.length,
      branchCount,
      stateNames,
      branchOwners,
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
    const overflow = report.stateNames.length > MAX_REPORTED_OFFENDERS ? `, +${report.stateNames.length - MAX_REPORTED_OFFENDERS} more` : '';
    parts.push(`state: ${shown}${overflow}`);
  }
  if (report.branchOwners.length > 0) {
    const shown = report.branchOwners
      .slice(0, MAX_REPORTED_OFFENDERS)
      .map((entry) => `${entry.name} (${entry.count})`)
      .join(', ');
    const overflow = report.branchOwners.length > MAX_REPORTED_OFFENDERS ? `, +${report.branchOwners.length - MAX_REPORTED_OFFENDERS} more` : '';
    parts.push(`decisions: ${shown}${overflow}`);
  }
  return parts.join('; ');
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
          `${sourceFile.path}: tsx-shape score ${report.score} exceeds new-file budget ${NEW_TSX_SHAPE_BUDGET} (${report.stateCount} state, ${report.branchCount} branches; ${formatOffenders(report)}) -> move state and decisions to ${corePath}`,
        );
      }
      continue;
    }

    if (report.score > recordedScore) {
      violations.push(
        `${sourceFile.path}: tsx-shape score ${report.score} exceeds recorded ${recordedScore} (${report.stateCount} state, ${report.branchCount} branches; ${formatOffenders(report)}) -> move state and decisions to ${corePath}`,
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
