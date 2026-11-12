import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLaneSpawn } from '../server/lanes/lane-spawn.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { laneAccountHomeFor } from '../session/core/agent-account-core.ts';

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

test('a Claude Code lane runs under the account its lane names, else the Claude Code default, and a Codex lane keeps the machine login', async () => {
  const laneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-lane-account-'));
  const config = {
    agentAccounts: [
      { id: 'claude-team', agent: 'claude-code', label: 'Team', folder: '/accounts/team' },
      { id: 'claude-personal', agent: 'claude-code', label: 'Personal', folder: '/accounts/personal' },
    ],
    agentAccountDefaults: { 'claude-code': 'claude-personal' },
    laneAccounts: { 'task-title': 'claude-team', radar: null },
  };
  const launchedAccountsByLane = new Map<string, unknown>();
  const spawnOn = (lane: 'task-title' | 'question-manager' | 'radar', agent: string) => createLaneSpawn({
    laneName: lane, getSaneYoloUnreadablePaths: () => [],
    accountHomeFor: laneAccountHomeFor(() => config, lane),
    createSession: (options) => {
      launchedAccountsByLane.set(`${lane}:${agent}`, options.resolveAccountHome?.() ?? null);
      throw new Error('launch captured');
    },
  })({ id: `${lane}-lane`, name: lane, prompt: 'Title this.', cwd: laneDir, agent });
  try {
    for (const [lane, agent] of [['task-title', 'claude-code'], ['question-manager', 'claude-code'], ['radar', 'claude-code'], ['task-title', 'codex']] as const) {
      await assert.rejects(spawnOn(lane, agent), /launch captured/);
    }
    assert.deepEqual(launchedAccountsByLane.get('task-title:claude-code'), { kind: 'account', account: config.agentAccounts[0] });
    assert.deepEqual(launchedAccountsByLane.get('question-manager:claude-code'), { kind: 'account', account: config.agentAccounts[1] });
    assert.deepEqual(launchedAccountsByLane.get('radar:claude-code'), { kind: 'machine-login' });
    assert.equal(launchedAccountsByLane.get('task-title:codex'), null);
  } finally {
    fs.rmSync(laneDir, { recursive: true, force: true });
  }
});
