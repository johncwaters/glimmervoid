import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { execFile } from '../server/child-process-safe.ts';
import { prepareLaneMcp } from '../server/lanes/lane-mcp.ts';
import { relayPath } from '../server/runtime-paths.ts';
import codex from '../session/adapters/codex.ts';
import kimi from '../session/adapters/kimi.ts';
import { codexHookPlanFor } from '../session/core/codex-version-core.ts';
import { HOOK_TOOLS } from '../session/core/hook-tools.ts';

const executeFile = promisify(execFile);
const gatePath = relayPath('posthog-read-gate');
const operatorPosthogEntry = { type: 'http', url: 'https://mcp.posthog.com/mcp' };

async function gateExitFor(stdin: string, serverName = 'posthog'): Promise<{ code: number; stderr: string }> {
  try {
    await executeFile(process.execPath, [gatePath, serverName], { input: stdin, encoding: 'utf8' });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, stderr: failure.stderr };
  }
}

function execCall(command: string, toolName = 'mcp__posthog__exec'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command } });
}

test('the PostHog read gate lets lookups and read tools through and blocks everything else with exit 2', async () => {
  const allowedCommands = [
    'tools', 'search feature flags', 'schema execute-sql', 'call execute-sql {"query":"SELECT 1"}',
    'call --json feature-flag-get-all {}', 'call dashboard-get {"id":1}', 'call query-trends {}',
  ];
  for (const command of allowedCommands) assert.equal((await gateExitFor(execCall(command))).code, 0, command);

  const blockedInputs = [
    execCall('call feature-flag-create {"key":"x"}'),
    execCall('call --confirm dashboard-get {"id":1}'),
    execCall('call execute-sql {}\ncall feature-flag-delete {}'),
    execCall('call switch-project {"id":2}'),
    execCall('switch organization'),
    execCall('call execute-sql {}', 'mcp__posthog__other'),
    execCall('call execute-sql {}', 'mcp__other__exec'),
    'not json',
  ];
  for (const stdin of blockedInputs) {
    const outcome = await gateExitFor(stdin);
    assert.equal(outcome.code, 2, stdin);
    assert.match(outcome.stderr, /^Glimmervoid lanes read PostHog only: /, stdin);
  }
});

