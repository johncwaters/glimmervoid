import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { unwireEditors, wireEditors } from '../server/editor-wire.ts';
import type { EditorDetection } from '../server/editor-wire.ts';
import type { WireInvocation } from '../server/core/editor-wire-core.ts';

const INVOCATION: WireInvocation = { command: 'glimmervoid', args: ['visions', 'relay'] };

function fakeHome(t: TestContext): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function detection(homeDir: string): EditorDetection {
  return { homeDir, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(homeDir, '.config') }, exec: () => '' };
}

test('wiring writes, is idempotent, backs up once and unwires back to the original bytes', (t) => {
  const homeDir = fakeHome(t);
  fs.mkdirSync(path.join(homeDir, '.config', 'nvim'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.config', 'helix'), { recursive: true });
  const helixPath = path.join(homeDir, '.config', 'helix', 'languages.toml');
  const original = '[[language]]\nname = "markdown"\nlanguage-servers = ["marksman"]\n';
  fs.writeFileSync(helixPath, original);

  const first = wireEditors({ invocation: INVOCATION, ...detection(homeDir) });
  assert.deepEqual(first.map((entry) => entry.action), ['wrote', 'wrote']);
  const dropIn = path.join(homeDir, '.config', 'nvim', 'plugin', 'glimmervoid-visions.lua');
  assert.match(fs.readFileSync(dropIn, 'utf8'), /vim\.lsp\.start/);
  assert.equal(fs.readFileSync(`${helixPath}.glimmervoid.bak`, 'utf8'), original);

  const second = wireEditors({ invocation: INVOCATION, ...detection(homeDir) });
  assert.deepEqual(second.map((entry) => entry.action), ['unchanged', 'unchanged']);

  fs.writeFileSync(helixPath, `${fs.readFileSync(helixPath, 'utf8')}\n# operator edit\n`);
  wireEditors({ invocation: INVOCATION, ...detection(homeDir) });
  assert.equal(fs.readFileSync(`${helixPath}.glimmervoid.bak`, 'utf8'), original);

  const removed = unwireEditors(detection(homeDir));
  assert.deepEqual(removed.map((entry) => entry.action), ['removed', 'wrote']);
  assert.equal(fs.existsSync(dropIn), false);
  assert.equal(fs.readFileSync(helixPath, 'utf8').includes('glimmervoid-visions'), false);
  assert.match(fs.readFileSync(helixPath, 'utf8'), /# operator edit/);
});

test('a dry run reports what it would write and touches nothing', (t) => {
  const homeDir = fakeHome(t);
  fs.mkdirSync(path.join(homeDir, '.config', 'nvim'), { recursive: true });
  const report = wireEditors({ invocation: INVOCATION, dryRun: true, ...detection(homeDir) });
  assert.deepEqual(report.map((entry) => entry.action), ['would-write']);
  assert.equal(fs.existsSync(path.join(homeDir, '.config', 'nvim', 'plugin', 'glimmervoid-visions.lua')), false);
});
