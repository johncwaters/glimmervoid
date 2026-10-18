import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSetupFold } from '../session/core/session-setup-core.ts';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';

test('transcript setup folds ordered deltas, replacements, delta skill listings and hook runs while ignoring malformed lines', () => {
  const fold = createSessionSetupFold();
  const attachments = [
    { type: 'model', identity: { modelId: 'old-model', marketingName: 'Old model' } },
    { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]', marketingName: 'Opus 5.5 (1M context)' } },
    { type: 'mcp_instructions_delta', addedNames: ['posthog', 'removed', 'claude.ai Notion', 'posthog'], addedBlocks: [] },
    { type: 'mcp_instructions_delta', addedNames: ['removed'], removedNames: ['removed'], addedBlocks: [] },
    { type: 'deferred_tools_delta', addedNames: ['Read', 'mcp__claude_ai_Notion__read', 'mcp__tools_only__query', 'mcp__gone__read', 'mcp__tools_only__write'] },
    { type: 'deferred_tools_delta', addedNames: [], removedNames: ['mcp__gone__read'] },
    { type: 'skill_listing', content: '- obsolete: Old skill\n- old:plugin-skill: Old plugin' },
    { type: 'skill_listing', content: '- caveman:caveman-commit: Commit changes\n- standalone: A skill\n- caveman:caveman-commit: Duplicate\nnot a skill' },
    { type: 'skill_listing', isInitial: false, names: ['caveman:caveman-review'], content: '- content-ignored-when-names-present: A skill' },
    { type: 'agent_listing_delta', addedTypes: ['caveman:cavecrew-builder', 'Explore', 'removed', 'old:agent'] },
    { type: 'agent_listing_delta', addedTypes: ['caveman:cavecrew-builder', 'removed'], removedTypes: ['removed', 'old:agent'] },
    { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart' },
    { type: 'hook_success', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse' },
    { type: 'hook_non_blocking_error', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse' },
  ];
  for (const attachment of attachments) fold.ingestLine(JSON.stringify({ type: 'attachment', attachment }));
  fold.ingestLine('{"type":"attachment", broken');
  fold.ingestLine(JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: 3 } }));
  fold.ingestLine(JSON.stringify({ type: 'assistant', attachment: { type: 'skill_listing', content: '- ignored: A skill' } }));
  fold.ingestLine(JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookInfos: [{ command: 'z-hook Stop' }, { command: 'a-hook Stop' }, { command: 'z-hook Stop' }] }));
  const setup = fold.snapshot();
  assert.deepEqual(setup, {
    model: 'Opus 5.5 (1M context)',
    mcpServers: ['claude.ai Notion', 'posthog', 'tools_only'],
    plugins: [{ name: 'caveman', skills: ['caveman-commit', 'caveman-review'], agents: ['cavecrew-builder'] }],
    skills: ['standalone'],
    agents: ['Explore'],
    hookEvents: [{ event: 'PostToolUse', runCount: 2 }, { event: 'SessionStart', runCount: 1 }],
    hookCommands: ['a-hook Stop', 'z-hook Stop'],
  });
  const request = { type: 'session-setup', id: 'session-1', requestId: 'setup-1' };
  assert.deepEqual(ClientMessage.parse(request), request);
  const response = { type: 'session-setup-response', id: 'session-1', requestId: 'setup-1', ok: true, setup };
  assert.deepEqual(ServerMessage.parse(JSON.parse(JSON.stringify(response))), response);
  assert.equal(ServerMessage.safeParse({ ...response, setup: { ...setup, mcpServers: Array(4097).fill('server') } }).success, false);
});
