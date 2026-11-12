import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import copilot from '../session/adapters/copilot.ts';
import kimi from '../session/adapters/kimi.ts';
import { BLOCK_END, BLOCK_START, GEMINI_HOME_PROFILE, KIMI_HOME_PROFILE, QWEN_HOME_PROFILE, renderCodexHooksBlock } from '../session/core/agent-home-core.ts';
import { loadFileLocks } from '../server/session-temp/session-temp-locks.ts';
import { createPackSessionFiles } from '../server/packs/pack-session-files.ts';
import { generatedAgentHomePath, holdAgentHome, prepareAgentHome, releaseAgentHome, releaseEveryUnheldAgentHomeSecrets, releaseUnheldAgentHomeSecrets } from '../session/agent-home.ts';

const KIMI_LAUNCH = { listenerPort: 41234, folderTrustRoot: os.tmpdir(), isCleanHome: false };
const OPERATOR_CONFIG = 'default_model = "kimi-code/k3.1-pro"\r\n\n[models."kimi-code/k3.1-pro"]\ndisplay_name = "K3.1 Pro"\n';
const HAND_EDITED_OLD_BLOCK = `${BLOCK_START}\n[[hooks]]\nevent = "Stop"\ncommand = 'curl https://example.invalid'\n${BLOCK_END}\n`;

interface KimiHomes {
  realHome: string;
  env: Record<string, string>;
}

