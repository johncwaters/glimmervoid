import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  CONTINUITY_CASES_RELATIVE_PATH,
  generateStateAction,
  generateStateCollection,
  insertContinuityCaseStub,
  renderActionStubContinuityCase,
  renderActionTemplate,
  renderCollectionStubContinuityCase,
  renderCollectionTemplate,
} from '../scripts/state-generator.ts';
import { STATE_RATCHETS_RELATIVE_PATH } from '../scripts/state-inventory.ts';
import type { StateRatchetData } from '../scripts/state-inventory.ts';

function createTempRepoRoot(): string {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-state-gen-'));
  const sourceRatchets = path.join(import.meta.dirname, '..', STATE_RATCHETS_RELATIVE_PATH);
  const targetRatchets = path.join(scratchRoot, STATE_RATCHETS_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(targetRatchets), { recursive: true });
  fs.copyFileSync(sourceRatchets, targetRatchets);
  const sourceCases = path.join(import.meta.dirname, '..', CONTINUITY_CASES_RELATIVE_PATH);
  const targetCases = path.join(scratchRoot, CONTINUITY_CASES_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(targetCases), { recursive: true });
  fs.copyFileSync(sourceCases, targetCases);
  return scratchRoot;
}

test('state:new-action generates deterministic module, updates ratchets, writes failing stub continuity case, and refuses invalid or duplicate input', (testContext) => {
  const firstRoot = createTempRepoRoot();
  const secondRoot = createTempRepoRoot();
  testContext.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  const firstRun = generateStateAction('kill', firstRoot);
  const secondRun = generateStateAction('kill', secondRoot);
  assert.equal(firstRun.content, secondRun.content);
  assert.equal(firstRun.content, renderActionTemplate('kill'));
  assert.equal(fs.readFileSync(firstRun.filePath, 'utf8'), firstRun.content);

  const firstCases = fs.readFileSync(path.join(firstRoot, CONTINUITY_CASES_RELATIVE_PATH), 'utf8');
  const secondCases = fs.readFileSync(path.join(secondRoot, CONTINUITY_CASES_RELATIVE_PATH), 'utf8');
  assert.equal(firstCases, secondCases);
  assert.equal(firstCases.includes(renderActionStubContinuityCase('kill')), true);
  assert.equal(firstCases.includes("    checks: ['C1', 'C2', 'C5'],"), true);
  assert.equal(firstCases.includes('    stub: true,'), true);

  const updatedRatchets = JSON.parse(
    fs.readFileSync(path.join(firstRoot, STATE_RATCHETS_RELATIVE_PATH), 'utf8'),
  ) as StateRatchetData;
  assert.equal(updatedRatchets.legacyMutatingActions.includes('kill'), false);

  assert.throws(() => generateStateAction('kill', firstRoot), /already exists/);
  assert.throws(() => generateStateAction('rename-session', firstRoot), /Continuity case "rename-session" already exists/);
  assert.throws(() => generateStateAction('ping', firstRoot), /classified as "signal", not "mutating"/);
  assert.throws(() => generateStateAction('get-settings', firstRoot), /classified as "read", not "mutating"/);
  assert.throws(() => generateStateAction('does-not-exist', firstRoot), /Unknown client message type/);
  assert.throws(() => generateStateAction(undefined, firstRoot), /Missing client message type/);
});

test('state:new-collection generates deterministic module, updates ratchets, writes failing stub continuity case, and refuses invalid or duplicate input', (testContext) => {
  const firstRoot = createTempRepoRoot();
  const secondRoot = createTempRepoRoot();
  testContext.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  const firstRun = generateStateCollection('health', firstRoot);
  const secondRun = generateStateCollection('health', secondRoot);
  assert.equal(firstRun.content, secondRun.content);
  assert.equal(firstRun.content, renderCollectionTemplate('health'));
  assert.equal(fs.readFileSync(firstRun.filePath, 'utf8'), firstRun.content);

  const firstCases = fs.readFileSync(path.join(firstRoot, CONTINUITY_CASES_RELATIVE_PATH), 'utf8');
  const secondCases = fs.readFileSync(path.join(secondRoot, CONTINUITY_CASES_RELATIVE_PATH), 'utf8');
  assert.equal(firstCases, secondCases);
  assert.equal(firstCases.includes(renderCollectionStubContinuityCase('health')), true);
  assert.equal(firstCases.includes("    checks: ['C3', 'C4'],"), true);
  assert.equal(firstCases.includes('    stub: true,'), true);

  const updatedRatchets = JSON.parse(
    fs.readFileSync(path.join(firstRoot, STATE_RATCHETS_RELATIVE_PATH), 'utf8'),
  ) as StateRatchetData;
  assert.equal(updatedRatchets.legacyCollections.includes('health'), false);

  assert.throws(() => generateStateCollection('health', firstRoot), /already exists/);
  assert.throws(() => generateStateCollection('sessions', firstRoot), /Continuity case "sessions" already exists/);
  assert.throws(() => generateStateCollection('not-a-collection', firstRoot), /Unknown collection/);
  assert.throws(() => generateStateCollection(undefined, firstRoot), /Missing collection name/);
});

