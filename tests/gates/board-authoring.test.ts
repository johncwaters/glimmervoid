import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const BOARD_EDIT_PATH = 'public/whiteboard/board-edit.ts';
const BOARD_RENDERER_PATH = 'public/whiteboard/board-gl-renderer.ts';
const BOARDS_VIEW_PATH = 'public/whiteboard/boards-view.ts';
const BOARD_INSPECT_PATH = 'public/whiteboard/board-inspect.ts';

const ALLOWED_BOARD_TOOLS = ['eraser', 'hand', 'note', 'pen', 'select'];
const ALLOWED_GESTURE_KINDS = ['drag', 'erase', 'ink', 'marquee', 'pan', 'pinch'];
const ALLOWED_HIT_PARTS = ['body', 'media'];
const ALLOWED_MENU_LABELS = new Set([
  'Bring forward',
  'Bring to front',
  'Copy',
  'Cut',
  'Delete',
  'Duplicate',
  'Fit',
  'Frame',
  'Paste',
  'Select all',
  'Send backward',
  'Send to back',
  'Stack',
]);
const ALLOWED_INSPECTOR_SET_KEYS = new Set([
  'autoplay',
  'backdrop',
  'borderless',
  'change',
  'collapsed',
  'dashed',
  'device',
  'feeds',
  'fit',
  'flow',
  'fromSide',
  'fullBleed',
  'label',
  'media',
  'params',
  'place',
  'refs',
  'step',
  'title',
  'titleGradient',
  'toSide',
  'was',
]);

const RULE_AND_FIX = 'Board rule: agents create and restyle elements through whiteboard ops; the operator only annotates (pan, zoom, select, move, delete, mark up, answer an ask, open a card). Fix: remove the operator authoring path and expose the capability through whiteboard ops instead.';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function splitTopLevelUnionArms(unionBody: string): string[] {
  const cleaned = stripComments(unionBody);
  const arms: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let armStart = 0;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === '{') braceDepth += 1;
    if (char === '}') braceDepth -= 1;
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth -= 1;
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;
    if (char !== '|' || braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) continue;
    const arm = cleaned.slice(armStart, index).trim();
    if (arm.length > 0) arms.push(arm);
    armStart = index + 1;
  }
  const trailingArm = cleaned.slice(armStart).trim();
  if (trailingArm.length > 0) arms.push(trailingArm);
  return arms;
}