function withKimiHomes(run: (homes: KimiHomes) => void): void {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-kimi-'));
  const realHome = path.join(scratchRoot, '.kimi-code');
  fs.mkdirSync(path.join(realHome, 'credentials'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(realHome, 'device_id'), 'device-1\n');
  try {
    run({ realHome, env: { KIMI_CODE_HOME: realHome, GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') } });
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function prepare(env: Record<string, string>): string {
  const hooksBlock = kimi.expectedHooksBlock();
  assert.ok(hooksBlock);
  const prepared = prepareAgentHome(KIMI_HOME_PROFILE, { env, renderBlock: () => hooksBlock });
  assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
  return prepared.home;
}

test('a kimi spawn gets a generated home that shares the real home and never writes the real config', () => {
  withKimiHomes(({ realHome, env }) => {
    const realConfigPath = path.join(realHome, 'config.toml');
    const realConfig = `${OPERATOR_CONFIG}${HAND_EDITED_OLD_BLOCK}`;
    fs.writeFileSync(realConfigPath, realConfig);

    const generatedHome = prepare(env);
    assert.equal(generatedHome, generatedAgentHomePath(KIMI_HOME_PROFILE, env));
    assert.equal(fs.statSync(generatedHome).mode & 0o777, 0o700);
    const generatedConfigPath = path.join(generatedHome, 'config.toml');
    const generatedConfig = fs.readFileSync(generatedConfigPath, 'utf8');
    assert.equal(generatedConfig, `${OPERATOR_CONFIG}\n${kimi.expectedHooksBlock()}`);
    assert.equal(generatedConfig.split(BLOCK_START).length, 2);
    assert.equal(fs.statSync(generatedConfigPath).mode & 0o777, 0o600);

    fs.writeFileSync(path.join(generatedHome, 'credentials', 'kimi-code.json'), '{"refreshed":true}');
    assert.equal(fs.readFileSync(path.join(realHome, 'credentials', 'kimi-code.json'), 'utf8'), '{"refreshed":true}');
    assert.equal(fs.readFileSync(path.join(generatedHome, 'device_id'), 'utf8'), 'device-1\n');
    assert.equal(fs.existsSync(path.join(realHome, 'sessions')), false);

    const sessionEdit = `${generatedConfig}\n[tui]\ntheme = "dark"\n`;
    fs.writeFileSync(generatedConfigPath, sessionEdit);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8'), sessionEdit);

    fs.writeFileSync(generatedConfigPath, OPERATOR_CONFIG);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8').split(BLOCK_START).length, 2);

    fs.mkdirSync(path.join(realHome, 'sessions'));
    prepare(env);
    assert.equal(fs.realpathSync(path.join(generatedHome, 'sessions')), fs.realpathSync(path.join(realHome, 'sessions')));
    assert.equal(fs.readFileSync(realConfigPath, 'utf8'), realConfig);

    const sessionModelEdit = fs.readFileSync(generatedConfigPath, 'utf8').replace('default_model = "kimi-code/k3.1-pro"', 'default_model = "kimi-code/k3.1-flash"');
    fs.writeFileSync(generatedConfigPath, sessionModelEdit);
    fs.writeFileSync(realConfigPath, `${realConfig}\n[ui]\ntheme = "light"\n`);
    prepare(env);
    const mergedConfig = fs.readFileSync(generatedConfigPath, 'utf8');
    assert.match(mergedConfig, /default_model = "kimi-code\/k3\.1-flash"/);
    assert.match(mergedConfig, /\[ui\]\ntheme = "light"/);
    assert.equal(mergedConfig.split(BLOCK_START).length, 2);
    assert.equal(fs.statSync(path.join(generatedHome, '.glimmervoid-base.toml')).mode & 0o777, 0o600);

    const kimiRewriteWithoutMarkers = fs.readFileSync(generatedConfigPath, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n');
    fs.writeFileSync(generatedConfigPath, kimiRewriteWithoutMarkers);
    fs.writeFileSync(realConfigPath, `${realConfig}\n[ui]\ntheme = "dark"\n`);
    prepare(env);
    assert.equal(fs.readFileSync(generatedConfigPath, 'utf8').split('[[hooks]]').length, kimi.expectedHooksBlock()?.split('[[hooks]]').length);

    const locks = loadFileLocks();
    assert.ok(locks);
    const otherInstanceLock = fs.openSync(path.join(generatedHome, '.glimmervoid-in-use.lock'), 'a+');
    locks.waitForLockSync(otherInstanceLock, { shared: true });
    releaseUnheldAgentHomeSecrets(generatedHome);
    holdAgentHome(generatedHome);
    releaseAgentHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), true);
    locks.unlock(otherInstanceLock);
    fs.closeSync(otherInstanceLock);

    holdAgentHome(generatedHome);
    holdAgentHome(generatedHome);
    releaseAgentHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), true);
    releaseAgentHome(generatedHome);
    assert.equal(fs.existsSync(generatedConfigPath), false);
    assert.equal(fs.existsSync(path.join(generatedHome, '.glimmervoid-base.toml')), false);
    assert.equal(fs.readFileSync(path.join(generatedHome, 'device_id'), 'utf8'), 'device-1\n');
  });
});

test('a kimi spawn refuses a real config whose own hooks key a [[hooks]] block would redefine', () => {
  withKimiHomes(({ realHome, env }) => {
    const inlineHooks = `hooks = [{ event = "Stop", command = "say done" }]\n${OPERATOR_CONFIG}`;
    fs.writeFileSync(path.join(realHome, 'config.toml'), inlineHooks);
    const hooksBlock = kimi.expectedHooksBlock();
    assert.ok(hooksBlock);
    const prepared = prepareAgentHome(KIMI_HOME_PROFILE, { env, renderBlock: () => hooksBlock });
    assert.ok('refusal' in prepared);
    assert.match(prepared.refusal, /\[hooks\] table/);
    assert.equal(fs.existsSync(path.join(generatedAgentHomePath(KIMI_HOME_PROFILE, env), 'config.toml')), false);
    assert.equal(fs.readFileSync(path.join(realHome, 'config.toml'), 'utf8'), inlineHooks);
  });
});

test('a kimi spawn heals a file kimi replaced and adopts a private folder once the real home grows it', () => {
  withKimiHomes(({ realHome, env }) => {
    const generatedHome = prepare(env);
    const realDevicePath = path.join(realHome, 'device_id');
    const generatedDevicePath = path.join(generatedHome, 'device_id');

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-2\n');
    prepare(env);
    assert.equal(fs.readFileSync(realDevicePath, 'utf8'), 'device-2\n');
    assert.equal(fs.lstatSync(generatedDevicePath).isSymbolicLink(), true);

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-3\n');
    fs.writeFileSync(realDevicePath, 'device-from-operator\n');
    prepare(env);
    assert.equal(fs.readFileSync(realDevicePath, 'utf8'), 'device-from-operator\n');
    assert.equal(fs.readFileSync(generatedDevicePath, 'utf8'), 'device-from-operator\n');

    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-4\n');
    fs.writeFileSync(realDevicePath, 'device-from-operator-again\n');
    prepare(env);
    const conflictsFolder = path.join(generatedHome, '.glimmervoid-conflicts');
    const setAsideContents = fs.readdirSync(conflictsFolder).map((name) => fs.readFileSync(path.join(conflictsFolder, name), 'utf8'));
    assert.deepEqual(setAsideContents.sort(), ['device-3\n', 'device-4\n']);

    const dotfilesDevicePath = path.join(path.dirname(realHome), 'dotfiles-device_id');
    fs.writeFileSync(dotfilesDevicePath, 'device-dotfiles\n');
    fs.rmSync(realDevicePath);
    fs.symlinkSync(dotfilesDevicePath, realDevicePath);
    prepare(env);
    fs.rmSync(generatedDevicePath);
    fs.writeFileSync(generatedDevicePath, 'device-5\n');
    prepare(env);
    assert.equal(fs.lstatSync(realDevicePath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(dotfilesDevicePath, 'utf8'), 'device-5\n');
    assert.deepEqual(fs.readdirSync(realHome).filter((name) => name.includes('glimmervoid')), []);

    fs.mkdirSync(path.join(generatedHome, 'sessions', 'session_b'), { recursive: true });
    fs.mkdirSync(path.join(generatedHome, 'logs'));
    fs.writeFileSync(path.join(generatedHome, 'logs', 'kimi.log'), 'private\n');
    fs.mkdirSync(path.join(realHome, 'sessions', 'session_a'), { recursive: true });
    fs.mkdirSync(path.join(realHome, 'logs'));
    fs.writeFileSync(path.join(realHome, 'logs', 'kimi.log'), 'real\n');
    prepare(env);
    assert.deepEqual(fs.readdirSync(path.join(realHome, 'sessions')).sort(), ['session_a', 'session_b']);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'sessions')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'logs')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(realHome, 'logs', 'kimi.log'), 'utf8'), 'real\n');

    fs.mkdirSync(path.join(generatedHome, 'cache', 'blob'), { recursive: true });
    fs.mkdirSync(path.join(realHome, 'cache'), { mode: 0o555 });
    prepare(env);
    assert.equal(fs.lstatSync(path.join(generatedHome, 'cache')).isDirectory(), true);
    fs.chmodSync(path.join(realHome, 'cache'), 0o755);
  });
});

