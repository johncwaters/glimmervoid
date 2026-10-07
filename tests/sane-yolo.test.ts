import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildHookSettings } from '../detection/settings-injector.ts';
import { execFile, execSync } from '../server/child-process-safe.ts';
import { resolveHookTools, saneYoloHomeDir, writeSaneYoloPolicy } from '../server/hook-tools.ts';
import { resolvePackageBin } from '../server/runtime-paths.ts';
import codex from '../session/adapters/codex.ts';
import grok from '../session/adapters/grok.ts';
import { HOOK_TOOLS } from '../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { SANE_YOLO_FILES, SANE_YOLO_PATH_ENV, saneYoloEnv } from '../session/core/sane-yolo.ts';

const executeFile = promisify(execFile);
const deniedCommands = [
  'rm -rf ~',
  'rm -rf "$X/"',
  'git reset --hard',
  'git checkout -- .',
  'git clean -fd',
  'git push --force origin main',
  'dd if=/dev/zero of=/dev/disk2',
  'terraform destroy',
  'terraform -chdir=x destroy',
  'tofu apply -destroy',
  'kubectl delete ns x',
  'kubectl --context prod delete ns prod',
  'kubectl -n default delete namespace prod',
  'kubectl delete namespaces prod',
  'pulumi destroy',
  'pulumi down --yes',
  'pulumi -C infra destroy',
  'pulumi --cwd infra destroy -y',
  'terraform apply -destroy=true',
  'npx pulumi destroy',
  'rtk dd if=/dev/zero of=/dev/disk2',
  'rtk terraform destroy',
  'rtk proxy terraform destroy',
];
const allowedCommands = [
  'rm -rf dist',
  'git push --force-with-lease',
  'git branch -D x',
  'git merge --abort',
  'grep "rm -rf" .',
  'cat .env',
  'kubectl delete pod x',
  'terraform plan -destroy',
  'npx prettier --check .',
  'rtk git status',
];

function hookPayload(hostFlag: string, command: string, cwd: string): string {
  if (hostFlag === '--grok-build') {
    return JSON.stringify({ hookEventName: 'PreToolUse', toolName: 'run_terminal_command', toolInput: { command }, cwd, workspaceRoot: cwd, sessionId: 'sane-yolo-test' });
  }
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 'sane-yolo-test', permission_mode: 'bypassPermissions', ...(hostFlag === '--codex' ? { turn_id: 'turn-test' } : {}) });
}

for (const hostFlag of ['--coding-cli', '--codex', '--grok-build']) {
  test(`Sane YOLO payload matrix ${hostFlag}`, async (context) => {
    const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-sane-yolo-'));
    try {
      const cwd = path.join(temporaryHome, 'repo');
      const policyHome = path.join(temporaryHome, 'policy');
      fs.mkdirSync(cwd);
      const env = { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome, GLIMMERVOID_HOME: temporaryHome, ...saneYoloEnv(policyHome) };
      await executeFile('git', ['init', cwd], { env });
      writeSaneYoloPolicy(policyHome);
      const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
      assert.ok(binPath);
      const verification = await executeFile(process.execPath, [binPath, 'rule', 'verify'], { cwd, env });
      assert.match(verification.stdout, /infra/);
      for (const [shouldDeny, commands] of [[true, deniedCommands], [false, allowedCommands]] as const) {
        for (const command of commands) {
          await context.test(`${shouldDeny ? 'deny' : 'allow'} ${command}`, async () => {
            const response = await executeFile(process.execPath, [binPath, 'hook', hostFlag], { cwd, env, input: hookPayload(hostFlag, command, cwd) });
            if (!shouldDeny && hostFlag !== '--grok-build') {
              assert.equal(response.stdout, '', response.stderr);
              return;
            }
            const verdict = JSON.parse(response.stdout) as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
            const decision = hostFlag === '--grok-build' ? verdict.decision : verdict.hookSpecificOutput?.permissionDecision;
            assert.equal(decision, shouldDeny ? 'deny' : 'allow', response.stdout);
            if (shouldDeny) assert.ok(verdict.reason || verdict.hookSpecificOutput?.permissionDecisionReason);
          });
        }
      }
    } finally {
      fs.rmSync(temporaryHome, { recursive: true, force: true });
    }
  });
}

