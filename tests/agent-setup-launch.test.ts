import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { ProjectConfig } from '../shared/contracts/config.ts';
import { fakePty } from './helpers/fake-pty.ts';

const SETUP_CASES = [
  { agent: 'claude-code', setup: { agent: 'claude-code', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }], instructions: '' }, flags: ['--model', 'claude-opus-5-5', '--effort', 'high'] },
  { agent: 'codex', setup: { agent: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'effort', value: 'low' }], instructions: '' }, flags: ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=low'] },
  { agent: 'kimi', setup: { agent: 'kimi', model: 'kimi-code/kimi-for-coding', options: [], instructions: '' }, flags: ['-m', 'kimi-code/kimi-for-coding'] },
] as const;

async function spawnedArgs(project: ProjectEntry, directory: string): Promise<string[]> {
  const makeSession = createSessionFactory({
    configStore: { configPath: path.join(directory, 'config.json') }, hookRouter: null, getHookPort: () => null,
    getGitWorkspace: () => null, getPlanReviewPort: () => null, getUserHooks: () => [], resolveHookTools: () => [],
  });
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, recordSignals: false, projects: [project] };
  const session = makeSession(project, config);
  const spawnedArgLists: string[][] = [];
  session._spawnCommand = { path: process.execPath, kind: 'exe' };
  session._ptySpawn = (_file, spawnArgs) => {
    spawnedArgLists.push([...spawnArgs]);
    return fakePty();
  };
  try {
    await session.start();
    return spawnedArgLists[0] ?? [];
  } finally {
    session.destroy();
  }
}

for (const { agent, setup, flags } of SETUP_CASES) {
  test(`a persisted ${agent} agent setup reaches the launch on a fresh start and on resume`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agent-setup-'));
    try {
      const id = `setup-${agent}`;
      const project: ProjectEntry = { ...ProjectConfig.parse({ id, name: id, path: directory, agent, agentSetup: setup }), id, name: id, path: directory };
      const freshArgs = await spawnedArgs(project, directory);
      const resumedArgs = await spawnedArgs({ ...project, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }, directory);
      for (const launchArgs of [freshArgs, resumedArgs]) {
        const flagStart = launchArgs.indexOf(flags[0]);
        assert.deepEqual(launchArgs.slice(flagStart, flagStart + flags.length), [...flags], launchArgs.join(' '));
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
