import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLaneSpawn } from '../server/lanes/lane-spawn.ts';
import type { SessionOptions } from '../session/sessions.ts';

test('a Codex lane runs codex exec under a permission profile that hides the home folder and writes only its own folder, in a clean home, reading its prompt from a file in that folder', async () => {
  const laneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-codex-lane-'));
  const launched: SessionOptions[] = [];
  try {
    const spawn = createLaneSpawn({
      laneName: 'race', getSaneYoloUnreadablePaths: () => [],
      createSession: (options) => {
        launched.push(options);
        throw new Error('launch captured');
      },
    });
    await assert.rejects(spawn({ id: 'codex-lane', name: 'Codex lane', prompt: 'Judge the contestants.', cwd: laneDir, agent: 'codex', model: 'gpt-6.1-sol' }), /launch captured/);
    const [options] = launched;
    assert.ok(options);
    assert.equal(options.isCleanHome, true);
    assert.deepEqual(options.extraClaudeArgs, [
      'exec', '--skip-git-repo-check',
      '-c', 'default_permissions="glimmervoid_lane"',
      '-c', `permissions.glimmervoid_lane.filesystem={":root"="read",${JSON.stringify(os.homedir())}="none",${JSON.stringify(laneDir)}="write"}`,
      '-m', 'gpt-6.1-sol', 'Read lane-prompt.md in the current folder and follow its instructions.',
    ]);
    assert.equal(options.initialPrompt, null);
    assert.equal(fs.readFileSync(path.join(laneDir, 'lane-prompt.md'), 'utf8'), 'Judge the contestants.');
  } finally {
    fs.rmSync(laneDir, { recursive: true, force: true });
  }
});