test('Sane YOLO policy writer preserves identical files and writes the exact configured policy', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-policy-writer-'));
  try {
    for (const [relativePath, contents] of Object.entries(SANE_YOLO_FILES)) {
      const filePath = path.join(homeDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(contents, null, 2)}\n`);
      fs.utimesSync(filePath, 1000, 1000);
    }
    writeSaneYoloPolicy(homeDir);
    writeSaneYoloPolicy(homeDir);
    for (const [relativePath, contents] of Object.entries(SANE_YOLO_FILES)) {
      const filePath = path.join(homeDir, relativePath);
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), contents);
      assert.equal(fs.statSync(filePath).mtimeMs, 1000000);
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Sane YOLO resolves by default only for skip-permissions sessions and honors opt-out', () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-policy-resolve-'));
  const previousHome = process.env.GLIMMERVOID_HOME;
  process.env.GLIMMERVOID_HOME = temporaryHome;
  try {
    assert.deepEqual(resolveHookTools({}, { skipPermissions: false }), []);
    assert.deepEqual(resolveHookTools({ saneYolo: false }, { skipPermissions: true }), []);
    assert.equal(fs.existsSync(path.join(temporaryHome, 'sane-yolo')), false);
    assert.deepEqual(resolveHookTools({}, { skipPermissions: true }), [{ id: 'saneYolo', binPath: resolvePackageBin('cc-safety-net', 'cc-safety-net') }]);
    assert.equal(fs.existsSync(path.join(temporaryHome, 'sane-yolo', 'policy.json')), true);
  } finally {
    if (previousHome === undefined) delete process.env.GLIMMERVOID_HOME;
    if (previousHome !== undefined) process.env.GLIMMERVOID_HOME = previousHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

interface ProductionHookFixture {
  cwd: string;
  env: NodeJS.ProcessEnv;
  saneYoloTool: ResolvedHookTool;
}

async function withProductionHookFixture(run: (fixture: ProductionHookFixture) => Promise<void>): Promise<void> {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-sane-yolo-e2e-'));
  const previousGlimmervoidHome = process.env.GLIMMERVOID_HOME;
  process.env.GLIMMERVOID_HOME = path.join(temporaryHome, '.glimmervoid');
  try {
    const cwd = path.join(temporaryHome, 'repo');
    fs.mkdirSync(cwd);
    const baseEnv = { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome };
    await executeFile('git', ['init', cwd], { env: baseEnv });
    const saneYoloTool = resolveHookTools({}, { skipPermissions: true }).find((tool) => tool.id === 'saneYolo');
    assert.ok(saneYoloTool);
    const env = { ...baseEnv, ...HOOK_TOOLS.saneYolo.env(saneYoloTool, saneYoloHomeDir()) };
    await run({ cwd, env, saneYoloTool });
  } finally {
    if (previousGlimmervoidHome === undefined) delete process.env.GLIMMERVOID_HOME;
    if (previousGlimmervoidHome !== undefined) process.env.GLIMMERVOID_HOME = previousGlimmervoidHome;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

function permissionDecisionOf(stdout: string): string | undefined {
  const verdict = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return verdict.hookSpecificOutput?.permissionDecision;
}

test('the production Claude settings command denies git reset --hard through a shell', async () => {
  await withProductionHookFixture(async ({ cwd, env, saneYoloTool }) => {
    const settings = buildHookSettings({ port: 1, glimmervoidId: 'sane-yolo-e2e', token: 'token', hookTools: [saneYoloTool] });
    const saneYoloEntry = settings.hooks.PreToolUse?.find((entry) => entry.matcher === 'Bash|PowerShell|Monitor');
    const command = saneYoloEntry?.hooks[0]?.command;
    assert.ok(command);
    const stdout = execSync(command, { cwd, env, encoding: 'utf8', input: hookPayload('--coding-cli', 'git reset --hard', cwd) });
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
