import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { encodeProjectDir } from '../session/core/conversation-history.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { writeSessionSettings } from '../detection/settings-injector.ts';
import claudeCode from '../session/adapters/claude-code.ts';
import codex from '../session/adapters/codex.ts';
import * as adapters from '../session/adapters/index.ts';
import { validateConfig } from '../server/config-store.ts';
import { BUILTIN_AGENT_IDS, CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { STATES } from '../shared/states.ts';
import { execFileSync } from 'node:child_process';
import { fakePty } from './helpers/fake-pty.ts';
import type { HookSignal } from '../detection/hook-source.ts';
import type { HookPayload } from '../shared/contracts/index.ts';

interface AdapterSpawnCall {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
}
const REPO_ROOT = path.join(import.meta.dirname, '..');
const RESUME_ID = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

function tmpHooksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-adapter-'));
}

test('the registry exposes claude-code as the default and refuses an unknown id', () => {
  assert.equal(adapters.DEFAULT_AGENT_ID, 'claude-code');
  assert.deepEqual(adapters.listAgentIds(), ['claude-code', 'codex', 'grok']);
  assert.equal(adapters.isKnownAgentId('claude-code'), true);
  assert.equal(adapters.isKnownAgentId('gemini'), false);
  assert.equal(adapters.getAdapter('gemini'), null);
  assert.equal(adapters.getAdapter(null), claudeCode);
});

test('an unknown agent id warns and falls back to the default rather than failing', () => {
  const warnings: string[] = [];
  const adapter = adapters.resolveAdapter('gemini', { warn: (m: string) => { warnings.push(m); }, label: 'session:x' });
  assert.equal(adapter, claudeCode);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown agent "gemini"/);
});

test('claude-code declares every capability, since it is the reference implementation', () => {
  assert.deepEqual(Object.keys(claudeCode.capabilities).sort(), [
    'antiSlop', 'awaitingInput', 'backgroundAgents', 'compactQuiet', 'headless', 'hooks',
    'packNotice', 'packs', 'resume', 'rtk', 'skipPermissionsFlag', 'statusLine',
  ]);
  assert.equal(Object.values(claudeCode.capabilities).every((v) => v === true), true);
});

test('buildArgs keeps the pre-extraction order: perms, resume, lane flags, anti-slop, prompt last', () => {
  const args = claudeCode.buildArgs({
    dangerouslySkipPermissions: true,
    resumeSessionId: RESUME_ID,
    extraArgs: ['-p', '--model', 'sonnet'],
    antiSlopPrompt: true,
    initialPrompt: 'THE PROMPT',
  });
  assert.deepEqual(args.slice(0, 6), [
    '--dangerously-skip-permissions', '--resume', RESUME_ID, '-p', '--model', 'sonnet',
  ]);
  assert.equal(args[6], '--append-system-prompt');
  assert.equal(args[args.length - 1], 'THE PROMPT');
  assert.deepEqual(claudeCode.buildArgs(), [], 'a plain user session adds nothing');
});

test('renderPackArgs keeps the existing Claude --add-dir loop byte-identical', () => {
  assert.deepEqual(claudeCode.renderPackArgs([
    { name: 'alpha', dir: '/packs/alpha/current' },
    { name: 'beta', dir: '/packs/beta/current' },
  ]), [
    '--add-dir', '/packs/alpha/current',
    '--add-dir', '/packs/beta/current',
  ]);
  assert.deepEqual(claudeCode.renderPackArgs([]), []);
});

