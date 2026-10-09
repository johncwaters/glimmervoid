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
    'resume', 'rtk', 'saneYolo', 'skipPermissionsFlag', 'statusLine',
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
      hookTools: [],
      planLimits: true,
    });
    assert.equal(written, fs.readFileSync(expected.settingsPath, 'utf8'));
    const parsed = JSON.parse(written);
    assert.deepEqual(Object.keys(parsed.hooks), [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest',
      'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact', 'PostToolUse',
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
  ['PreCompact', { trigger: 'auto' }, 'compaction-start', null, null],
  ['PostCompact', { trigger: 'manual' }, 'compaction-end', null, null],
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

test('a Bash PermissionRequest carries its command as the prompt detail; plans and notifications carry none', () => {
  const mapPromptDetail = claudeCode.mapHookPromptDetail;
  assert.deepEqual(
    mapPromptDetail('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build\necho done' } }),
    { toolName: 'Bash', summary: 'rm -rf build', isComplete: false, question: null },
  );
  assert.deepEqual(mapPromptDetail('PermissionRequest', { tool_name: 'mcp__docs__search', tool_input: { q: 'x' } }), { toolName: 'mcp__docs__search', summary: '', isComplete: false, question: null });
  assert.equal(mapPromptDetail('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: 'Ship it' } }), null);
  assert.equal(mapPromptDetail('Notification', { notification_type: 'permission_prompt' }), null);
  assert.equal(mapPromptDetail('PermissionRequest', {}), null);
});

const askUserQuestionInput = (overrides: Record<string, unknown> = {}) => ({
  questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }], multiSelect: false, ...overrides }],
});
const questionOf = (toolInput: unknown) => claudeCode.mapHookPromptDetail('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: toolInput })?.question;

test('a single-question AskUserQuestion carries its question text, option labels and selection mode, and stays incomplete', () => {
  assert.deepEqual(
    claudeCode.mapHookPromptDetail('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: askUserQuestionInput() }),
    { toolName: 'AskUserQuestion', summary: '', isComplete: false, question: { text: 'Which database?', options: ['Postgres', 'SQLite'], multiSelect: false } },
  );
  assert.deepEqual(questionOf(askUserQuestionInput({ multiSelect: true })), { text: 'Which database?', options: ['Postgres', 'SQLite'], multiSelect: true });
  assert.equal(questionOf(askUserQuestionInput({ multiSelect: 'yes' }))?.multiSelect, false);
});

test('an AskUserQuestion question is accepted at exactly 300 characters, 80 per label and 8 options', () => {
  const eightOptions = Array.from({ length: 8 }, (_, index) => ({ label: `${index}`.padEnd(80, 'x') }));
  const question = questionOf(askUserQuestionInput({ question: 'q'.repeat(300), options: eightOptions }));
  assert.equal(question?.text.length, 300);
  assert.equal(question?.options.length, 8);
});

const unanswerableQuestionCases: [string, unknown][] = [
  ['no tool input', undefined],
  ['tool input as an array', []],
  ['questions missing', {}],
  ['questions not an array', { questions: 'Which database?' }],
  ['no questions', { questions: [] }],
  ['two questions', { questions: [askUserQuestionInput().questions[0], askUserQuestionInput().questions[0]] }],
  ['a question entry that is not an object', { questions: ['Which database?'] }],
  ['question text missing', askUserQuestionInput({ question: undefined })],
  ['question text not a string', askUserQuestionInput({ question: 42 })],
  ['empty question text', askUserQuestionInput({ question: '' })],
  ['question text over 300 characters', askUserQuestionInput({ question: 'q'.repeat(301) })],
  ['options missing', askUserQuestionInput({ options: undefined })],
  ['no options', askUserQuestionInput({ options: [] })],
  ['nine options', askUserQuestionInput({ options: Array.from({ length: 9 }, (_, index) => ({ label: `option ${index}` })) })],
  ['an option without a label', askUserQuestionInput({ options: [{ label: 'Postgres' }, { description: 'no label' }] })],
  ['an option label not a string', askUserQuestionInput({ options: [{ label: 'Postgres' }, { label: 7 }] })],
  ['an option that is a bare string', askUserQuestionInput({ options: ['Postgres'] })],
  ['an empty option label', askUserQuestionInput({ options: [{ label: '' }] })],
  ['an option label over 80 characters', askUserQuestionInput({ options: [{ label: 'x'.repeat(81) }] })],
  ['a bidi override in the question text', askUserQuestionInput({ question: `Which ${String.fromCharCode(0x202e)}database?` })],
  ['a newline in the question text', askUserQuestionInput({ question: 'Which\ndatabase?' })],
  ['an escape in an option label', askUserQuestionInput({ options: [{ label: `Postgres${String.fromCharCode(0x1b)}[2K` }] })],
  ['a zero-width space in an option label', askUserQuestionInput({ options: [{ label: `SQ${String.fromCharCode(0x200b)}Lite` }] })],
];

for (const [description, toolInput] of unanswerableQuestionCases) {
  test(`an AskUserQuestion with ${description} carries a null question`, () => {
    const detail = claudeCode.mapHookPromptDetail('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: toolInput });
    assert.equal(detail?.toolName, 'AskUserQuestion');
    assert.equal(detail?.question, null);
    assert.equal(detail?.isComplete, false);
  });
}

test('only AskUserQuestion carries a question, whatever another tool puts in its input', () => {
  assert.equal(claudeCode.mapHookPromptDetail('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', ...askUserQuestionInput() } })?.question, null);
});

test('a permission detail is complete only when the summary is the whole single-line untruncated field', () => {
  const mapPromptDetail = claudeCode.mapHookPromptDetail;
  const completenessOf = (toolName: string, toolInput: Record<string, unknown>) => mapPromptDetail('PermissionRequest', { tool_name: toolName, tool_input: toolInput })?.isComplete;
  assert.equal(completenessOf('Bash', { command: 'npm test' }), true);
  assert.equal(completenessOf('Bash', { command: "cat <<'EOF' > notes.txt\nhello\nEOF" }), false);
  assert.equal(completenessOf('Bash', { command: `echo ${'a'.repeat(195)}` }), false);
  assert.equal(completenessOf('mcp__docs__search', { q: 'npm test' }), false);
});

test('a permission detail is never complete for a tool other than Bash, whose approved request holds more than the shown field', () => {
  const mapPromptDetail = claudeCode.mapHookPromptDetail;
  const completenessOf = (toolName: string, toolInput: Record<string, unknown>) => mapPromptDetail('PermissionRequest', { tool_name: toolName, tool_input: toolInput })?.isComplete;
  assert.equal(completenessOf('Write', { file_path: '/repo/a.ts', content: 'x' }), false);
  assert.equal(completenessOf('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }), false);
  assert.equal(completenessOf('Task', { description: 'Explore', prompt: 'do things' }), false);
  assert.equal(completenessOf('Grep', { pattern: 'needle', path: '/' }), false);
});

test('a Bash permission detail is complete only when every tool_input key is command, description or timeout', () => {
  const mapPromptDetail = claudeCode.mapHookPromptDetail;
  const completenessOf = (toolInput: Record<string, unknown>) => mapPromptDetail('PermissionRequest', { tool_name: 'Bash', tool_input: toolInput })?.isComplete;
  assert.equal(completenessOf({ command: 'npm test', dangerouslyDisableSandbox: true }), false);
  assert.equal(completenessOf({ command: 'npm test', run_in_background: true }), false);
  assert.equal(completenessOf({ command: 'npm test', someFutureField: 'x' }), false);
  assert.equal(completenessOf({ command: 'npm test', description: 'Run the tests', timeout: 60000 }), true);
});

test('a Bash command holding a bidi override or a lone carriage return is never complete', () => {
  const mapPromptDetail = claudeCode.mapHookPromptDetail;
  const completenessOf = (command: string) => mapPromptDetail('PermissionRequest', { tool_name: 'Bash', tool_input: { command } })?.isComplete;
  assert.equal(completenessOf(`echo safe ${String.fromCharCode(0x202e)}fr- mr`), false);
  assert.equal(completenessOf(`echo safe${String.fromCharCode(0x0d)}rm -rf ~`), false);
  assert.equal(completenessOf(`echo ${String.fromCharCode(0x200b)}hi`), false);
  assert.equal(completenessOf(`echo ${String.fromCharCode(0x1b)}[2K`), false);
});

test('HookRouter attaches the permission detail to the awaiting-input signal it emits', () => {
  const router = new HookRouter();
  const seen: HookSignal[] = [];
  router.register('s1', { token: 'tok', onSignal: (s) => seen.push(s), hooks: claudeCode.hooks });
  router.handle({ glimmervoidId: 's1', event: 'PermissionRequest', token: 'tok', payload: { tool_name: 'Bash', tool_input: { command: 'npm test' } } });
  router.handle({ glimmervoidId: 's1', event: 'Notification', token: 'tok', payload: { notification_type: 'permission_prompt' } });
  assert.deepEqual(seen.map((s) => [s.promptKind, s.promptDetail ?? null]), [
    ['permission', { toolName: 'Bash', summary: 'npm test', isComplete: true, question: null }],
    ['permission', null],
  ]);
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

test('one resolvability rule answers for the settings payload, the agent list and the doctor', () => {
  adapters.resetCommandCache();
  try {
    adapters.setCustomAgents([
      declaredCustomAgent(),
      declaredCustomAgent({ id: 'ghostcode', label: 'GhostCode', command: '/nonexistent/ghostcode' }),
    ]);
    adapters.commandFor('opencode', { platform: 'linux', execFile: () => '/usr/local/bin/opencode\n' });
    assert.deepEqual(adapters.describeAgentResolvability('opencode'), {
      label: 'OpenCode', path: '/usr/local/bin/opencode', resolvable: true,
    });
    assert.deepEqual(adapters.describeAgentResolvability('ghostcode'), {
      label: 'GhostCode', path: null, resolvable: false,
    });
    assert.deepEqual(adapters.describeAgentResolvability('gemini'), {
      label: 'gemini', path: null, resolvable: false,
    });
  } finally {
    adapters.setCustomAgents([]);
    adapters.resetCommandCache();
  }
});

test('the cached resolvability read answers before any probe and spawns none', () => {
  adapters.resetCommandCache();
  try {
    adapters.setCustomAgents([declaredCustomAgent()]);
    assert.deepEqual(adapters.cachedAgentResolvability('opencode'), {
      label: 'OpenCode', path: null, resolvable: null,
    }, 'an unprobed declaration reports unknown rather than resolving it');
    adapters.commandFor('opencode', { platform: 'linux', execFile: () => '/usr/local/bin/opencode\n' });
    assert.deepEqual(adapters.cachedAgentResolvability('opencode'), {
      label: 'OpenCode', path: '/usr/local/bin/opencode', resolvable: true,
    });
    assert.deepEqual(adapters.cachedAgentResolvability('gemini'), { label: 'gemini', path: null, resolvable: false });
  } finally {
    adapters.setCustomAgents([]);
    adapters.resetCommandCache();
  }
});

test('a custom-agent reload keeps a cached resolution when the declaration is unchanged', () => {
  adapters.resetCommandCache();
  try {
    let customLookups = 0;
    const customExecFile = () => { customLookups += 1; return '/usr/local/bin/opencode\n'; };

    adapters.setCustomAgents([declaredCustomAgent()]);
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    adapters.setCustomAgents([declaredCustomAgent()]);
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    assert.equal(customLookups, 1, 'an unchanged declaration keeps its cached resolution across a reload');

    adapters.setCustomAgents([declaredCustomAgent({ command: 'opencode-next' })]);
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    assert.equal(customLookups, 2, 'a changed declaration evicts it');

    adapters.setCustomAgents([]);
    adapters.setCustomAgents([declaredCustomAgent({ command: 'opencode-next' })]);
    adapters.commandFor('opencode', { platform: 'linux', execFile: customExecFile });
    assert.equal(customLookups, 3, 'a withdrawn declaration evicts it too');
  } finally {
    adapters.setCustomAgents([]);
    adapters.resetCommandCache();
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

test('a declaration the config contract refused never reaches the registry', () => {
  const refused = validateConfig({
    projects: [],
    customAgents: [
      { id: 'opencode', label: 'OpenCode', command: 'opencode' },
      { id: 'codex', label: 'Impostor', command: 'impostor' },
    ],
  });
  assert.equal(refused.ok, false);
  assert.equal(adapters.getAdapter('codex'), codex);
  assert.equal(adapters.isKnownAgentId('opencode'), false);
});