test('a clean kimi home keeps credentials and models but leaves out the operator instructions, skills, plugins and hooks', () => {
  withKimiHomes(({ realHome, env }) => {
    fs.writeFileSync(path.join(realHome, 'config.toml'), `${OPERATOR_CONFIG}\n[[hooks]]\nevent = "Stop"\ncommand = 'operator-hook'\n`);
    fs.writeFileSync(path.join(realHome, 'AGENTS.md'), 'Always answer in French.\n');
    fs.mkdirSync(path.join(realHome, 'skills', 'mine'), { recursive: true });
    fs.mkdirSync(path.join(realHome, 'plugins'));
    assert.equal(kimi.hooks.injection.kind, 'generated-home');
    if (kimi.hooks.injection.kind !== 'generated-home') return;
    const clean = kimi.hooks.injection.prepareHome(env, { ...KIMI_LAUNCH, isCleanHome: true });
    assert.ok('home' in clean, 'refusal' in clean ? clean.refusal : '');
    const operator = kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH);
    assert.ok('home' in operator, 'refusal' in operator ? operator.refusal : '');
    try {
      assert.notEqual(clean.home, operator.home);
      for (const name of ['AGENTS.md', 'skills', 'plugins']) {
        assert.equal(fs.existsSync(path.join(clean.home, name)), false, `${name} stays out of the clean home`);
        assert.equal(fs.existsSync(path.join(operator.home, name)), true, `${name} stays in the operator home`);
      }
      assert.equal(fs.existsSync(path.join(clean.home, 'credentials')), true);
      const cleanConfig = fs.readFileSync(path.join(clean.home, 'config.toml'), 'utf8');
      assert.match(cleanConfig, /default_model = "kimi-code\/k3\.1-pro"/);
      assert.match(cleanConfig, /display_name = "K3\.1 Pro"/);
      assert.doesNotMatch(cleanConfig, /operator-hook/);
      assert.ok(cleanConfig.includes(BLOCK_START), 'the Glimmervoid hooks block stays');
      assert.match(fs.readFileSync(path.join(operator.home, 'config.toml'), 'utf8'), /operator-hook/);
    } finally {
      kimi.hooks.injection.releaseHome(clean.home);
      kimi.hooks.injection.releaseHome(operator.home);
    }
  });
});

test('the startup sweep removes the config copies a crash left in both the operator and the clean generated home', () => {
  withKimiHomes(({ env }) => {
    const leftHomes = [generatedAgentHomePath(KIMI_HOME_PROFILE, env), generatedAgentHomePath(KIMI_HOME_PROFILE, env, undefined, true)];
    for (const home of leftHomes) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.toml'), OPERATOR_CONFIG);
      fs.writeFileSync(path.join(home, '.glimmervoid-base.toml'), OPERATOR_CONFIG);
    }
    releaseEveryUnheldAgentHomeSecrets(env);
    for (const home of leftHomes) {
      assert.equal(fs.existsSync(path.join(home, 'config.toml')), false, `${home} config copy removed`);
      assert.equal(fs.existsSync(path.join(home, '.glimmervoid-base.toml')), false, `${home} base copy removed`);
    }
  });
});

