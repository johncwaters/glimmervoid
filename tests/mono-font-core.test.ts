import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyTerminalFontFamily, BUNDLED_MONO_FONT_FACES, BUNDLED_MONO_FONT_NAME, terminalFontFamily, whenEveryFaceLoads } from '../public/mono-font-core.ts';
import type { FontRefreshableTerminalEntry, MonoFontSet } from '../public/mono-font-core.ts';

function readPublicSource(relativePath: string): string {
  return readFileSync(path.join(import.meta.dirname, '..', 'public', relativePath), 'utf8');
}

const DASHBOARD_STYLESHEET = readPublicSource('style.css');
const CSS_FONT_STACK = /--font-mono:([^;]+);/.exec(DASHBOARD_STYLESHEET)?.[1] ?? '';

function unquoted(familyName: string): string {
  return familyName.trim().replace(/^['"]|['"]$/g, '');
}

function terminalEntryCountingSyncs(fontFamily: string) {
  const entry = { term: { options: { fontFamily } }, syncCount: 0, _syncGrid: () => { entry.syncCount++; } };
  return entry;
}

function fontSetRecordingLoads(loadOutcome: (face: string) => Promise<unknown>) {
  const requestedFaces: string[] = [];
  const fontSet: MonoFontSet = { load: (face) => { requestedFaces.push(face); return loadOutcome(face); } };
  return { fontSet, requestedFaces };
}

test('a loaded bundled font leads the terminal font stack', () => {
  assert.equal(terminalFontFamily(CSS_FONT_STACK, true), "'CommitMono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace");
});

test('an unloaded bundled font is left out so the terminal measures the face it will draw', () => {
  assert.equal(terminalFontFamily(CSS_FONT_STACK, false), "'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace");
});

test('the bundled font is recognized unquoted or double quoted', () => {
  assert.equal(terminalFontFamily('CommitMono, Menlo', false), 'Menlo');
  assert.equal(terminalFontFamily('"CommitMono", Menlo', false), 'Menlo');
});

test('an empty or unresolved stack falls back to plain monospace', () => {
  assert.equal(terminalFontFamily('', true), 'monospace');
  assert.equal(terminalFontFamily("'CommitMono'", false), 'monospace');
});

test('every font-face in the style sheet declares the bundled font name', () => {
  const declaredFamilies = [...DASHBOARD_STYLESHEET.matchAll(/@font-face\s*\{[^}]*?font-family:\s*([^;]+);/g)].map((match) => unquoted(match[1] ?? ''));
  assert.ok(declaredFamilies.length > 0);
  assert.deepEqual(declaredFamilies.filter((family) => family !== BUNDLED_MONO_FONT_NAME), []);
});

test('the font-mono stack is led by the bundled font name', () => {
  assert.equal(unquoted(CSS_FONT_STACK.split(',')[0] ?? ''), BUNDLED_MONO_FONT_NAME);
});

test('every bundled face string names the bundled font family', () => {
  assert.ok(BUNDLED_MONO_FONT_FACES.length > 0);
  assert.deepEqual(BUNDLED_MONO_FONT_FACES.filter((face) => !face.endsWith(` ${BUNDLED_MONO_FONT_NAME}`)), []);
});

test('the dashboard loader takes its face list from the shared core', () => {
  assert.doesNotMatch(readPublicSource('mono-font.ts'), /const BUNDLED_MONO_FONT_FACES/);
});

test('once every bundled face loads, each live terminal switches to the full stack and re-measures once', async () => {
  const fallbackFamily = terminalFontFamily(CSS_FONT_STACK, false);
  const terminals = [terminalEntryCountingSyncs(fallbackFamily), terminalEntryCountingSyncs(fallbackFamily)];
  const { fontSet, requestedFaces } = fontSetRecordingLoads(() => Promise.resolve([]));
  await whenEveryFaceLoads(fontSet, BUNDLED_MONO_FONT_FACES, () => applyTerminalFontFamily(terminals, terminalFontFamily(CSS_FONT_STACK, true)));
  assert.deepEqual(requestedFaces, BUNDLED_MONO_FONT_FACES);
  assert.deepEqual(terminals.map((terminal) => terminal.term.options.fontFamily), [CSS_FONT_STACK.trim(), CSS_FONT_STACK.trim()]);
  assert.deepEqual(terminals.map((terminal) => terminal.syncCount), [1, 1]);
});

test('a rejected face load never fires the callback and leaves terminals on the fallback stack', async () => {
  const fallbackFamily = terminalFontFamily(CSS_FONT_STACK, false);
  const terminal = terminalEntryCountingSyncs(fallbackFamily);
  const { fontSet } = fontSetRecordingLoads((face) => (face.startsWith('700') ? Promise.reject(new Error('font load failed')) : Promise.resolve([])));
  let loadedCallbackCount = 0;
  await whenEveryFaceLoads(fontSet, BUNDLED_MONO_FONT_FACES, () => { loadedCallbackCount++; applyTerminalFontFamily([terminal], terminalFontFamily(CSS_FONT_STACK, true)); });
  assert.equal(loadedCallbackCount, 0);
  assert.equal(terminal.term.options.fontFamily, fallbackFamily);
  assert.equal(terminal.syncCount, 0);
});

test('entries without a terminal are skipped when the font family is applied', () => {
  const entriesWithoutTerminal: FontRefreshableTerminalEntry[] = [{ term: null }, {}];
  const terminal = terminalEntryCountingSyncs('monospace');
  assert.doesNotThrow(() => applyTerminalFontFamily([...entriesWithoutTerminal, terminal], 'Menlo'));
  assert.equal(terminal.term.options.fontFamily, 'Menlo');
  assert.equal(terminal.syncCount, 1);
});

test('the dashboard refreshes terminal fonts when the bundled font loads', () => {
  assert.match(readPublicSource('app.ts'), /^whenBundledMonoFontLoads\(refreshTerminalFonts\);$/m);
});

test('refreshing terminal fonts applies the current family to every session terminal', () => {
  assert.match(readPublicSource('session-card/lifecycle.ts'), /export function refreshTerminalFonts\(\) \{\n {2}applyTerminalFontFamily\(sessionUIs\.values\(\), currentTerminalFontFamily\(\)\);\n\}/);
});

test('the bundled font loader waits on every bundled face through the shared core', () => {
  assert.match(readPublicSource('mono-font.ts'), /whenEveryFaceLoads\(document\.fonts, BUNDLED_MONO_FONT_FACES, onLoaded\)/);
});