test('spawn argv for a fully featured session is byte-identical to the pre-extraction one', async () => {
  const hooksBaseDir = tmpHooksDir();
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = hooksBaseDir;
  const transcriptPath = path.join(
    hooksBaseDir,
    'projects',
    encodeProjectDir(process.cwd()),
    `${RESUME_ID}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const calls: AdapterSpawnCall[] = [];
  const session = new Session({
    id: 'capture-session',
    name: 'capture',
    path: process.cwd(),
    dangerouslySkipPermissions: true,
    resumeSessionId: RESUME_ID,
    extraClaudeArgs: ['-p', '--model', 'sonnet'],
    antiSlopPrompt: true,
    initialPrompt: 'THE PROMPT',
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    planLimits: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, env: opts.env ?? {} }); return fakePty(); },
  });
  try {
    await session.start();
    const { args, env } = calls[0];
    const settingsPath = path.join(hooksBaseDir, 'capture-session', 'settings.json');
    assert.deepEqual(args.slice(0, 9), [
      '--settings', settingsPath,
      '--dangerously-skip-permissions',
      '--resume', RESUME_ID,
      '-p', '--model', 'sonnet',
      '--append-system-prompt',
    ]);
    assert.equal(args[args.length - 1], 'THE PROMPT');
    assert.equal(args.length, 11);
    assert.equal(env.CLAUDE_CODE_NO_FLICKER, '1');
    assert.equal('CLAUDECODE' in env, false);
    assert.equal('GLIMMERVOID_PORT' in env, false);
    assert.equal('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in env, false, 'no packs delivered');
  } finally {
    session.destroy();
    if (previousClaudeConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
    if (previousClaudeConfigDir != null) process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    fs.rmSync(hooksBaseDir, { recursive: true, force: true });
  }
});

test('the settings file a session injects is byte-identical to the injector run with its options', async () => {
  const hooksBaseDir = tmpHooksDir();
  const expectedBaseDir = tmpHooksDir();
  const session = new Session({
    id: 'settings-session',
    name: 'settings',
    path: process.cwd(),
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    planLimits: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  try {
    await session.start();
    const written = fs.readFileSync(path.join(hooksBaseDir, 'settings-session', 'settings.json'), 'utf8');
    const token = written.match(/\?t=([a-f0-9]+)/)?.[1];
    const expected = writeSessionSettings({
      port: 41234,
      glimmervoidId: 'settings-session',
      baseDir: expectedBaseDir,
      token,
      permissions: null,
      detectScheduledWakeups: true,
      enableProjectMcp: false,
      rtkPath: null,
      planLimits: true,
    });
    assert.equal(written, fs.readFileSync(expected.settingsPath, 'utf8'));
    const parsed = JSON.parse(written);
    assert.deepEqual(Object.keys(parsed.hooks), [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest',
      'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PostToolUse',
    ]);
  } finally {
    session.destroy();
    fs.rmSync(hooksBaseDir, { recursive: true, force: true });
    fs.rmSync(expectedBaseDir, { recursive: true, force: true });
  }
});

test('a rejected spawn cleans before PTY exit without double-cleaning on a late exit', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-rejected-spawn-'));
  const hooksBaseDir = tmpHooksDir();
  let unregisterCalls = 0;
  const hookRouter = {
    register() {},
    unregister() { unregisterCalls += 1; },
  };
  const session = new Session({
    id: 'rejected-spawn',
    name: 'rejected-spawn',
    path: projectDir,
    hookRouter,
    getHookPort: () => 41234,
    hooksBaseDir,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    platform: 'linux',
    ptySpawn: () => {
      session._packDelivery.replaceDelivered([{ name: 'rules', version: 'v1' }]);
      fs.rmSync(projectDir, { recursive: true, force: true });
      return fakePty();
    },
    signalProc: () => {
      const error: NodeJS.ErrnoException = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
  });
  try {
    await session.start();
    assert.equal(session.state, STATES.FAILED);
    assert.equal(session._hooks.token(), null);
    assert.equal(session._hooks.hasSettings(), false);
    assert.deepEqual(session._packDelivery.delivered(), []);
    assert.equal(unregisterCalls, 1);
    assert.equal(fs.existsSync(path.join(hooksBaseDir, 'rejected-spawn')), false);
    await session._handlePtyExit(1, null);
    assert.equal(unregisterCalls, 1);
    session.destroy();
    assert.equal(unregisterCalls, 1);
  } finally {
    session.destroy();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(hooksBaseDir, { recursive: true, force: true });
  }
});

const HOOK_CASES: [string, HookPayload, string | null, string | null, string | null][] = [
  ['SessionStart', {}, 'session-start', null, null],
  ['SessionEnd', {}, 'session-end', null, null],
  ['UserPromptSubmit', {}, 'resume', null, null],
  ['Stop', {}, 'ready', null, null],
  ['SubagentStart', {}, 'subagent-start', null, null],
  ['SubagentStop', {}, 'subagent-stop', null, null],
  ['TaskCreated', {}, 'task-created', null, null],
  ['TaskCompleted', {}, 'task-completed', null, null],
  ['TeammateIdle', {}, 'teammate-idle', null, null],
  ['PermissionRequest', {}, 'awaiting-input', null, 'permission'],
  ['PermissionRequest', { tool_name: 'ExitPlanMode' }, 'awaiting-input', null, 'plan'],
  ['PermissionRequest', { tool_name: 'Bash' }, 'awaiting-input', null, 'permission'],
  ['PostToolUse', { tool_name: 'ScheduleWakeup' }, 'wakeup-scheduled', null, null],
  ['PostToolUse', { tool_name: 'CronCreate' }, 'cron-created', null, null],
  ['PostToolUse', { tool_name: 'CronDelete' }, 'cron-deleted', null, null],
  ['PostToolUse', { tool_name: 'Bash' }, null, null, null],
  ['Notification', { notification_type: 'idle_prompt' }, 'ready', 'low', null],
  ['Notification', { notification_type: 'permission_prompt' }, 'awaiting-input', null, 'permission'],
  ['Notification', { notification_type: 'elicitation_request' }, 'awaiting-input', null, 'elicitation'],
  ['Notification', { notification_type: 'auth_success' }, null, null, null],
  ['PreToolUse', {}, null, null, null],
];

test('the adapter hook table reproduces every pre-extraction mapping', () => {
  for (const [event, payload, signal, confidence, promptKind] of HOOK_CASES) {
    assert.equal(claudeCode.hooks.mapSignal(event, payload), signal, `${event} signal`);
    assert.equal(claudeCode.hooks.mapConfidence(event, payload), confidence, `${event} confidence`);
    if (signal === 'awaiting-input') {
      assert.equal(claudeCode.hooks.mapPromptKind(event, payload), promptKind, `${event} promptKind`);
    }
  }
});

test('HookRouter translates with the hook profile the registration names', () => {
  const router = new HookRouter();
  const seen: HookSignal[] = [];
  router.register('s1', { token: 'tok', onSignal: (s) => seen.push(s), hooks: claudeCode.hooks });
  router.register('s2', { token: 'tok', onSignal: (s) => seen.push(s), hooks: claudeCode.hooks });
  for (const id of ['s1', 's2']) {
    const out = router.handle({ glimmervoidId: id, event: 'Notification', token: 'tok', payload: { notification_type: 'idle_prompt' } });
    assert.equal(out.signal, 'ready');
  }
  assert.deepEqual(seen.map((s) => [s.signal, s.confidence]), [['ready', 'low'], ['ready', 'low']]);
});

test('the title source classifies with the adapter profile', () => {
  assert.equal(claudeCode.titleProfile.isSpinnerChar('⠁'), true, 'braille frame');
  assert.equal(claudeCode.titleProfile.isSpinnerChar('◐'), true, 'circle-halves frame');
  assert.equal(claudeCode.titleProfile.isIdleChar('✳'), true);
  assert.equal(claudeCode.titleProfile.isIdleChar('⠁'), false);
  assert.equal(claudeCode.titleProfile.dropsLeadingAscii, true);
});

test('importing sessions.ts resolves no agent binary; the first use does, and caches it', () => {
  const probe = `
    const cp = require('node:child_process');
    const real = cp.execFileSync;
    const seen: Record<string, unknown>[] = [];
    cp.execFileSync = (file, args, opts) => { seen.push([file, ...(Array.isArray(args) ? args : [])].join(' ')); return real(file, args, opts); };
    const claudeLookups = () => seen.filter((c) => /claude/.test(c)).length;
    const sessions = require('./session/sessions.ts');
    const afterRequire = claudeLookups();
    sessions.claudeCommand();
    const afterFirstUse = claudeLookups();
    sessions.claudeCommand();
    const afterSecondUse = claudeLookups();
    process.stdout.write('RESULT' + JSON.stringify({ afterRequire, afterFirstUse, afterSecondUse }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const counts = JSON.parse(out.slice(out.indexOf('RESULT') + 'RESULT'.length));
  assert.equal(counts.afterRequire, 0, 'importing sessions.ts must not pay a PATH lookup');
  assert.ok(counts.afterFirstUse > 0, 'the first use resolves');
  assert.equal(counts.afterSecondUse, counts.afterFirstUse, 'and the registry caches it');
});

test('the command registry resolves once per agent id and re-resolves after a reset', () => {
  adapters.resetCommandCache();
  try {
    let resolutions = 0;
    const execFile = () => { resolutions += 1; return '/usr/local/bin/claude\n'; };
    const first = adapters.commandFor('claude-code', { platform: 'linux', execFile });
    const second = adapters.commandFor('claude-code', { platform: 'linux', execFile });
    assert.equal(resolutions, 1);
    assert.equal(second, first);
    assert.deepEqual(first, { path: '/usr/local/bin/claude', kind: 'shim' });
    adapters.resetCommandCache();
    adapters.commandFor('claude-code', { platform: 'linux', execFile });
    assert.equal(resolutions, 2);
  } finally {
    adapters.resetCommandCache();
  }
});

test('config accepts a builtin or declared agent id on a project and refuses every other spelling', () => {
  assert.equal(validateConfig({ projects: [{ path: '/a' }] }).ok, true);
  assert.equal(validateConfig({ projects: [{ path: '/a', agent: 'claude-code' }] }).ok, true);
  assert.equal(validateConfig({ projects: [{ path: '/a', agent: 'codex' }] }).ok, true);
  assert.equal(validateConfig({
    customAgents: [{ id: 'opencode', label: 'OpenCode', command: 'opencode' }],
    projects: [{ path: '/a', agent: 'opencode' }],
  }).ok, true);
  const undeclared = validateConfig({ projects: [{ path: '/a', agent: 'gemini' }] });
  assert.equal(undeclared.ok, false, 'a well-shaped but undeclared id never falls back to claude-code');
  assert.deepEqual(undeclared.errors, [
    'projects[0].agent "gemini" names no known agent; declare it under customAgents or use one of claude-code, codex, grok',
  ]);
  const bad = validateConfig({ projects: [{ path: '/a', agent: 'Gemini CLI' }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'projects[0].agent must be an agent id of 2 to 32 characters of lowercase letters, digits and dashes, starting with a letter',
  ]);
  const wrongType = validateConfig({ projects: [{ path: '/a', agent: 7 }] });
  assert.equal(wrongType.ok, false);
});

function declaredCustomAgent(overrides: Record<string, unknown> = {}) {
  return CustomAgentDeclaration.parse({ id: 'opencode', label: 'OpenCode', command: 'opencode', ...overrides });
}

test('a custom-agent overlay adds its id to the registry and an empty reload drops it again', () => {
  try {
    adapters.setCustomAgents([declaredCustomAgent()]);
    assert.deepEqual(adapters.listAgentIds(), ['claude-code', 'codex', 'grok', 'opencode']);
    assert.equal(adapters.isKnownAgentId('opencode'), true);
    assert.equal(adapters.getAdapter('opencode')?.label, 'OpenCode');
    adapters.setCustomAgents([]);
    assert.deepEqual(adapters.listAgentIds(), ['claude-code', 'codex', 'grok']);
    assert.equal(adapters.isKnownAgentId('opencode'), false);
    assert.equal(adapters.getAdapter('opencode'), null);
  } finally {
    adapters.setCustomAgents([]);
  }
});

test('a declaration can never shadow a builtin adapter', () => {
  try {
    adapters.setCustomAgents([declaredCustomAgent({ id: 'codex', label: 'Impostor', command: 'impostor' })]);
    assert.equal(adapters.getAdapter('codex'), codex);
    assert.deepEqual(adapters.listAgentIds(), ['claude-code', 'codex', 'grok']);
  } finally {
    adapters.setCustomAgents([]);
  }
});

test('a custom-agent reload evicts only the custom ids from the resolved-command cache', () => {
  adapters.resetCommandCache();
  try {
    let builtinLookups = 0;
    let customLookups = 0;
    const builtinExecFile = () => { builtinLookups += 1; return '/usr/local/bin/claude\n'; };
    const customExecFile = () => { customLookups += 1; return '/usr/local/bin/opencode\n'; };

    adapters.setCustomAgents([declaredCustomAgent()]);
    adapters.commandFor('claude-code', { platform: 'linux', execFile: builtinExecFile });
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    assert.equal(builtinLookups, 1);
    assert.equal(customLookups, 1);

    adapters.setCustomAgents([declaredCustomAgent({ command: 'opencode-next' })]);
    adapters.commandFor('claude-code', { platform: 'linux', execFile: builtinExecFile });
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    assert.equal(builtinLookups, 1, 'a builtin keeps its cached resolution across a custom-agent reload');
    assert.equal(customLookups, 2, 'a redeclared custom id re-resolves its command');
  } finally {
    adapters.setCustomAgents([]);
    adapters.resetCommandCache();
  }
});

test('the declaration fingerprint tracks the spawn and title fields, so an edit reaches a running session', () => {
  try {
    adapters.setCustomAgents([declaredCustomAgent()]);
    const first = adapters.customAgentFingerprint('opencode');
    assert.ok(first);
    adapters.setCustomAgents([declaredCustomAgent()]);
    assert.equal(adapters.customAgentFingerprint('opencode'), first);
    for (const edit of [{ command: 'opencode-next' }, { args: ['--yolo'] }, { idleTitle: 'idle' }, { busyTitle: 'busy' }]) {
      adapters.setCustomAgents([declaredCustomAgent(edit)]);
      assert.notEqual(adapters.customAgentFingerprint('opencode'), first, JSON.stringify(edit));
    }
    adapters.setCustomAgents([]);
    assert.equal(adapters.customAgentFingerprint('opencode'), null);
    assert.equal(adapters.customAgentFingerprint('claude-code'), null);
  } finally {
    adapters.setCustomAgents([]);
  }
});

test('the contract builtin agent ids are exactly the builtin registry, so a new adapter cannot be silently dropped', () => {
  adapters.setCustomAgents([]);
  assert.deepEqual([...BUILTIN_AGENT_IDS], adapters.listAgentIds());
});

test('every adapter declares the hooks capability exactly when it carries a hook profile', () => {
  try {
    adapters.setCustomAgents([declaredCustomAgent()]);
    for (const id of adapters.listAgentIds()) {
      const adapter = adapters.getAdapter(id);
      assert.ok(adapter, id);
      assert.equal(adapter.capabilities.hooks, adapter.hooks != null, id);
      assert.equal(adapters.hookProfileOf(adapter), adapter.capabilities.hooks ? adapter.hooks : null, id);
    }
    const custom = adapters.getAdapter('opencode');
    assert.ok(custom);
    assert.equal(custom.hooks, null);
    assert.equal(custom.capabilities.hooks, false);
    assert.equal(adapters.hookProfileOf(custom), null);
  } finally {
    adapters.setCustomAgents([]);
  }
});

test('a declaration whose command could reach a shell is refused before it becomes an adapter', () => {
  try {
    const warnings = adapters.setCustomAgents([
      { id: 'opencode', label: 'OpenCode', command: 'opencode; touch /tmp/pwned' },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /customAgents\[0\] ignored/);
    assert.equal(adapters.isKnownAgentId('opencode'), false);
  } finally {
    adapters.setCustomAgents([]);
  }
});

test('one bad declaration costs only itself, so the valid siblings still reach the registry', () => {
  try {
    const warnings = adapters.setCustomAgents([
      { id: 'opencode', label: 'OpenCode', command: 'opencode' },
      { id: 'BAD ID', label: 'Broken', command: 'broken' },
      { id: 'codex', label: 'Impostor', command: 'impostor' },
      { id: 'opencode', label: 'Twin', command: 'opencode' },
      { id: 'aider', label: 'Aider', command: 'aider' },
    ]);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /customAgents\[1\] ignored/);
    assert.match(warnings[1], /collides with the builtin agent/);
    assert.match(warnings[2], /is declared more than once/);
    assert.deepEqual(adapters.listAgentIds(), ['claude-code', 'codex', 'grok', 'opencode', 'aider']);
    assert.equal(adapters.getAdapter('codex'), codex);
  } finally {
    adapters.setCustomAgents([]);
  }
});
