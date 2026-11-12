import '../helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { HostToPanel, PackBridgeTopic } from '../../shared/contracts/pack-bridge.ts';
import { PACK_BRIDGE_HELPER_SOURCE } from '../../server/packs/core/pack-page-core.ts';
import { PREVIEW_FRAME_COUNT, previewSampleTopics, previewThemes } from '../../server/packs/core/pack-preview-core.ts';
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

test('every example panel subscribes to exactly the topics it declares and ships no copy of the bridge helper', () => {
  for (const exampleName of exampleNames) {
    for (const panel of manifestOf(exampleName).ui?.panels ?? []) {
      const panelDir = path.join(EXAMPLE_PACKS_DIR, exampleName, path.dirname(panel.entry));
      const panelScriptPath = fs.existsSync(path.join(panelDir, 'panel.js')) ? path.join(panelDir, 'panel.js') : path.join(EXAMPLE_PACKS_DIR, exampleName, panel.entry);
      const subscribed = subscribedTopicsIn(fs.readFileSync(panelScriptPath, 'utf8'));
      assert.deepEqual([...subscribed].sort(), [...panel.reads].sort(), `${exampleName}/${panel.id}`);
      for (const topic of subscribed) assert.ok(PackBridgeTopic.safeParse(topic).success, topic);
      assert.equal(fs.existsSync(path.join(panelDir, 'bridge.js')), false, `${exampleName}/${panel.id} relies on the helper Glimmervoid adds`);
    }
  }
});

test('the packs guide an agent reads names every example and carries both schemas', async () => {
  const guide = await readPacksForAgent({ command: 'guide' }, {
    homeDir: path.join(path.sep, 'home', 'operator', '.glimmervoid'), env: {}, examplePacksDir: EXAMPLE_PACKS_DIR, packRows: () => [], isApproved: () => false,
  });
  for (const exampleName of exampleNames) assert.ok(guide.text.includes(path.join(EXAMPLE_PACKS_DIR, exampleName)), exampleName);
  assert.ok(guide.text.includes(PUBLISHED_SCHEMA_ID));
  assert.ok(guide.text.includes('"panelToHost"'));
  const bridgeWindow: { glimmervoid?: Record<string, unknown> } = {};
  vm.runInNewContext(PACK_BRIDGE_HELPER_SOURCE, { window: bridgeWindow });
  const helperNames = Object.keys(bridgeWindow.glimmervoid ?? {});
  assert.ok(helperNames.length > 0);
  for (const helperName of helperNames) assert.ok(guide.text.includes(`${helperName}(`), `the guide describes the bridge helper ${helperName}`);
});

test('the sample data packs preview sends is valid for every bridge topic', () => {
  for (let frameIndex = 0; frameIndex < PREVIEW_FRAME_COUNT; frameIndex += 1) {
    for (const topic of PackBridgeTopic.options.filter((candidate) => candidate !== 'theme')) {
      assert.ok(HostToPanel.safeParse({ v: 1, kind: 'topic', topic, data: previewSampleTopics(Date.now(), frameIndex)[topic] }).success, `${topic} frame ${frameIndex}`);
    }
  }
  for (const theme of previewThemes(null)) assert.ok(HostToPanel.safeParse({ v: 1, kind: 'topic', topic: 'theme', data: { id: theme.id, colors: theme.colors } }).success, theme.id);
});