test('a lane gets the operator PostHog server unchanged only when the gate self-test denies a write', async () => {
  const otherServers = { gauge: { type: 'http', url: 'https://gauge.example.com/mcp' } };
  const readClaudeConfig = async () => ({ mcpServers: { ...otherServers, posthog: operatorPosthogEntry } });
  const laneArgs = ['--strict-mcp-config'];

  const prepared = await prepareLaneMcp({ laneArgs }, { readClaudeConfig });
  assert.ok(prepared);
  const mcpConfigPath = prepared.posture.args[1] ?? '';
  assert.deepEqual(prepared.posture.args, ['--mcp-config', mcpConfigPath]);
  assert.deepEqual(JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')), { mcpServers: { posthog: operatorPosthogEntry } });
  assert.equal(fs.statSync(mcpConfigPath).mode & 0o777, 0o600);
  assert.deepEqual(prepared.posture.allowRules, ['mcp__posthog__exec']);
  assert.deepEqual(prepared.posture.hookTool, { id: 'posthogReadGate', binPath: gatePath, serverName: 'posthog', interpreterPath: process.execPath });
  await prepared.cleanup();
  assert.equal(fs.existsSync(path.dirname(mcpConfigPath)), false);

  const loadsOperatorServers = await prepareLaneMcp({ laneArgs: [] }, { readClaudeConfig });
  assert.deepEqual(loadsOperatorServers?.posture.args, []);
  await loadsOperatorServers?.cleanup();

  assert.equal(await prepareLaneMcp({ laneArgs }, { readClaudeConfig: async () => ({ mcpServers: otherServers }) }), null);
  assert.equal(await prepareLaneMcp({ laneArgs }, { readClaudeConfig: async () => { throw new Error('no config'); } }), null);
  const allowsEverything = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-mcp-')), 'allow.mjs');
  fs.writeFileSync(allowsEverything, 'process.exit(0);\n');
  assert.equal(await prepareLaneMcp({ laneArgs }, { readClaudeConfig, gatePath: allowsEverything }), null);
});

test('the installed gate hook blocks when its interpreter cannot run the gate', async () => {
  const brokenInterpreterTool = { id: 'posthogReadGate' as const, binPath: gatePath, serverName: 'posthog', interpreterPath: '/nonexistent/node' };
  const hookCommand = HOOK_TOOLS.posthogReadGate.claudeEntry(brokenInterpreterTool, '').hooks[0]?.command ?? '';
  const outcome = await executeFile('/bin/sh', ['-c', hookCommand], { input: execCall('call execute-sql {}'), encoding: 'utf8' }).then(() => 0, (error: { code: number }) => error.code);
  assert.equal(outcome, 2);
});

test('a Codex lane approves PostHog calls only when the gate hook runs trusted on a Codex that gates MCP calls', async () => {
  const codexServers = [
    { name: 'posthog', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.posthog.com/mcp' } },
    { name: 'gauge', enabled: true, transport: { type: 'streamable_http', url: 'https://gauge.example.com/mcp' } },
  ];
  const prepared = await prepareLaneMcp({ laneArgs: [], agent: 'codex' }, { listCodexServers: async () => codexServers });
  assert.ok(prepared);
  assert.deepEqual(prepared.posture.args, ['-c', 'mcp_servers.posthog.enabled_tools=["exec"]', '-c', 'mcp_servers.gauge.enabled=false']);
  assert.equal(prepared.posture.bypassHookTrust, true);

  const approval = 'mcp_servers.posthog.default_tools_approval_mode="approve"';
  const hookArgsFor = (bypassHookTrust: boolean, codexVersion: string) =>
    codex.buildHookArgs({ ...codexHookPlanFor(codexVersion), bypassHookTrust, hookTools: [prepared.posture.hookTool] }) ?? [];
  assert.equal(hookArgsFor(true, '0.165.0').includes(approval), true);
  assert.equal(hookArgsFor(true, '0.165.0').includes('features.hooks=true'), true);
  assert.equal(hookArgsFor(false, '0.165.0').includes(approval), false);
  assert.equal(hookArgsFor(true, '0.164.0').includes(approval), false);
  assert.equal(await prepareLaneMcp({ laneArgs: [], agent: 'codex' }, { listCodexServers: async () => { throw new Error('no codex'); } }), null);
  const undisableableServer = { name: 'my.server', enabled: true, transport: { type: 'stdio', command: 'echo' } };
  assert.equal(await prepareLaneMcp({ laneArgs: [], agent: 'codex' }, { listCodexServers: async () => [...codexServers, undisableableServer] }), null);
});

test('a Kimi lane home holds only the PostHog server and the gate hook beside the Glimmervoid hooks, and refuses a config that cannot take hooks', async () => {
  const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-mcp-kimi-'));
  fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { gauge: { url: 'https://gauge.example.com/mcp' }, posthog: operatorPosthogEntry } }));
  fs.writeFileSync(path.join(kimiHome, 'config.toml'), 'default_model = "k3"\n');
  fs.writeFileSync(path.join(kimiHome, 'credentials'), 'login');
  const injection = kimi.hooks.injection;
  if (injection.kind !== 'generated-home') throw new Error('Kimi Code builds its generated home');
  const env = { ...process.env, KIMI_CODE_HOME: kimiHome };

  const prepared = await prepareLaneMcp({ laneArgs: [], agent: 'kimi' }, { kimiHome });
  assert.ok(prepared?.scratchAgentHome);
  const built = injection.prepareScratchHome(env, prepared.scratchAgentHome);
  assert.ok('home' in built);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(built.home, 'mcp.json'), 'utf8')), { mcpServers: { posthog: { ...operatorPosthogEntry, enabledTools: ['exec'] } } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(kimiHome, 'mcp.json'), 'utf8')).mcpServers.gauge.url, 'https://gauge.example.com/mcp');
  assert.equal(fs.readFileSync(path.join(built.home, 'credentials'), 'utf8'), 'login');
  const laneConfig = fs.readFileSync(path.join(built.home, 'config.toml'), 'utf8');
  assert.match(laneConfig, /^default_model = "k3"\n/);
  assert.match(laneConfig, /# <<< glimmervoid hooks <<<\n\n\[\[hooks\]\]\nevent = "PreToolUse"\nmatcher = '\^mcp__posthog__'\ncommand = '.*posthog-read-gate.* posthog \|\| exit 2'\n$/);
  await prepared.cleanup();
  assert.equal(fs.existsSync(built.home), false);

  for (const renamedByKimi of ['posthog__prod', `posthog-${'x'.repeat(52)}`]) {
    fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { [renamedByKimi]: operatorPosthogEntry } }));
    assert.equal(await prepareLaneMcp({ laneArgs: [], agent: 'kimi' }, { kimiHome }), null, renamedByKimi);
  }

  fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { posthog: operatorPosthogEntry } }));
  fs.writeFileSync(path.join(kimiHome, 'config.toml'), 'hooks = []\n');
  const refusedLane = await prepareLaneMcp({ laneArgs: [], agent: 'kimi' }, { kimiHome });
  assert.ok(refusedLane?.scratchAgentHome);
  assert.ok('refusal' in injection.prepareScratchHome(env, refusedLane.scratchAgentHome));
  await refusedLane.cleanup();
});
