import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoherenceSessionOverrides,
  buildCoherenceShims,
  buildCoherenceUserHooks,
  COHERENCE_HOOK_EVENTS,
  COHERENCE_POST_TOOL_USE_MATCHER,
  decideCoherenceAttachment,
} from '../server/core/coherence-session-core.ts';
import {
  appendJournalWindow, attachedCoherenceHost, COHERENCE_FEED_UNAVAILABLE, nextActionFromRegulateOutput, parseJournalLines, regulateArgs, regulationFromConfig,
  selectLatestShownEntry,
} from '../server/core/coherence-feed-core.ts';
import { judgeCoherenceConfig } from '../server/core/coherence-config-core.ts';
import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, COHERENCE_JOURNAL_TEXT_MAX_CHARS } from '../shared/contracts/coherence.ts';

const nodePath = '/Program Files/node/node';
const hookCliPath = '/installed packages/coherence/hook.js';
const claudeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

test('coherence attachment always includes Factory, excludes utility and gates writers and reviews on both prerequisites', () => {
  const cases = [
    ['factory', false, false, true],
    ['factory', false, true, true],
    ['factory', true, false, true],
    ['factory', true, true, true],
    ['utility', false, false, false],
    ['utility', false, true, false],
    ['utility', true, false, false],
    ['utility', true, true, false],
    ['writer', false, false, false],
    ['writer', false, true, false],
    ['writer', true, false, false],
    ['writer', true, true, true],
    ['review', false, false, false],
    ['review', false, true, false],
    ['review', true, false, false],
    ['review', true, true, true],
  ] as const;
  for (const [sessionKind, isSettingOn, hasRepoConfig, expected] of cases) {
    assert.equal(decideCoherenceAttachment({ sessionKind, isSettingOn, hasRepoConfig }), expected,
      `${sessionKind}: setting=${isSettingOn}, config=${hasRepoConfig}`);
  }
});

test('coherence hooks match its Claude bundle with a matcher only on PostToolUse', () => {
  const hooks = buildCoherenceUserHooks({ nodePath, hookCliPath });
  assert.deepEqual(COHERENCE_HOOK_EVENTS, ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse']);
  assert.equal(COHERENCE_POST_TOOL_USE_MATCHER, 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit');
  assert.deepEqual(hooks.map((hook) => hook.event), [...COHERENCE_HOOK_EVENTS, 'SessionStart']);
  assert.deepEqual(hooks.map((hook) => hook.id), [
    'coherence-subagent-start', 'coherence-session-start', 'coherence-subagent-stop', 'coherence-stop', 'coherence-post-tool-use',
    'coherence-cli-on-path',
  ]);
  assert.deepEqual(hooks.at(-1), {
    id: 'coherence-cli-on-path',
    name: 'Coherence CLI on PATH',
    event: 'SessionStart',
    type: 'command',
    enabled: true,
    command: 'echo In this Glimmervoid session coherence is on PATH, so run coherence followed by the verb wherever the Coherence instructions say npx coherence.',
  });
  for (const hook of hooks.slice(0, -1)) {
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

test('the coherence feed shows the latest unretracted entry, maps one regulate next action and refuses the team review config rule', () => {
  const session = '11111111-2222-4333-8444-555555555555';
  const row = (id: string, at: string, kind: string, extra: Record<string, string> = {}) => JSON.stringify({ id, at, kind, session, chose: `chose ${id}\u0007`, because: 'why', ...extra });
  const decisions = parseJournalLines([
    row('d-00000001', '2026-10-17T10:00:00.000Z', 'decision'),
    row('d-00000002', '2026-10-17T10:01:00.000Z', 'conjecture'),
    row('d-00000003', '2026-10-17T10:02:00.000Z', 'retraction', { supersedes: 'd-00000002' }),
    row('d-00000004', '2026-10-17T10:03:00.000Z', 'decision', { session: 'someone-else' }),
    JSON.stringify({ id: '../../etc/passwd', at: '2026-10-17T10:04:00.000Z', kind: 'decision', session, chose: 'x', because: 'y' }),
    '{not json',
  ].join('\n'), 'decisions', session);
  assert.deepEqual(decisions.map((entry) => entry.id), ['d-00000001', 'd-00000002', 'd-00000003']);
  assert.equal(decisions[0].text, 'chose d-00000001');
  assert.equal(selectLatestShownEntry(appendJournalWindow([], decisions))?.id, 'd-00000001');
  const defects = parseJournalLines(JSON.stringify({ event: 'recorded', id: 'def-0123456789ab', at: '2026-10-17T10:05:00.000Z', session, summary: 'x'.repeat(5000), evidence: 'seen' }), 'defects', session);
  const window = appendJournalWindow(appendJournalWindow([], decisions), defects);
  assert.equal(selectLatestShownEntry(window)?.kind, 'defect');
  assert.equal(selectLatestShownEntry(window)?.text.length, COHERENCE_JOURNAL_TEXT_MAX_CHARS);
  assert.equal(appendJournalWindow([], Array.from({ length: 250 }, (_, index) => ({ ...decisions[0], id: `d-${String(index).padStart(8, '0')}` }))).length, COHERENCE_JOURNAL_DRAWER_MAX_ROWS);

  const refused = nextActionFromRegulateOutput(JSON.stringify({
    doctrine: 'coherence', id: 'r-1', action: 'require-decision', host: 'claude', scope: {}, remaining: 2,
    selected: { rule: 'significant-growth', evidence: 'surface +4\nexports', command: { name: 'decide', args: ['"no invariant"'] } },
  }));
  assert.deepEqual(refused, { ok: true, nextAction: { action: 'require-decision', rule: 'significant-growth', evidence: 'surface +4 exports', remedy: null, command: 'coherence decide "no invariant"', remaining: 2 } });
  assert.deepEqual(nextActionFromRegulateOutput('Unrunnable: boom'), { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.unrecognized });
  assert.deepEqual(regulateArgs({ host: 'claude', baseSha: 'a'.repeat(40) }), ['regulate', '--json', '--since', 'a'.repeat(40), '--host', 'claude']);
  assert.deepEqual(regulateArgs({ host: 'claude', baseSha: '--upload-pack=x' }), ['regulate', '--json', '--host', 'claude']);

  assert.equal(regulationFromConfig({ kind: 'file', text: '{}' }), null);
  assert.deepEqual(regulationFromConfig({ kind: 'file', text: '{"language":"./evil.js"}' }), judgeCoherenceConfig({ kind: 'file', text: '{"language":"./evil.js"}' }));
  assert.equal(regulationFromConfig({ kind: 'symlink' })?.ok, false);
  assert.equal(attachedCoherenceHost({ host: 'claude', factoryRole: null, isEphemeral: false, isSettingOn: false, hasRepoConfig: true }), null);
  assert.equal(attachedCoherenceHost({ host: 'claude', factoryRole: 'worker', isEphemeral: true, isSettingOn: false, hasRepoConfig: false }), 'claude');
  assert.equal(attachedCoherenceHost({ host: 'grok', factoryRole: 'worker', isEphemeral: false, isSettingOn: true, hasRepoConfig: true }), null);
});
