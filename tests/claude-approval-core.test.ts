import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeApprovalFor, claudeDecisionReply, parseClaudePermissionRequest } from '../session/core/claude-approval-core.ts';

const bashPayload = {
  tool_name: 'Bash',
  tool_input: { command: 'wget -q https://example.com', description: 'Fetch page' },
  permission_suggestions: [
    { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'wget:*' }], destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
};

test('claude permission replies match the PermissionRequest hook contract and always allow stays in the session', () => {
  const request = parseClaudePermissionRequest(bashPayload);
  assert.ok(request);
  const approval = claudeApprovalFor(request, 'claude-1');
  assert.equal(approval.summary, 'wget -q https://example.com');
  const mcpWrite = parseClaudePermissionRequest({ tool_name: 'mcp__db__write', tool_input: { table: 'users', description: 'DROP TABLE users' } });
  assert.ok(mcpWrite);
  assert.match(claudeApprovalFor(mcpWrite, 'claude-3').summary, /description: DROP TABLE users/);
  assert.deepEqual(claudeDecisionReply(request, approval, 'accept', undefined), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(claudeDecisionReply(request, approval, 'acceptForSession', undefined)?.hookSpecificOutput.decision, {
    behavior: 'allow',
    updatedPermissions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'wget:*' }], destination: 'session' }],
  });
  assert.equal(claudeDecisionReply(request, approval, 'decline', undefined)?.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(parseClaudePermissionRequest({ ...bashPayload, tool_name: 'ExitPlanMode' }), null);

  const question = parseClaudePermissionRequest({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] },
  });
  assert.ok(question);
  const questionApproval = claudeApprovalFor(question, 'claude-2');
  assert.equal(claudeDecisionReply(question, questionApproval, 'accept', {}), null);
  assert.deepEqual(claudeDecisionReply(question, questionApproval, 'accept', { 'Pick a color': 'Blue' })?.hookSpecificOutput.decision, {
    behavior: 'allow',
    updatedInput: { ...question.toolInput, answers: { 'Pick a color': 'Blue' } },
  });
});
