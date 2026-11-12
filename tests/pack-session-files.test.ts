import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createPackSessionFiles } from '../server/packs/pack-session-files.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { PACKS_DIR_NAME, packsStatePath } from '../server/packs/pack-files.ts';
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

test('an approved pack reaches a Claude Code session as a plugin of approved-byte copies and a first-prompt context line, and its spawned children, never a clean-home one', async () => {
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

    const spawnedChild = await startedSession(directory, packSessionFiles, 'operator', { ephemeral: true });
    assert.equal(spawnedChild.launchArgs.includes('--plugin-dir'), true, spawnedChild.launchArgs.join(' '));
    const cleanHome = await startedSession(directory, packSessionFiles, 'clean');
    assert.equal(cleanHome.launchArgs.includes('--plugin-dir'), false, cleanHome.launchArgs.join(' '));
    assert.equal(cleanHome.promptNotes.some((note) => note.includes('Pack acme-team')), false);
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
    assert.deepEqual(restarted.launch(), { contextLines: [], claudePluginDirs: [], namedSkillDirs: [] });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a pack.json agent section shows its context and skills word for word, reaches sessions only once approved, and an edited file reaches none until approved again', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-agent-'));
  const packDir = path.join(homeDir, PACKS_DIR_NAME, 'acme-team');
  fs.mkdirSync(path.join(packDir, 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'acme-team', version: 1, agent: { context: 'CONTEXT.md', skills: ['skills/deploy'] } }));
  fs.writeFileSync(path.join(packDir, 'CONTEXT.md'), 'Approved context.\n');
  fs.writeFileSync(path.join(packDir, 'skills', 'deploy', 'SKILL.md'), SKILL_TEXT);
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const root = path.join(homeDir, 'pack-session-files');
  const packSessionFiles = createPackSessionFiles({ root });
  try {
    await packStore.start();
    const pendingRow = packStore.statusFrame().packs.find((row) => row.name === 'acme-team');
    assert.deepEqual(pendingRow?.agent, { context: { path: 'CONTEXT.md', text: 'Approved context.\n' }, skills: [{ name: 'deploy', path: 'skills/deploy', text: SKILL_TEXT }] });
    assert.deepEqual(packStore.agentContributionsInUse(), []);

    assert.deepEqual(await packStore.approve(pendingRow?.fingerprint ?? ''), { ok: true });
    assert.deepEqual(await packSessionFiles.sync(packStore.agentContributionsInUse()), { warnings: [] });
    const folder = path.join(root, `acme-team-${(pendingRow?.fingerprint ?? '').slice(0, 12)}`);
    assert.deepEqual(packSessionFiles.launch(), {
      contextLines: [`Pack acme-team context: ${path.join(folder, 'context', 'CONTEXT.md')}. Read it when the task touches what it covers.`],
      claudePluginDirs: [path.join(folder, 'claude')], namedSkillDirs: [path.join(folder, 'named', 'acme-team-deploy')],
    });
    assert.match(fs.readFileSync(path.join(folder, 'named', 'acme-team-deploy', 'SKILL.md'), 'utf8'), /^---\nname: acme-team-deploy\n/);

    fs.writeFileSync(path.join(packDir, 'CONTEXT.md'), 'Edited after approval.\n');
    await packStore.approvedPacks();
    assert.deepEqual(packStore.agentContributionsInUse(), []);
    await packSessionFiles.sync(packStore.agentContributionsInUse());
    assert.deepEqual(packSessionFiles.launch(), { contextLines: [], claudePluginDirs: [], namedSkillDirs: [] });
    assert.equal(fs.existsSync(folder), false);
  } finally {
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
