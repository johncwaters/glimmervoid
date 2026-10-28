import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeAnswerReply, claudeApprovalFor, parseClaudePermissionRequest } from '../session/core/claude-approval-core.ts';

test('a held question is answered only with every question text and replies through the PermissionRequest hook contract', () => {
  const question = parseClaudePermissionRequest({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] },
  });
  assert.ok(question);
  const questionApproval = claudeApprovalFor(question, 'claude-2');
  assert.equal(claudeAnswerReply(question, questionApproval, {}), null);
  assert.deepEqual(claudeAnswerReply(question, questionApproval, { 'Pick a color': 'Blue' })?.hookSpecificOutput.decision, {
    behavior: 'allow',
    updatedInput: { ...question.toolInput, answers: { 'Pick a color': 'Blue' } },
  });
});