function parseLiteralUnionArms(unionBody: string, unionName: string, filePath: string): string[] {
  const arms = splitTopLevelUnionArms(unionBody);
  assert.ok(arms.length > 0, `expected ${unionName} arms in ${filePath} so this gate cannot pass vacuously`);
  return arms.map((arm) => {
    const literalMatch = /^(['"])([^'"]+)\1$/.exec(arm);
    assert.ok(literalMatch, `${filePath} ${unionName} contains non-literal arm (${arm}). ${RULE_AND_FIX}`);
    return literalMatch[2];
  }).sort();
}

function extractFunctionBody(source: string, functionName: string): string {
  const declaration = new RegExp(`function ${functionName}\\b[^{]*\\{`);
  const match = declaration.exec(source);
  assert.ok(match, `expected function ${functionName} to exist so this gate cannot pass vacuously`);
  let depth = 0;
  let index = match.index + match[0].length - 1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  assert.fail(`unclosed function body for ${functionName}`);
}

function extractBalancedObject(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(openBraceIndex, index + 1);
  }
  assert.fail('unclosed object literal in set() call');
}

function topLevelObjectKeys(objectLiteral: string): string[] {
  const inner = stripComments(objectLiteral.slice(1, -1));
  const keys: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let entryStart = 0;
  for (let index = 0; index <= inner.length; index += 1) {
    const char = inner[index];
    if (char === '{') braceDepth += 1;
    if (char === '}') braceDepth -= 1;
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth -= 1;
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;
    if (index < inner.length && (char !== ',' || braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0)) continue;
    const entry = inner.slice(entryStart, index).trim();
    entryStart = index + 1;
    if (entry.length === 0) continue;
    const keyMatch = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(entry);
    assert.ok(keyMatch, `unsupported dynamic or spread property (${entry}) in board-inspect set() call. ${RULE_AND_FIX}`);
    keys.push(keyMatch[1]);
  }
  return keys;
}

test('BoardTool union keeps only the five operator annotation and navigation tools', () => {
  const source = readSource(BOARD_EDIT_PATH);
  const unionMatch = /type BoardTool\s*=\s*([^;]+);/.exec(source);
  assert.ok(unionMatch, `expected type BoardTool in ${BOARD_EDIT_PATH} so this gate cannot pass vacuously`);
  const tools = parseLiteralUnionArms(unionMatch[1], 'BoardTool', BOARD_EDIT_PATH);
  assert.deepEqual(tools, ALLOWED_BOARD_TOOLS, `${BOARD_EDIT_PATH} BoardTool changed. ${RULE_AND_FIX}`);
});

test('board-edit Gesture union, editTitle guard, and listeners expose no operator authoring gesture or non-note text edit', () => {
  const source = readSource(BOARD_EDIT_PATH);
  const gestureMatch = /type Gesture\s*=\s*([\s\S]*?);(?=\r?\n)/.exec(source);
  assert.ok(gestureMatch, `expected type Gesture in ${BOARD_EDIT_PATH} so this gate cannot pass vacuously`);
  const nonNullArms = splitTopLevelUnionArms(gestureMatch[1]).filter((arm) => arm !== 'null');
  assert.ok(nonNullArms.length > 0, `expected non-null Gesture arms in ${BOARD_EDIT_PATH} so this gate cannot pass vacuously`);
  const gestureKinds = nonNullArms.map((arm) => {
    assert.ok(arm.startsWith('{') && arm.endsWith('}'), `${BOARD_EDIT_PATH} Gesture arm must be an inline object literal (${arm}). ${RULE_AND_FIX}`);
    const kindMatch = /\bkind:\s*(['"])([^'"]+)\1/.exec(arm);
    assert.ok(kindMatch, `${BOARD_EDIT_PATH} Gesture arm is missing a string literal kind (${arm}). ${RULE_AND_FIX}`);
    return kindMatch[2];
  }).sort();
  assert.deepEqual(gestureKinds, ALLOWED_GESTURE_KINDS, `${BOARD_EDIT_PATH} Gesture kinds changed. ${RULE_AND_FIX}`);
  assert.doesNotMatch(source, /\bdblclick\b/, `${BOARD_EDIT_PATH} added a dblclick listener. ${RULE_AND_FIX}`);
  assert.doesNotMatch(source, /\bevent\.detail\b/, `${BOARD_EDIT_PATH} added event.detail multi-click dispatch. ${RULE_AND_FIX}`);
  const editTitleBody = extractFunctionBody(source, 'editTitle');
  assert.match(editTitleBody, /titled\.shape\s*!==\s*['"]note['"]/, `${BOARD_EDIT_PATH} editTitle must stay restricted to note boxes. ${RULE_AND_FIX}`);
});

test('HitPart union exposes only body and media hit targets, with no authoring handles', () => {
  const source = readSource(BOARD_RENDERER_PATH);
  const hitPartMatch = /type HitPart\s*=\s*([^;]+);/.exec(source);
  assert.ok(hitPartMatch, `expected type HitPart in ${BOARD_RENDERER_PATH} so this gate cannot pass vacuously`);
  const hitParts = parseLiteralUnionArms(hitPartMatch[1], 'HitPart', BOARD_RENDERER_PATH);
  assert.deepEqual(hitParts, ALLOWED_HIT_PARTS, `${BOARD_RENDERER_PATH} HitPart changed. ${RULE_AND_FIX}`);
});

test('board context menus expose only allowlisted operator actions', () => {
  const source = readSource(BOARDS_VIEW_PATH);
  const menuBodies = [
    extractFunctionBody(source, 'selectionMenuGroups'),
    extractFunctionBody(source, 'canvasMenuGroups'),
  ];
  const labels: string[] = [];
  for (const body of menuBodies) {
    assert.doesNotMatch(body, /\.\.\./, `${BOARDS_VIEW_PATH} context menu must list items directly with no spread helpers. ${RULE_AND_FIX}`);
    for (const labelMatch of body.matchAll(/\blabel:\s*([^\n,}]+)/g)) {
      const rawValue = labelMatch[1].trim();
      const quoted = /^(['"])([^'"]+)\1$/.exec(rawValue);
      assert.ok(quoted, `${BOARDS_VIEW_PATH} context menu label must be a string literal (${rawValue}). ${RULE_AND_FIX}`);
      labels.push(quoted[2]);
    }
  }
  assert.ok(labels.length > 0, `expected context menu labels in ${BOARDS_VIEW_PATH} so this gate cannot pass vacuously`);
  const disallowedLabels = labels.filter((label) => !ALLOWED_MENU_LABELS.has(label));
  assert.deepEqual(disallowedLabels, [], `${BOARDS_VIEW_PATH} context menu exposed disallowed entries (${disallowedLabels.join(', ')}). ${RULE_AND_FIX}`);
});

test('board inspector keeps non-note box titles read-only and commits only allowlisted fields', () => {
  const source = readSource(BOARD_INSPECT_PATH);
  const boxSectionsBody = extractFunctionBody(source, 'boxSections');
  const noteTitleGate = /box\.shape\s*===\s*['"]note['"]\s*\?\s*titleField\([^)]+\)\s*:\s*heading\(box\.title\)/;
  assert.match(boxSectionsBody, noteTitleGate, `${BOARD_INSPECT_PATH} boxSections must keep non-note titles read-only with heading(box.title). ${RULE_AND_FIX}`);
  const committedKeys: string[] = [];
  for (const match of source.matchAll(/\bset\(\s*\{/g)) {
    const openBraceIndex = (match.index ?? 0) + match[0].length - 1;
    const objectLiteral = extractBalancedObject(source, openBraceIndex);
    committedKeys.push(...topLevelObjectKeys(objectLiteral));
  }
  assert.ok(committedKeys.length > 0, `expected set() calls in ${BOARD_INSPECT_PATH} so this gate cannot pass vacuously`);
  const disallowedKeys = [...new Set(committedKeys.filter((key) => !ALLOWED_INSPECTOR_SET_KEYS.has(key)))].sort();
  assert.deepEqual(disallowedKeys, [], `${BOARD_INSPECT_PATH} commits disallowed authoring fields (${disallowedKeys.join(', ')}). ${RULE_AND_FIX}`);
});
