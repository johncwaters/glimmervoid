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
  return settings.hooks.PreToolUse?.find((entry) => entry.matcher === HOOK_TOOLS.saneYolo.claudeEntry({ id: 'saneYolo', binPath: '', launch: [] }).matcher)?.hooks[0]?.command;
}

function permissionDecisionOf(stdout: string): string | undefined {
  const verdict = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return verdict.hookSpecificOutput?.permissionDecision;
}

test('the production Claude settings command denies git reset --hard and git stash behind any global git option', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const settings = buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] });
    const command = saneYoloCommandOf(settings);
    assert.ok(command);
    for (const shellCommand of ['git reset --hard', 'git stash', 'git stash push -u -m session-tag', 'git -c core.pager=cat stash pop', 'git -C . stash']) {
      const stdout: string = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', shellCommand, cwd) });
      assert.equal(permissionDecisionOf(stdout), 'deny', `${shellCommand}: ${stdout}`);
    }
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

test('the generated Codex home trusts the session folder and its Sane YOLO hook denies git reset --hard and a shell read of an SSH private key', async () => {
  await withProductionHookFixture(async ({ cwd, env }) => {
    const injection = codex.hooks.injection;
    assert.equal(injection.kind, 'argv-config');
    assert.ok(injection.home);
    const realCodexHome = path.join(env.HOME ?? '', '.codex');
    fs.mkdirSync(realCodexHome);
    const prepared = injection.home.prepareHome({ ...env, CODEX_HOME: realCodexHome }, cwd, false);
    assert.ok('home' in prepared, JSON.stringify(prepared));
    try {
      const generatedConfig = fs.readFileSync(path.join(prepared.home, 'config.toml'), 'utf8');
      assert.ok(generatedConfig.includes(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"`), generatedConfig);
      const command = generatedConfig.match(/command = '([^']* saneYolo codex)'/)?.[1];
      assert.ok(command, generatedConfig);
      const keyPath = path.join(env.HOME ?? '', '.ssh', 'id_ed25519');
      for (const shellCommand of ['git reset --hard', `cat ${keyPath}`]) {
        const stdout: string = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--codex', shellCommand, cwd) });
        assert.equal(permissionDecisionOf(stdout), 'deny', `${shellCommand}: ${stdout}`);
      }
    } finally {
      injection.home.releaseHome(prepared.home, cwd);
    }
  });
});

test('the hook tool relay forwards a Grok payload to the real Sane YOLO bin and returns its deny', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    assert.equal(env[SANE_YOLO_PATH_ENV], saneYoloTool.binPath);
    const response = await executeFile(process.execPath, [...grok.HOOK_TOOL_RELAY_LAUNCH.slice(1), 'saneYolo'], { cwd, env, input: hookPayload('--grok-build', 'git reset --hard', cwd) });
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

test('the production Claude settings command denies Read and shell reads of every glimmervoid secret file, following GLIMMERVOID_CONFIG', async () => {
  const previousConfigOverride = process.env.GLIMMERVOID_CONFIG;
  delete process.env.GLIMMERVOID_CONFIG;
  try {
    await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
      const command = saneYoloCommandOf(buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] }));
      assert.ok(command);
      const glimmervoidHome = process.env.GLIMMERVOID_HOME ?? '';
      const configPath = path.join(glimmervoidHome, 'config.json');
      const secretFiles = [configPath, `${configPath}.bak`, path.join(glimmervoidHome, 'vault-companion.json'), path.join(glimmervoidHome, 'watcher-link.key'), path.join(glimmervoidHome, 'secrets', 'config-secrets.json'), path.join(glimmervoidHome, 'secrets', 'vault-companion.json'), path.join(glimmervoidHome, 'secrets', 'watcher-link.key')];
      for (const secretFile of secretFiles) {
        const readInput = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: secretFile }, cwd, session_id: 'sane-yolo-test', permission_mode: 'default' });
        assert.equal(permissionDecisionOf(execSync(command, { cwd, env, encoding: 'utf8', input: readInput })), 'deny', `Read ${secretFile}`);
        for (const shellCommand of [`cat ${secretFile}`, `python3 -c "print(open('${secretFile}').read())"`]) {
          assert.equal(permissionDecisionOf(execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', shellCommand, cwd) })), 'deny', shellCommand);
        }
      }
    });
    const overrideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-config-override-'));
    const overrideConfigPath = path.join(overrideDirectory, 'operator.json');
    process.env.GLIMMERVOID_CONFIG = overrideConfigPath;
    try {
      await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
        const command = saneYoloCommandOf(buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] }));
        assert.ok(command);
        const readInput = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: overrideConfigPath }, cwd, session_id: 'sane-yolo-test', permission_mode: 'default' });
        assert.equal(permissionDecisionOf(execSync(command, { cwd, env, encoding: 'utf8', input: readInput })), 'deny');
        const overrideSecretsFile = path.join(overrideDirectory, 'secrets', 'config-secrets.json');
        assert.equal(permissionDecisionOf(execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', `cat ${overrideSecretsFile}`, cwd) })), 'deny', 'the secrets folder beside an overridden config');
      });
    } finally {
      fs.rmSync(overrideDirectory, { recursive: true, force: true });
    }
  } finally {
    if (previousConfigOverride === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigOverride !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigOverride;
  }
});

test('the production Claude settings command denies glimmervoid settings set --file in a session and allows settings export', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const command = saneYoloCommandOf(buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] }));
    assert.ok(command);
    for (const shellCommand of ['glimmervoid settings set --file plan.json', 'npx glimmervoid settings set --json --file plan.json']) {
      assert.equal(permissionDecisionOf(execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', shellCommand, cwd) })), 'deny', shellCommand);
    }
    assert.equal(execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', 'glimmervoid settings export', cwd) }).trim(), '');
  });
});
