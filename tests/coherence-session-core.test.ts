import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoherenceSessionOverrides,
  buildCoherenceShims,
  buildCoherenceUserHooks,
  COHERENCE_HOOK_EVENTS,
  COHERENCE_POST_TOOL_USE_MATCHER,
} from '../server/core/coherence-session-core.ts';

const nodePath = '/Program Files/node/node';
const hookCliPath = '/installed packages/coherence/hook.js';
const claudeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

test('coherence hooks match its Claude bundle with a matcher only on PostToolUse', () => {
  const hooks = buildCoherenceUserHooks({ nodePath, hookCliPath });
  assert.deepEqual(COHERENCE_HOOK_EVENTS, ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse']);
  assert.equal(COHERENCE_POST_TOOL_USE_MATCHER, 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit');
  assert.deepEqual(hooks.map((hook) => hook.event), [...COHERENCE_HOOK_EVENTS]);
  assert.deepEqual(hooks.map((hook) => hook.id), [
    'coherence-subagent-start', 'coherence-session-start', 'coherence-subagent-stop', 'coherence-stop', 'coherence-post-tool-use',
  ]);
  for (const hook of hooks) {
    assert.equal(hook.type, 'command');
    assert.equal(hook.enabled, true);
    assert.equal(hook.name, `Coherence ${hook.event}`);
    assert.equal(hook.command, `"${nodePath}" "${hookCliPath}" ${hook.event}`);
    if (hook.event === 'PostToolUse') {
      assert.equal(hook.matcher, COHERENCE_POST_TOOL_USE_MATCHER);
      continue;
    }
    assert.equal('matcher' in hook, false);
  }
});

test('coherence hook commands quote Windows paths without changing backslashes', () => {
  const hooks = buildCoherenceUserHooks({ nodePath: 'C:\\Program Files\\node.exe', hookCliPath: 'C:\\Coherence tools\\hook.js' });
  assert.equal(hooks[0].command, '"C:\\Program Files\\node.exe" "C:\\Coherence tools\\hook.js" SubagentStart');
});

test('coherence hook commands reject a double quote in either path', () => {
  assert.throws(() => buildCoherenceUserHooks({ nodePath: '/bad"node', hookCliPath }), /double quotes/);
  assert.throws(() => buildCoherenceUserHooks({ nodePath, hookCliPath: '/bad"hook.js' }), /double quotes/);
});

test('coherence session overrides preassign the conversation and carry hooks, PATH and host env only', () => {
  const shimDir = '/glimmervoid home/factory/bin';
  assert.deepEqual(buildCoherenceSessionOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir }), {
    extraClaudeArgs: ['--session-id', claudeSessionId],
    extraUserHooks: buildCoherenceUserHooks({ nodePath, hookCliPath }),
    prependPathDirs: [shimDir],
    spawnEnv: { COHERENCE_HOOK_HOST: 'claude' },
  });
});

test('coherence session overrides reject non-UUID conversation ids', () => {
  for (const invalidId of ['', 'not-a-uuid', '--resume', `${claudeSessionId}extra`, ` ${claudeSessionId}`]) {
    assert.throws(() => buildCoherenceSessionOverrides({ claudeSessionId: invalidId, nodePath, hookCliPath, shimDir: '/bin' }), /UUID/);
  }
});

test('coherence shims quote paths, forward arguments and use platform-specific modes and newlines', () => {
  const cliPath = '/installed packages/coherence/cli.js';
  assert.deepEqual(buildCoherenceShims({ nodePath, cliPath }), [
    { fileName: 'coherence', mode: 0o755, text: `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n` },
    { fileName: 'coherence.cmd', mode: 0o644, text: `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n` },
  ]);
});

test('coherence shims preserve Windows paths and reject double quotes in either path', () => {
  const shims = buildCoherenceShims({ nodePath: 'C:\\Program Files\\node.exe', cliPath: 'C:\\Coherence tools\\cli.js' });
  assert.equal(shims[1].text, '@echo off\r\n"C:\\Program Files\\node.exe" "C:\\Coherence tools\\cli.js" %*\r\n');
  assert.throws(() => buildCoherenceShims({ nodePath: '/bad"node', cliPath: '/cli.js' }), /double quotes/);
  assert.throws(() => buildCoherenceShims({ nodePath, cliPath: '/bad"cli.js' }), /double quotes/);
});