test('a kimi spawn refuses a generated home a session swapped for a symlink or a file and writes nothing through it', () => {
  withKimiHomes(({ env }) => {
    const generatedHome = generatedAgentHomePath(KIMI_HOME_PROFILE, env);
    const swapTarget = path.join(path.dirname(env.GLIMMERVOID_HOME), 'swap-target');
    fs.mkdirSync(swapTarget);
    fs.mkdirSync(path.dirname(generatedHome), { recursive: true });
    fs.symlinkSync(swapTarget, generatedHome);
    const prepared = kimi.hooks.injection.kind === 'generated-home' ? kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH) : null;
    assert.ok(prepared && 'refusal' in prepared);
    assert.deepEqual(fs.readdirSync(swapTarget), []);
    fs.unlinkSync(generatedHome);
    fs.writeFileSync(generatedHome, '');
    const preparedOverFile = kimi.hooks.injection.kind === 'generated-home' ? kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH) : null;
    assert.ok(preparedOverFile && 'refusal' in preparedOverFile);
  });
});

test('a kimi spawn loads the operator MCP servers beside the Glimmervoid server, keeps a server a session added, and leaves the real mcp.json alone', () => {
  withKimiHomes(({ realHome, env }) => {
    const operatorMcpJson = JSON.stringify({ mcpServers: { docs: { transport: 'http', url: 'https://docs.example/mcp' } } });
    fs.writeFileSync(path.join(realHome, 'mcp.json'), operatorMcpJson);
    const generatedHome = generatedAgentHomePath(KIMI_HOME_PROFILE, env);
    fs.mkdirSync(generatedHome, { recursive: true });
    fs.writeFileSync(path.join(generatedHome, 'mcp.json'), JSON.stringify({ mcpServers: { legacy: { transport: 'http', url: 'https://legacy.example/mcp' } } }));
    assert.equal(kimi.hooks.injection.kind, 'generated-home');
    if (kimi.hooks.injection.kind !== 'generated-home') return;
    const prepared = kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH);
    assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
    try {
      const generatedMcp = JSON.parse(fs.readFileSync(path.join(prepared.home, 'mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(generatedMcp.mcpServers).sort(), ['docs', 'glimmervoid', 'legacy']);
      assert.equal(generatedMcp.mcpServers.glimmervoid.url, 'http://127.0.0.1:41234/mcp');
      assert.equal(generatedMcp.mcpServers.glimmervoid.bearerTokenEnvVar, 'GLIMMERVOID_MCP_TOKEN');
      assert.equal(fs.readFileSync(path.join(realHome, 'mcp.json'), 'utf8'), operatorMcpJson);

      generatedMcp.mcpServers.notes = { transport: 'http', url: 'https://notes.example/mcp' };
      fs.writeFileSync(path.join(prepared.home, 'mcp.json'), JSON.stringify(generatedMcp));
      const operatorEditedMcpJson = JSON.stringify({ mcpServers: { docs: { transport: 'http', url: 'https://docs.example/v2/mcp' } } });
      fs.writeFileSync(path.join(realHome, 'mcp.json'), operatorEditedMcpJson);
      kimi.hooks.injection.releaseHome(prepared.home);
      const preparedAgain = kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH);
      assert.ok('home' in preparedAgain, 'refusal' in preparedAgain ? preparedAgain.refusal : '');
      const regeneratedMcp = JSON.parse(fs.readFileSync(path.join(preparedAgain.home, 'mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(regeneratedMcp.mcpServers).sort(), ['docs', 'glimmervoid', 'legacy', 'notes']);
      assert.equal(regeneratedMcp.mcpServers.docs.url, 'https://docs.example/v2/mcp');
      assert.equal(fs.readFileSync(path.join(realHome, 'mcp.json'), 'utf8'), operatorEditedMcpJson);

      regeneratedMcp.mcpServers.docs.url = 'https://docs.example/session/mcp';
      fs.writeFileSync(path.join(preparedAgain.home, 'mcp.json'), JSON.stringify(regeneratedMcp));
      fs.writeFileSync(path.join(realHome, 'mcp.json'), '{ "mcpServers": {');
      kimi.hooks.injection.releaseHome(preparedAgain.home);
      const preparedWhileMalformed = kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH);
      assert.ok('home' in preparedWhileMalformed, 'refusal' in preparedWhileMalformed ? preparedWhileMalformed.refusal : '');
      fs.writeFileSync(path.join(realHome, 'mcp.json'), operatorEditedMcpJson);
      kimi.hooks.injection.releaseHome(preparedWhileMalformed.home);
      const preparedAfterRepair = kimi.hooks.injection.prepareHome(env, KIMI_LAUNCH);
      assert.ok('home' in preparedAfterRepair, 'refusal' in preparedAfterRepair ? preparedAfterRepair.refusal : '');
      const repairedMcp = JSON.parse(fs.readFileSync(path.join(preparedAfterRepair.home, 'mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(repairedMcp.mcpServers).sort(), ['docs', 'glimmervoid', 'legacy', 'notes']);
      assert.equal(repairedMcp.mcpServers.docs.url, 'https://docs.example/session/mcp');
    } finally {
      kimi.hooks.injection.releaseHome(prepared.home);
    }
  });
});

test('a stale operator codex trust entry for a removed hook group does not redefine the trust table of a Glimmervoid hook', () => {
  const realHome = path.join(path.sep, 'real-codex');
  const generatedHome = path.join(path.sep, 'generated-codex');
  const staleKey = `${path.join(realHome, 'config.toml')}:pre_tool_use:0:0`;
  const block = renderCodexHooksBlock({
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'relay' }],
    trustedHashes: ['sha256:glimmervoid'],
    projectHookTrust: [],
    operatorText: `[hooks.state.${JSON.stringify(staleKey)}]\ntrusted_hash = "sha256:stale"\n`,
    realHome,
    generatedHome,
    trustedFolders: [],
  });
  const trustHeaders = block.split('\n').filter((line) => line.startsWith('[hooks.state.'));
  assert.equal(new Set(trustHeaders).size, trustHeaders.length, block);
  assert.ok(block.includes('trusted_hash = "sha256:glimmervoid"'), block);
  assert.ok(!block.includes('sha256:stale'), block);
});

test('a codex block trusts each listed project hook once and leaves a key the operator config already defines to the operator', () => {
  const listedKey = '/repos/main/.codex/hooks.json:session_start:0:0';
  const operatorKey = '/repos/main/.codex/hooks.json:stop:0:0';
  const block = renderCodexHooksBlock({
    hooks: [],
    trustedHashes: null,
    projectHookTrust: [
      { key: listedKey, currentHash: 'sha256:project' },
      { key: listedKey, currentHash: 'sha256:project' },
      { key: operatorKey, currentHash: 'sha256:listed' },
    ],
    operatorText: `[hooks.state.${JSON.stringify(operatorKey)}]\ntrusted_hash = "sha256:operator"\n`,
    realHome: path.join(path.sep, 'real-codex'),
    generatedHome: path.join(path.sep, 'generated-codex'),
    trustedFolders: [],
  });
  assert.equal(block.split(`[hooks.state.${JSON.stringify(listedKey)}]\ntrusted_hash = "sha256:project"`).length, 2, block);
  assert.ok(!block.includes(operatorKey), block);
  const operatorForms = [
    `[hooks.state.${JSON.stringify(operatorKey)}] # trusted by hand\ntrusted_hash = "sha256:operator"\n`,
    `[hooks.state]\n${JSON.stringify(operatorKey)} = { trusted_hash = "sha256:operator" }\n`,
  ];
  for (const operatorText of operatorForms) {
    const formBlock = renderCodexHooksBlock({
      hooks: [],
      trustedHashes: null,
      projectHookTrust: [{ key: operatorKey, currentHash: 'sha256:listed' }],
      operatorText,
      realHome: path.join(path.sep, 'real-codex'),
      generatedHome: path.join(path.sep, 'generated-codex'),
      trustedFolders: [],
    });
    assert.ok(!formBlock.includes(operatorKey), formBlock);
  }
});

test('a codex session folder the operator config already declares in any toml form keeps only the operator entry', () => {
  const declaredFolder = path.join(path.sep, 'repos', 'declared');
  const newFolder = path.join(path.sep, 'repos', 'new');
  const declaredKey = JSON.stringify(declaredFolder);
  const operatorDeclarations = [
    `[projects.${declaredKey}]\ntrust_level = "untrusted"\n`,
    `[projects]\n${declaredKey} = { trust_level = "untrusted" }\n`,
    `[projects]\n${declaredKey}.trust_level = "untrusted"\n`,
    `projects.${declaredKey}.trust_level = "untrusted"\n`,
  ];
  for (const operatorText of operatorDeclarations) {
    const block = renderCodexHooksBlock({
      hooks: [],
      trustedHashes: null,
      projectHookTrust: [],
      operatorText,
      realHome: path.join(path.sep, 'real-codex'),
      generatedHome: path.join(path.sep, 'generated-codex'),
      trustedFolders: [declaredFolder, newFolder],
    });
    assert.ok(!block.includes(declaredKey), block);
    assert.ok(block.includes(`[projects.${JSON.stringify(newFolder)}]\ntrust_level = "trusted"`), block);
  }
});

test('an operator projects inline table gets no codex folder trust tables', () => {
  const block = renderCodexHooksBlock({
    hooks: [],
    trustedHashes: null,
    projectHookTrust: [],
    operatorText: 'projects = { "/repos/other" = { trust_level = "trusted" } }\n',
    realHome: path.join(path.sep, 'real-codex'),
    generatedHome: path.join(path.sep, 'generated-codex'),
    trustedFolders: [path.join(path.sep, 'repos', 'new')],
  });
  assert.ok(!block.includes('[projects.'), block);
});

test('a gemini spawn merges the hooks into a JSON copy of the real settings, keeps a session edit, and never writes the real settings', () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-gemini-'));
  try {
    const realHome = path.join(scratchRoot, 'gemini-cli-home', '.gemini');
    fs.mkdirSync(path.join(realHome, 'tmp'), { recursive: true });
    const realSettingsPath = path.join(realHome, 'settings.json');
    const operatorHook = { hooks: [{ type: 'command', command: 'say done' }] };
    const realSettings = `{\n  // operator note\n  "ui": { "theme": "GitHub" },\n  "hooks": { "AfterAgent": [${JSON.stringify(operatorHook)}] },\n}\n`;
    fs.writeFileSync(realSettingsPath, realSettings);
    const env = { GEMINI_CLI_HOME: path.dirname(realHome), GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') };
    const managedHook = { hooks: [{ type: 'command', command: 'node relay.js AfterAgent' }] };
    const renderBlock = () => JSON.stringify({ AfterAgent: [managedHook] });
    function prepareGemini(platform: NodeJS.Platform = process.platform): string {
      const prepared = prepareAgentHome(GEMINI_HOME_PROFILE, { env, renderBlock, platform });
      assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
      return prepared.home;
    }

    const generatedHome = prepareGemini();
    assert.equal(path.basename(generatedHome), '.gemini');
    const generatedSettingsPath = path.join(generatedHome, 'settings.json');
    const generated = JSON.parse(fs.readFileSync(generatedSettingsPath, 'utf8'));
    assert.deepEqual(generated.hooks.AfterAgent, [operatorHook, managedHook]);
    assert.equal(fs.realpathSync(path.join(generatedHome, 'tmp')), fs.realpathSync(path.join(realHome, 'tmp')));

    fs.writeFileSync(generatedSettingsPath, JSON.stringify({ ...generated, ui: { theme: 'Dracula' } }));
    fs.writeFileSync(realSettingsPath, realSettings.replace('"ui"', '"general": { "vimMode": true },\n  "ui"'));
    prepareGemini();
    const merged = JSON.parse(fs.readFileSync(generatedSettingsPath, 'utf8'));
    assert.deepEqual(merged.ui, { theme: 'Dracula' });
    assert.deepEqual(merged.general, { vimMode: true });
    assert.deepEqual(merged.hooks.AfterAgent, [operatorHook, managedHook]);
    assert.match(fs.readFileSync(realSettingsPath, 'utf8'), /operator note/);

    holdAgentHome(generatedHome);
    releaseAgentHome(generatedHome);
    assert.equal(fs.existsSync(generatedSettingsPath), false);

    fs.rmSync(realSettingsPath);
    const unsetHome = prepareGemini();
    const unsetSettingsPath = path.join(unsetHome, 'settings.json');
    const firstRun = JSON.parse(fs.readFileSync(unsetSettingsPath, 'utf8'));
    fs.writeFileSync(unsetSettingsPath, JSON.stringify({ ...firstRun, security: { auth: { selectedType: 'oauth-personal' } } }));
    prepareGemini();
    const afterSecondSpawn = JSON.parse(fs.readFileSync(unsetSettingsPath, 'utf8'));
    assert.deepEqual(afterSecondSpawn.security, { auth: { selectedType: 'oauth-personal' } });
    assert.deepEqual(afterSecondSpawn.hooks.AfterAgent, [managedHook]);
    assert.equal(fs.existsSync(realSettingsPath), false);

    fs.writeFileSync(realSettingsPath, JSON.stringify({ hooksConfig: { enabled: false }, hooks: { AfterAgent: [operatorHook] } }));
    const realRoot = path.dirname(realHome);
    fs.writeFileSync(path.join(realRoot, 'settings.json'), JSON.stringify({ advanced: { autoConfigureMemory: false } }));
    fs.mkdirSync(path.join(realRoot, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(realRoot, '.env'), 'GEMINI_API_KEY=operator\n');
    const generatedRoot = path.dirname(prepareGemini());
    const hooksOff = JSON.parse(fs.readFileSync(unsetSettingsPath, 'utf8'));
    assert.deepEqual(hooksOff.hooksConfig, { enabled: true });
    assert.deepEqual(hooksOff.hooks.AfterAgent, [managedHook]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(generatedRoot, 'settings.json'), 'utf8')), { advanced: { autoConfigureMemory: false } });
    assert.equal(fs.realpathSync(path.join(generatedRoot, '.agents')), fs.realpathSync(path.join(realRoot, '.agents')));
    assert.equal(fs.readFileSync(path.join(generatedRoot, '.env'), 'utf8'), 'GEMINI_API_KEY=operator\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(realSettingsPath, 'utf8')).hooksConfig, { enabled: false });

    fs.unlinkSync(path.join(generatedRoot, '.env'));
    prepareGemini('win32');
    fs.writeFileSync(path.join(realRoot, '.env.next'), 'GEMINI_API_KEY=rotated\n');
    fs.renameSync(path.join(realRoot, '.env.next'), path.join(realRoot, '.env'));
    prepareGemini('win32');
    assert.equal(fs.readFileSync(path.join(generatedRoot, '.env'), 'utf8'), 'GEMINI_API_KEY=rotated\n');
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a qwen spawn turns its hooks on where the real settings disable all hooks, drops the operator hooks, and leaves the real settings alone', () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-qwen-'));
  try {
    const realHome = path.join(scratchRoot, 'qwen-home');
    fs.mkdirSync(realHome);
    const realSettingsPath = path.join(realHome, 'settings.json');
    const realSettings = JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, ui: { theme: 'Qwen Dark' } });
    fs.writeFileSync(realSettingsPath, realSettings);
    const managedHook = { hooks: [{ type: 'command', command: 'node relay.js Stop' }] };
    const prepared = prepareAgentHome(QWEN_HOME_PROFILE, {
      env: { QWEN_HOME: realHome, GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') },
      renderBlock: () => JSON.stringify({ Stop: [managedHook] }),
    });
    assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
    const generated = JSON.parse(fs.readFileSync(path.join(prepared.home, 'settings.json'), 'utf8'));
    assert.equal(generated.disableAllHooks, false);
    assert.deepEqual(generated.hooks, { Stop: [managedHook] });
    assert.deepEqual(generated.ui, { theme: 'Qwen Dark' });
    assert.equal(fs.readFileSync(realSettingsPath, 'utf8'), realSettings);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a qwen spawn copies the real settings from the home qwen itself reads, through a ~/ QWEN_HOME or one set only in its env files', () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-qwen-home-'));
  try {
    const homeDir = path.join(scratchRoot, 'home');
    const qwenHome = path.join(homeDir, 'qwen-config');
    fs.mkdirSync(qwenHome, { recursive: true });
    fs.writeFileSync(path.join(qwenHome, 'settings.json'), JSON.stringify({ model: { name: 'operator-model' } }));
    const prepareFrom = (env: Record<string, string>): { model?: { name?: string } } => {
      const prepared = prepareAgentHome(QWEN_HOME_PROFILE, { env: { ...env, GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') }, homeDir, renderBlock: () => '{}' });
      assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
      return JSON.parse(fs.readFileSync(path.join(prepared.home, 'settings.json'), 'utf8'));
    };
    assert.equal(prepareFrom({ QWEN_HOME: '~/qwen-config' }).model?.name, 'operator-model');
    fs.writeFileSync(path.join(homeDir, '.env'), 'QWEN_HOME="~/qwen-config"\n');
    assert.equal(prepareFrom({}).model?.name, 'operator-model');
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a copilot spawn trusts its folder root in the real copilot state file once, keeping the rest of the file', () => {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-copilot-'));
  try {
    const realHome = path.join(scratchRoot, 'copilot-home');
    fs.mkdirSync(realHome);
    const statePath = path.join(realHome, 'config.json');
    const worktreeRoot = path.join(scratchRoot, 'worktrees');
    fs.writeFileSync(statePath, `// This file is managed automatically.\n${JSON.stringify({ firstLaunchAt: 'then', trustedFolders: ['/elsewhere'] })}\n`);
    const env = { COPILOT_HOME: realHome, GLIMMERVOID_HOME: path.join(scratchRoot, 'glimmervoid') };
    assert.equal(copilot.hooks.injection.kind, 'generated-home');
    const prepareWithRoot = (folderTrustRoot: string) => copilot.hooks.injection.kind === 'generated-home' ? copilot.hooks.injection.prepareHome(env, { listenerPort: 41234, folderTrustRoot, isCleanHome: false }) : null;
    const prepared = prepareWithRoot(worktreeRoot);
    assert.ok(prepared && 'home' in prepared);
    const stateText = fs.readFileSync(statePath, 'utf8');
    assert.ok(stateText.startsWith('// This file is managed automatically.\n'), stateText);
    const state = JSON.parse(stateText.split('\n').slice(1).join('\n'));
    assert.deepEqual(state, { firstLaunchAt: 'then', trustedFolders: ['/elsewhere', worktreeRoot] });
    copilot.hooks.injection.releaseHome(prepared.home);
    const preparedAgain = prepareWithRoot(path.join(worktreeRoot, 'session-one'));
    assert.ok(preparedAgain && 'home' in preparedAgain);
    assert.equal(fs.readFileSync(statePath, 'utf8'), stateText);
    const sessionStatePath = path.join(preparedAgain.home, 'config.json');
    fs.rmSync(sessionStatePath);
    fs.writeFileSync(sessionStatePath, JSON.stringify({ ...state, loggedInUsers: [{ login: 'operator' }] }));
    copilot.hooks.injection.releaseHome(preparedAgain.home);
    const otherRoot = path.join(scratchRoot, 'other');
    prepareWithRoot(otherRoot);
    const promotedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(promotedState, { firstLaunchAt: 'then', trustedFolders: ['/elsewhere', worktreeRoot, otherRoot], loggedInUsers: [{ login: 'operator' }] });
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a kimi home carries approved pack skills as namespaced copies beside the operator skills, keeps an agent-written skill, and gives the real skills folder back untouched once no pack has skills', async () => {
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-skills-'));
  try {
    const packSessionFiles = createPackSessionFiles({ root: packRoot });
    const skillText = '---\nname: deploy\ndescription: Ship it\n---\nSay REDLYNX.\n';
    const skill = (skillName: string) => ({ skillName, filesByPath: new Map([['SKILL.md', Buffer.from(skillText)], ['run.sh', Buffer.from('echo run\n')]]) });
    await packSessionFiles.sync([{ packName: 'acme', fingerprint: 'f'.repeat(64), context: null, skills: [skill('deploy'), skill('mine')] }]);
    const packSkillDirs = packSessionFiles.launch()?.namedSkillDirs ?? [];
    withKimiHomes(({ realHome, env }) => {
      assert.equal(kimi.hooks.injection.kind, 'generated-home');
      if (kimi.hooks.injection.kind !== 'generated-home') return;
      const injection = kimi.hooks.injection;
      fs.mkdirSync(path.join(realHome, 'skills', 'acme-mine'), { recursive: true });
      fs.writeFileSync(path.join(realHome, 'skills', 'acme-mine', 'SKILL.md'), 'operator skill\n');
      const prepared = injection.prepareHome(env, { ...KIMI_LAUNCH, packSkillDirs });
      assert.ok('home' in prepared, 'refusal' in prepared ? prepared.refusal : '');
      const generatedSkills = path.join(prepared.home, 'skills');
      try {
        assert.equal(fs.lstatSync(generatedSkills).isDirectory(), true);
        assert.match(fs.readFileSync(path.join(generatedSkills, 'acme-deploy', 'SKILL.md'), 'utf8'), /^---\nname: acme-deploy\ndescription: Ship it\n---\nSay REDLYNX\.\n$/);
        assert.equal(fs.readFileSync(path.join(generatedSkills, 'acme-mine', 'SKILL.md'), 'utf8'), 'operator skill\n');
        fs.mkdirSync(path.join(generatedSkills, 'agent-made'));
        injection.releaseHome(prepared.home);
        const preparedAgain = injection.prepareHome(env, { ...KIMI_LAUNCH, packSkillDirs });
        assert.ok('home' in preparedAgain, 'refusal' in preparedAgain ? preparedAgain.refusal : '');
        assert.equal(fs.existsSync(path.join(generatedSkills, 'agent-made')), true);
        injection.releaseHome(preparedAgain.home);
        const preparedWithoutPacks = injection.prepareHome(env, KIMI_LAUNCH);
        assert.ok('home' in preparedWithoutPacks, 'refusal' in preparedWithoutPacks ? preparedWithoutPacks.refusal : '');
        assert.equal(fs.realpathSync(generatedSkills), fs.realpathSync(path.join(realHome, 'skills')));
        assert.deepEqual(fs.readdirSync(path.join(realHome, 'skills')), ['acme-mine']);
      } finally {
        injection.releaseHome(prepared.home);
      }
    });
  } finally {
    fs.rmSync(packRoot, { recursive: true, force: true });
  }
});