test('generator emits no unused named exports and leaves no orphan module on invalid ratchets', (testContext) => {
  assert.equal(/\bexport\s+(?:type|interface)\b/.test(renderActionTemplate('rename-session')), false);
  assert.equal(/\bexport\s+(?:type|interface)\b/.test(renderCollectionTemplate('sessions')), false);

  const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-state-gen-bad-'));
  testContext.after(() => {
    fs.rmSync(malformedRoot, { recursive: true, force: true });
  });
  const ratchetsPath = path.join(malformedRoot, STATE_RATCHETS_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(ratchetsPath), { recursive: true });
  fs.writeFileSync(ratchetsPath, '{}\n', 'utf8');

  assert.throws(() => generateStateAction('kill', malformedRoot), /missing legacyMutatingActions/);
  assert.equal(fs.existsSync(path.join(malformedRoot, 'public/state/actions/kill.ts')), false);
  assert.throws(() => generateStateCollection('health', malformedRoot), /missing legacyMutatingActions/);
  assert.equal(fs.existsSync(path.join(malformedRoot, 'public/state/collections/health.ts')), false);
});

test('insertContinuityCaseStub preserves CRLF, handles reordered properties, and detects named constant duplicates', () => {
  const crlfFixture = [
    'const SAVE_HOOK_CASE = {',
    "  checks: ['C1', 'C2', 'C5'],",
    "  name: 'save-hook',",
    '};',
    'export const ACTION_CONTINUITY_STUBS: readonly ActionContinuityCase[] = [',
    '  {',
    "    checks: ['C1', 'C2', 'C5'],",
    "    name: 'add-repo-roots',",
    '  },',
    '  SAVE_HOOK_CASE,',
    '  {',
    "    checks: ['C1', 'C2', 'C5'],",
    "    name: 'update-settings',",
    '  },',
    '];',
    '',
  ].join('\r\n');

  const inserted = insertContinuityCaseStub(
    crlfFixture,
    'action',
    'kill',
    renderActionStubContinuityCase('kill'),
  );

  assert.equal(inserted.includes('\r\n'), true);
  assert.equal(/(?<!\r)\n/.test(inserted), false);
  assert.ok(inserted.indexOf("name: 'add-repo-roots'") < inserted.indexOf("name: 'kill'"));
  assert.ok(inserted.indexOf("name: 'kill'") < inserted.indexOf('  SAVE_HOOK_CASE,'));
  assert.throws(
    () => insertContinuityCaseStub(crlfFixture, 'action', 'save-hook', renderActionStubContinuityCase('save-hook')),
    /Continuity case "save-hook" already exists/,
  );
});

test('state:new-action and state:new-collection insert stubs inside empty single-line stub arrays as valid TypeScript', (testContext) => {
  const scratchRoot = createTempRepoRoot();
  testContext.after(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });
  const stubsPath = path.join(scratchRoot, CONTINUITY_CASES_RELATIVE_PATH);
  const emptySingleLineStubs = [
    "import type { ActionContinuityCase, CollectionContinuityCase } from './continuity-cases.ts';",
    '',
    'export const ACTION_CONTINUITY_STUBS: readonly ActionContinuityCase[] = [];',
    '',
    'export const COLLECTION_CONTINUITY_STUBS: readonly CollectionContinuityCase[] = [];',
    '',
  ].join('\n');
  fs.writeFileSync(stubsPath, emptySingleLineStubs, 'utf8');

  generateStateAction('kill', scratchRoot);
  generateStateCollection('health', scratchRoot);

  const generated = fs.readFileSync(stubsPath, 'utf8');
  assert.equal(
    generated,
    [
      "import type { ActionContinuityCase, CollectionContinuityCase } from './continuity-cases.ts';",
      '',
      'export const ACTION_CONTINUITY_STUBS: readonly ActionContinuityCase[] = [',
      renderActionStubContinuityCase('kill'),
      '];',
      '',
      'export const COLLECTION_CONTINUITY_STUBS: readonly CollectionContinuityCase[] = [',
      renderCollectionStubContinuityCase('health'),
      '];',
      '',
    ].join('\n'),
  );
  const stripped = stripTypeScriptTypes(generated, { mode: 'strip' }).replace(/^\s*export\s+/gm, '');
  assert.doesNotThrow(() => new vm.Script(stripped));
});
