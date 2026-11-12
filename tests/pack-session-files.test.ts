import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createPackSessionFiles } from '../server/packs/pack-session-files.ts';
import type { PackSessionFiles } from '../server/packs/pack-session-files.ts';
import type { PackAgentContribution } from '../session/core/pack-session-core.ts';
import { ProjectConfig } from '../shared/contracts/config.ts';
import { fakePty } from './helpers/fake-pty.ts';

const SKILL_TEXT = '---\nname: deploy\ndescription: Deploys the thing.\n---\nRun the deploy.\n';

function contribution(fingerprint: string, contextText: string): PackAgentContribution {
  return {
    packName: 'acme-team',
    fingerprint,
    context: { fileName: 'CONTEXT.md', bytes: Buffer.from(contextText) },
    skills: [{ skillName: 'deploy', filesByPath: new Map([['SKILL.md', Buffer.from(SKILL_TEXT)], ['scripts/run.sh', Buffer.from('echo run\n')]]) }],
  };
}

async function startedSession(directory: string, packSessionFiles: PackSessionFiles, agentHome: string, overrides: { ephemeral?: boolean } = {}) {
  const makeSession = createSessionFactory({
    configStore: { configPath: path.join(directory, 'config.json') }, hookRouter: { register: () => {}, unregister: () => {} }, getHookPort: () => 45999,
    getGitWorkspace: () => null, getUserHooks: () => [], resolveHookTools: () => [], getPackAgentLaunch: packSessionFiles.launch,
  });
  const id = `pack-${agentHome}-${overrides.ephemeral === true}`;
  const project: ProjectEntry = { ...ProjectConfig.parse({ id, name: id, path: directory, agent: 'claude-code', agentHome }), id, name: id, path: directory };
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, recordSignals: false, projects: [project] };
  const session = makeSession(project, config, overrides);
  const spawnedArgLists: string[][] = [];
  session._spawnCommand = { path: process.execPath, kind: 'exe' };
  session._ptySpawn = (_file, spawnArgs) => {
    spawnedArgLists.push([...spawnArgs]);
    return fakePty();
  };
  try {
    await session.start();
    return { launchArgs: spawnedArgLists[0] ?? [], promptNotes: session.takePromptNotes(() => true) };
  } finally {
    session.destroy();
  }
}

test('an approved pack reaches a Claude Code session as a plugin of approved-byte copies and a first-prompt context line, and never a clean-home or ephemeral one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-session-'));
  try {
    const root = path.join(directory, 'pack-session-files');
    const packSessionFiles = createPackSessionFiles({ root });
    assert.deepEqual(await packSessionFiles.sync([contribution('a'.repeat(64), 'Approved context.\n')]), { warnings: [] });
    const folder = path.join(root, `acme-team-${'a'.repeat(12)}`);
    assert.equal(fs.readFileSync(path.join(folder, 'claude', 'skills', 'deploy', 'SKILL.md'), 'utf8'), SKILL_TEXT);
    assert.equal(fs.readFileSync(path.join(folder, 'claude', 'skills', 'deploy', 'scripts', 'run.sh'), 'utf8'), 'echo run\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'claude', '.claude-plugin', 'plugin.json'), 'utf8')).name, 'acme-team');
    const contextPath = path.join(folder, 'context', 'CONTEXT.md');
    assert.equal(fs.readFileSync(contextPath, 'utf8'), 'Approved context.\n');

    const operator = await startedSession(directory, packSessionFiles, 'operator');
    const pluginAt = operator.launchArgs.indexOf('--plugin-dir');
    assert.deepEqual(operator.launchArgs.slice(pluginAt, pluginAt + 2), ['--plugin-dir', path.join(folder, 'claude')], operator.launchArgs.join(' '));
    assert.ok(operator.promptNotes.some((note) => note.includes(`Pack acme-team context: ${contextPath}.`)), operator.promptNotes.join('\n'));

    for (const isolated of [await startedSession(directory, packSessionFiles, 'clean'), await startedSession(directory, packSessionFiles, 'operator', { ephemeral: true })]) {
      assert.equal(isolated.launchArgs.includes('--plugin-dir'), false, isolated.launchArgs.join(' '));
      assert.equal(isolated.promptNotes.some((note) => note.includes('Pack acme-team')), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a re-approved pack keeps the copy live sessions started with until the next start, and a revoked pack loses every copy at once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-session-'));
  try {
    const root = path.join(directory, 'pack-session-files');
    const firstFolder = path.join(root, `acme-team-${'a'.repeat(12)}`);
    const secondFolder = path.join(root, `acme-team-${'b'.repeat(12)}`);
    const packSessionFiles = createPackSessionFiles({ root });
    await packSessionFiles.sync([contribution('a'.repeat(64), 'First.\n')]);
    await packSessionFiles.sync([contribution('b'.repeat(64), 'Second.\n')]);
    assert.equal(fs.existsSync(firstFolder), true);
    assert.equal(fs.readFileSync(path.join(secondFolder, 'context', 'CONTEXT.md'), 'utf8'), 'Second.\n');

    const restarted = createPackSessionFiles({ root });
    await restarted.sync([contribution('b'.repeat(64), 'Second.\n')]);
    assert.equal(fs.existsSync(firstFolder), false);

    await restarted.sync([]);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(restarted.launch(), { contextLines: [], claudePluginDirs: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
