import './helpers/isolate-home.ts';
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
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const SETUP_CASES = [
  { agent: 'claude-code', setup: { agent: 'claude-code', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }], instructions: '' }, flags: ['--model', 'claude-opus-5-5', '--effort', 'high'] },
  { agent: 'codex', setup: { agent: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'effort', value: 'low' }], instructions: '' }, flags: ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=low'] },
  { agent: 'kimi', setup: { agent: 'kimi', model: 'kimi-code/kimi-for-coding', options: [], instructions: '' }, flags: ['-m', 'kimi-code/kimi-for-coding'] },
] as const;

async function spawnedArgs(project: ProjectEntry, directory: string, hasHookRouter = false): Promise<string[]> {
  const makeSession = createSessionFactory({
    configStore: { configPath: path.join(directory, 'config.json') }, hookRouter: hasHookRouter ? { register: () => {}, unregister: () => {} } : null, getHookPort: () => (hasHookRouter ? 45999 : null),
    getGitWorkspace: () => null, getUserHooks: () => [], resolveHookTools: () => [],
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

type AddSessionReply = { type: string; requestId?: string; ok?: boolean; error?: string | null };

function addSessionOverControl(config: GlimmervoidConfig, message: Record<string, unknown>): AddSessionReply | undefined {
  const connection = connectControl<AddSessionReply>(createControlServer(controlDeps(config, { generateProjectId: () => 'added-with-setup' })));
  connection.send({ type: 'add-session', requestId: 'a1', name: 'with-setup', ...message });
  return connection.sent.find((frame) => frame.requestId === 'a1');
}

for (const { agent, setup, flags } of SETUP_CASES) {
  test(`an add-session carrying a ${agent} model choice starts the session with its model and effort flags`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-add-setup-'));
    try {
      const config: GlimmervoidConfig = { projects: [] };
      const { instructions: _instructions, ...modelChoice } = setup;
      const reply = addSessionOverControl(config, { path: directory, agent, setup: modelChoice });
      assert.equal(reply?.ok, true, reply?.error ?? '');
      const [project] = config.projects;
      assert.ok(project);
      const launchArgs = await spawnedArgs(project, directory);
      const flagStart = launchArgs.indexOf(flags[0]);
      assert.deepEqual(launchArgs.slice(flagStart, flagStart + flags.length), [...flags], launchArgs.join(' '));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('an add-session refuses a model choice for another agent or with a value unsafe on a command line', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-add-setup-'));
  try {
    const config: GlimmervoidConfig = { projects: [] };
    const otherAgent = addSessionOverControl(config, { path: directory, agent: 'codex', setup: { agent: 'claude-code', model: 'claude-opus-5-5', options: [] } });
    assert.equal(otherAgent?.ok, false);
    const unsafeEffort = addSessionOverControl(config, { path: directory, agent: 'claude-code', setup: { agent: 'claude-code', model: null, options: [{ id: 'effort', value: 'high & calc' }] } });
    assert.equal(unsafeEffort?.ok, false);
    assert.match(unsafeEffort?.error ?? '', /command line/);
    assert.equal(config.projects.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a persisted clean home starts Claude Code on project and local settings only, refuses to start without its hooks, and the operator home keeps every source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-clean-home-'));
  try {
    const project = (agentHome: string): ProjectEntry => ({ ...ProjectConfig.parse({ id: `home-${agentHome}`, name: agentHome, path: directory, agent: 'claude-code', agentHome }), id: `home-${agentHome}`, name: agentHome, path: directory });
    await assert.rejects(spawnedArgs(project('clean'), directory), /cannot start in a clean home/);
    const cleanArgs = await spawnedArgs(project('clean'), directory, true);
    const sourcesAt = cleanArgs.indexOf('--setting-sources');
    assert.deepEqual(cleanArgs.slice(sourcesAt, sourcesAt + 2), ['--setting-sources', 'project,local'], cleanArgs.join(' '));
    assert.equal((await spawnedArgs(project('operator'), directory)).includes('--setting-sources'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a Claude Code session trusts its own resolved folder in the Claude config before its agent starts, even through a symlink', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-claude-folder-trust-'));
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const claudeConfigPath = path.join(directory, '.claude.json');
  fs.writeFileSync(claudeConfigPath, JSON.stringify({ projects: {} }), { mode: 0o600 });
  process.env.CLAUDE_CONFIG_DIR = directory;
  try {
    const sessionFolder = path.join(fs.realpathSync(directory), 'worktree');
    fs.mkdirSync(sessionFolder);
    const symlinkedSessionFolder = path.join(directory, 'linked-worktree');
    fs.symlinkSync(sessionFolder, symlinkedSessionFolder);
    const project: ProjectEntry = { ...ProjectConfig.parse({ id: 'trust', name: 'trust', path: symlinkedSessionFolder, agent: 'claude-code' }), id: 'trust', name: 'trust', path: symlinkedSessionFolder };
    await spawnedArgs(project, directory);
    const trustedProjects = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')).projects;
    assert.equal(trustedProjects[sessionFolder]?.hasTrustDialogAccepted, true);
    assert.equal(trustedProjects[sessionFolder]?.hasClaudeMdExternalIncludesApproved, undefined);
  } finally {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    if (previousClaudeConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const DESKTOP_ENV_KEYS = ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY'] as const;

for (const { graphicalSessionState, waylandDisplay, expectedBusAddress } of [
  { graphicalSessionState: 'inactive', waylandDisplay: undefined, expectedBusAddress: 'disabled:' },
  { graphicalSessionState: 'inactive', waylandDisplay: 'wayland-1', expectedBusAddress: 'unix:path=/run/user/1000/bus' },
  { graphicalSessionState: 'active', waylandDisplay: undefined, expectedBusAddress: 'unix:path=/run/user/1000/bus' },
] as const) {
  test(`a Linux agent launched while the graphical session is ${graphicalSessionState} and WAYLAND_DISPLAY is ${waylandDisplay ?? 'unset'} gets session bus ${expectedBusAddress}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-desktop-bus-'));
    const previousDesktopEnv = Object.fromEntries(DESKTOP_ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    if (waylandDisplay !== undefined) process.env.WAYLAND_DISPLAY = waylandDisplay;
    try {
      const project: ProjectEntry = { ...ProjectConfig.parse({ id: 'bus', name: 'bus', path: directory, agent: 'codex' }), id: 'bus', name: 'bus', path: directory };
      const makeSession = createSessionFactory({
        configStore: { configPath: path.join(directory, 'config.json') }, hookRouter: null, getHookPort: () => null,
        getGitWorkspace: () => null, getUserHooks: () => [], resolveHookTools: () => [],
      });
      const session = makeSession(project, { ...DEFAULT_CONFIG, recordSignals: false, projects: [project] });
      const spawnedBusAddresses: (string | undefined)[] = [];
      session._spawnCommand = { path: process.execPath, kind: 'exe' };
      session._platform = 'linux';
      session._probeGraphicalSession = async () => graphicalSessionState;
      session._ptySpawn = (_file, _spawnArgs, spawnOptions) => {
        spawnedBusAddresses.push(spawnOptions.env?.DBUS_SESSION_BUS_ADDRESS);
        return fakePty();
      };
      try {
        await session.start();
      } finally {
        session.destroy();
      }
      assert.deepEqual(spawnedBusAddresses, [expectedBusAddress]);
    } finally {
      for (const key of DESKTOP_ENV_KEYS) {
        delete process.env[key];
        const previousValue = previousDesktopEnv[key];
        if (previousValue !== undefined) process.env[key] = previousValue;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
