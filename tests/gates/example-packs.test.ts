import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PackBridgeTopic } from '../../shared/contracts/pack-bridge.ts';
import { checkPack, packCheckHasProblem, packReportText } from '../../server/packs/pack-check.ts';
import { readPacksForAgent } from '../../server/packs/pack-agent.ts';

const EXAMPLE_PACKS_DIR = path.join(import.meta.dirname, '..', '..', 'examples', 'packs');
const PUBLISHED_SCHEMA_ID = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'site', 'public', 'schema', 'pack.v1.json'), 'utf8')).$id;
const exampleNames = fs.readdirSync(EXAMPLE_PACKS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

function manifestOf(exampleName: string) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLE_PACKS_DIR, exampleName, 'pack.json'), 'utf8'));
}

function subscribedTopicsIn(panelScript: string): string[] {
  const subscription = /glimmervoid\.subscribe\(\[([^\]]*)\]/.exec(panelScript);
  return subscription ? [...subscription[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
}

test('every example pack passes the same check an agent runs, with no problem', async () => {
  assert.ok(exampleNames.length >= 3);
  for (const exampleName of exampleNames) {
    const report = await checkPack(path.join(EXAMPLE_PACKS_DIR, exampleName), process.env, () => false);
    assert.equal(packCheckHasProblem(report), false, packReportText(report));
    assert.equal(manifestOf(exampleName).name, exampleName, 'an example folder is named after its pack');
    assert.equal(manifestOf(exampleName).$schema, PUBLISHED_SCHEMA_ID);
  }
});

test('every example panel subscribes to exactly the topics it declares and shares one bridge helper', () => {
  const bridgeHelpers = new Set<string>();
  for (const exampleName of exampleNames) {
    for (const panel of manifestOf(exampleName).ui?.panels ?? []) {
      const panelDir = path.join(EXAMPLE_PACKS_DIR, exampleName, path.dirname(panel.entry));
      const subscribed = subscribedTopicsIn(fs.readFileSync(path.join(panelDir, 'panel.js'), 'utf8'));
      assert.deepEqual([...subscribed].sort(), [...panel.reads].sort(), `${exampleName}/${panel.id}`);
      for (const topic of subscribed) assert.ok(PackBridgeTopic.safeParse(topic).success, topic);
      bridgeHelpers.add(fs.readFileSync(path.join(panelDir, 'bridge.js'), 'utf8'));
    }
  }
  assert.equal(bridgeHelpers.size, 1, 'every bridge.js copy is identical');
});

test('the packs guide an agent reads names every example and carries both schemas', async () => {
  const guide = await readPacksForAgent({ command: 'guide' }, {
    homeDir: path.join(path.sep, 'home', 'operator', '.glimmervoid'), env: {}, examplePacksDir: EXAMPLE_PACKS_DIR, packRows: () => [], isApproved: () => false,
  });
  for (const exampleName of exampleNames) assert.ok(guide.text.includes(path.join(EXAMPLE_PACKS_DIR, exampleName)), exampleName);
  assert.ok(guide.text.includes(PUBLISHED_SCHEMA_ID));
  assert.ok(guide.text.includes('"panelToHost"'));
});
