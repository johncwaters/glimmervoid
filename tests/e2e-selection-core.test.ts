import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function selectedScenariosFor(changedPath: string): string[] {
  const listing = spawnSync(process.execPath, ['scripts/e2e.ts', '--changed', changedPath, '--list'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  return [...listing.stdout.matchAll(/^\[e2e\] (tests\/e2e\/[\w.-]+): /gm)].map((match) => match[1]);
}

test('a change selects the scenarios whose code it reaches, and a docs-only change selects none', { skip: process.platform === 'win32' }, () => {
  assert.ok(selectedScenariosFor('server/secrets/vault-socket.ts').includes('tests/e2e/vault-telemetry.e2e.ts'));
  assert.ok(selectedScenariosFor('server/github/github-store-probes.ts').includes('tests/e2e/watcher.e2e.ts'));
  assert.deepEqual(selectedScenariosFor('docs/configuration.md'), []);
});
