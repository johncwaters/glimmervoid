import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateStateAction,
  generateStateCollection,
  renderActionTemplate,
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
  return scratchRoot;
}

test('state:new-action generates deterministic module, updates ratchets, and refuses invalid or duplicate input', (testContext) => {
  const firstRoot = createTempRepoRoot();
  const secondRoot = createTempRepoRoot();
  testContext.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  const firstRun = generateStateAction('rename-session', firstRoot);
  const secondRun = generateStateAction('rename-session', secondRoot);
  assert.equal(firstRun.content, secondRun.content);
  assert.equal(firstRun.content, renderActionTemplate('rename-session'));
  assert.equal(fs.readFileSync(firstRun.filePath, 'utf8'), firstRun.content);

  const updatedRatchets = JSON.parse(
    fs.readFileSync(path.join(firstRoot, STATE_RATCHETS_RELATIVE_PATH), 'utf8'),
  ) as StateRatchetData;
  assert.equal(updatedRatchets.legacyMutatingActions.includes('rename-session'), false);

  assert.throws(() => generateStateAction('rename-session', firstRoot), /already exists/);
  assert.throws(() => generateStateAction('ping', firstRoot), /classified as "signal", not "mutating"/);
  assert.throws(() => generateStateAction('get-settings', firstRoot), /classified as "read", not "mutating"/);
  assert.throws(() => generateStateAction('does-not-exist', firstRoot), /Unknown client message type/);
  assert.throws(() => generateStateAction(undefined, firstRoot), /Missing client message type/);
});

test('state:new-collection generates deterministic module, updates ratchets, and refuses invalid or duplicate input', (testContext) => {
  const firstRoot = createTempRepoRoot();
  const secondRoot = createTempRepoRoot();
  testContext.after(() => {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  const firstRun = generateStateCollection('sessions', firstRoot);
  const secondRun = generateStateCollection('sessions', secondRoot);
  assert.equal(firstRun.content, secondRun.content);
  assert.equal(firstRun.content, renderCollectionTemplate('sessions'));
  assert.equal(fs.readFileSync(firstRun.filePath, 'utf8'), firstRun.content);

  const updatedRatchets = JSON.parse(
    fs.readFileSync(path.join(firstRoot, STATE_RATCHETS_RELATIVE_PATH), 'utf8'),
  ) as StateRatchetData;
  assert.equal(updatedRatchets.legacyCollections.includes('sessions'), false);

  assert.throws(() => generateStateCollection('sessions', firstRoot), /already exists/);
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

  assert.throws(() => generateStateAction('rename-session', malformedRoot), /missing legacyMutatingActions/);
  assert.equal(fs.existsSync(path.join(malformedRoot, 'public/state/actions/rename-session.ts')), false);
  assert.throws(() => generateStateCollection('sessions', malformedRoot), /missing legacyMutatingActions/);
  assert.equal(fs.existsSync(path.join(malformedRoot, 'public/state/collections/sessions.ts')), false);
});
