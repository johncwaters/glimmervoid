import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildHookSettings } from '../detection/settings-injector.ts';
import { execFile, execSync } from '../server/child-process-safe.ts';
import { resolveHookTools, saneYoloHomeDir, } from '../server/hook-tools.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import codex from '../session/adapters/codex.ts';
import grok from '../session/adapters/grok.ts';
import kimi from '../session/adapters/kimi.ts';
import { HOOK_TOOLS } from '../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { SANE_YOLO_PATH_ENV, } from '../session/core/sane-yolo.ts';

const executeFile = promisify(execFile);
function hookPayload(hostFlag: string, command: string, cwd: string): string {
  if (hostFlag === '--grok-build') {
    return JSON.stringify({ hookEventName: 'PreToolUse', toolName: 'run_terminal_command', toolInput: { command }, cwd, workspaceRoot: cwd, sessionId: 'sane-yolo-test' });
  }
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 'sane-yolo-test', permission_mode: 'bypassPermissions', ...(hostFlag === '--codex' ? { turn_id: 'turn-test' } : {}) });
}

test('a project marked saneYolo resolves the Sane YOLO hook while the machine setting is off', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-project-sane-yolo-'));
  const requestedSaneYoloSettings: (boolean | undefined)[] = [];
  const makeSession = createSessionFactory({
    configStore: { configPath: path.join(directory, 'config.json') }, hookRouter: null, getHookPort: () => null,
    getGitWorkspace: () => null, getPlanReviewPort: () => null, getUserHooks: () => [],
    resolveHookTools: (config) => { requestedSaneYoloSettings.push(config.saneYolo); return []; },
  });
  const project = { id: 'sane-yolo-project', name: 'project', path: directory, dangerouslySkipPermissions: true, saneYolo: true };
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, saneYolo: false, recordSignals: false, projects: [project] };
  const session = makeSession(project, config);
  try {
    assert.deepEqual(requestedSaneYoloSettings, [true]);
  } finally {
    session.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface ProductionHookFixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
  saneYoloTool: ResolvedHookTool;
}

async function withProductionHookFixture(run: (fixture: ProductionHookFixture) => Promise<void>, saneYoloUnreadablePaths: readonly string[] = []): Promise<void> {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-sane-yolo-e2e-'));
  const previousGlimmervoidHome = process.env.GLIMMERVOID_HOME;
  process.env.GLIMMERVOID_HOME = path.join(temporaryHome, '.glimmervoid');
  try {
    const cwd = path.join(temporaryHome, 'repo');
    fs.mkdirSync(cwd);
    const baseEnv = { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome };
    await executeFile('git', ['init', cwd], { env: baseEnv });
    const saneYoloTool = resolveHookTools({ saneYoloUnreadablePaths }).find((tool) => tool.id === 'saneYolo');
    assert.ok(saneYoloTool);
    const env = { ...baseEnv, ...HOOK_TOOLS.saneYolo.env(saneYoloTool, saneYoloHomeDir()) };
    await run({ cwd, env, saneYoloTool });
  } finally {
    if (previousGlimmervoidHome === undefined) delete process.env.GLIMMERVOID_HOME;
    if (previousGlimmervoidHome !== undefined) process.env.GLIMMERVOID_HOME = previousGlimmervoidHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

function saneYoloCommandOf(settings: ReturnType<typeof buildHookSettings>): string | undefined {
  return settings.hooks.PreToolUse?.find((entry) => entry.matcher === HOOK_TOOLS.saneYolo.claudeEntry({ id: 'saneYolo', binPath: '' }, '').matcher)?.hooks[0]?.command;
}

function permissionDecisionOf(stdout: string): string | undefined {
  const verdict = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return verdict.hookSpecificOutput?.permissionDecision;
}

test('the production Claude settings command denies git reset --hard through a shell', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const settings = buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] });
    const command = saneYoloCommandOf(settings);
    assert.ok(command);
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', 'git reset --hard', cwd) });
    assert.equal(permissionDecisionOf(stdout), 'deny', stdout);
  });
});

test('the production Claude settings command denies infra teardown hidden behind an rtk prefix', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const settings = buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] });
    const command = saneYoloCommandOf(settings);
    assert.ok(command);
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', 'rtk terraform destroy', cwd) });
    assert.equal(permissionDecisionOf(stdout), 'deny', stdout);
  });
});

test('the production Claude settings command denies a Read tool call on an SSH private key', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const settings = buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] });
    const command = saneYoloCommandOf(settings);
    assert.ok(command);
    const keyPath = path.join(env.HOME ?? '', '.ssh', 'id_ed25519');
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: keyPath }, cwd, session_id: 'sane-yolo-test', permission_mode: 'default' });
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input });
    assert.equal(permissionDecisionOf(stdout), 'deny', stdout);
  });
});

test('the production Codex PreToolUse override command denies git reset --hard through a shell', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const injection = codex.hooks.injection;
    assert.equal(injection.kind, 'argv-config');
    const hookArgs = injection.buildHookArgs({ hookTools: [saneYoloTool] });
    assert.ok(hookArgs);
    const preToolUseValue = hookArgs.find((argument) => argument.startsWith('hooks.PreToolUse='));
    assert.ok(preToolUseValue);
    const command = preToolUseValue.match(/command='([^']* hook --codex)'/)?.[1];
    assert.ok(command, preToolUseValue);
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--codex', 'git reset --hard', cwd) });
    assert.equal(permissionDecisionOf(stdout), 'deny', stdout);
  });
});

test('the hook tool relay forwards a Grok payload to the real Sane YOLO bin and returns its deny', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    assert.equal(env[SANE_YOLO_PATH_ENV], saneYoloTool.binPath);
    const response = await executeFile(process.execPath, [grok.HOOK_TOOL_RELAY_PATH, 'saneYolo'], { cwd, env, input: hookPayload('--grok-build', 'git reset --hard', cwd) });
    const verdict = JSON.parse(response.stdout) as { decision?: string };
    assert.equal(verdict.decision, 'deny', response.stdout);
  });
});

test('the managed kimi block PreToolUse command denies git reset --hard through the relay and the real Sane YOLO bin', async () => {
  await withProductionHookFixture(async ({ cwd, env }) => {
    const block = kimi.expectedHooksBlock();
    assert.ok(block);
    const command = block.match(/^command = '(node \S+ saneYolo kimi)'$/m)?.[1];
    assert.ok(command, block);
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, tool_call_id: 'call-1', cwd, session_id: 'sane-yolo-test' });
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input });
    assert.equal(permissionDecisionOf(stdout), 'deny', stdout);
  });
});

test('the production Claude settings command denies a Read inside a folder listed in saneYoloUnreadablePaths', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const command = saneYoloCommandOf(buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] }));
    assert.ok(command);
    const readOf = (filePath: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: filePath }, cwd, session_id: 'sane-yolo-test', permission_mode: 'default' });
    const listedStdout = execSync(command, { cwd, env, encoding: 'utf8', input: readOf(path.join(env.HOME ?? '', 'private-notes', 'plan.md')) });
    assert.equal(permissionDecisionOf(listedStdout), 'deny', listedStdout);
    const unlistedStdout = execSync(command, { cwd, env, encoding: 'utf8', input: readOf(path.join(env.HOME ?? '', 'public-notes', 'plan.md')) });
    assert.equal(unlistedStdout.trim(), '');
  }, ['~/private-notes']);
});
