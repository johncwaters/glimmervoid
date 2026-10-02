import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAiTitle, extractOscTaskTitle, extractPromptTaskTitle, resolveTaskTitle } from '../session/core/task-title-core.ts';
import type { TaskTitleVocabulary } from '../session/core/task-title-core.ts';

const vocabularyFor = (agentName: string, genericTitles: string[] = [agentName]): TaskTitleVocabulary =>
  ({ readsTranscriptTitle: false, genericTitles, agentSuffix: ` - ${agentName}` });

const aiLine = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title });

test('ai titles use the last valid title and skip malformed or unrelated lines', () => {
  assert.equal(extractAiTitle([aiLine('First'), '{broken', aiLine('Newest'), '{"type":"ai-title","aiTitle":4}', 'null', '{}'].join('\n')), 'Newest');
  assert.equal(extractAiTitle('{}\n{broken\n'), null);
});

test('ai titles skip the first line when the tail starts partway through a record', () => {
  assert.equal(extractAiTitle(aiLine('Partial'), true), null);
  assert.equal(extractAiTitle(`${aiLine('Partial')}\n${aiLine('Complete')}\n`, true), 'Complete');
  assert.equal(extractAiTitle(aiLine('Complete')), 'Complete');
});

test('ai titles are collapsed and capped at 120 characters', () => {
  assert.equal(extractAiTitle(aiLine('  Fix\n  layout  ')), 'Fix layout');
  assert.equal(extractAiTitle(aiLine('a'.repeat(150)))?.length, 120);
});

for (const [rawTitle, agentName, expected] of [
  [`${String.fromCodePoint(0x2839)} project`, 'codex', null],
  [`${String.fromCodePoint(0x2802)} Claude Code`, 'codex', 'Claude Code'],
  ['project', 'codex', null],
  ['[ . ] Action Required | project', 'codex', null],
  ['Run touch for grok-probe-approval.txt - grok', 'grok', 'Run touch for grok-probe-approval.txt'],
  ['[ ! ] Action Required | Fix dashboard - codex', 'codex', 'Fix dashboard'],
  [`${String.fromCodePoint(0x25d0)} Fix layout`, 'custom', 'Fix layout'],
  [' codex ', 'codex', null],
  ['', 'codex', null],
] as const) {
  test(`OSC task title extraction: ${JSON.stringify(rawTitle)}`, () => {
    assert.equal(extractOscTaskTitle(rawTitle, 'project', vocabularyFor(agentName)), expected);
  });
}

test('OSC task titles drop only the generic titles and suffix the adapter declares', () => {
  const claudeVocabulary: TaskTitleVocabulary = { readsTranscriptTitle: true, genericTitles: ['Claude Code'], agentSuffix: null };
  assert.equal(extractOscTaskTitle(`${String.fromCodePoint(0x2802)} Claude Code`, 'project', claudeVocabulary), null);
  assert.equal(extractOscTaskTitle('Fix layout - codex', 'project', claudeVocabulary), 'Fix layout - codex');
});

test('first prompt titles ignore slash commands and empty prompts', () => {
  for (const prompt of ['', '  ', '\n /compact', undefined, 4]) assert.equal(extractPromptTaskTitle(prompt), null);
  assert.equal(extractPromptTaskTitle('  Fix\n the\t dashboard '), 'Fix the dashboard');
});

test('first prompt titles truncate on a word boundary within 60 characters', () => {
  const prompt = 'Improve the dashboard session cards with meaningful task titles and inline editing';
  const title = extractPromptTaskTitle(prompt);
  assert.equal(title, 'Improve the dashboard session cards with meaningful task...');
  assert.equal(extractPromptTaskTitle('a'.repeat(80)), `${'a'.repeat(57)}...`);
  assert.equal(extractPromptTaskTitle('a'.repeat(60)), 'a'.repeat(60));
  assert.ok(title && title.length <= 60);
});

test('title resolution follows custom, ai, OSC, first prompt priority and clearing restores automatic titles', () => {
  const sources = { customTitle: 'Custom', aiTitle: 'AI', oscTitle: 'OSC', promptTitle: 'Prompt' };
  assert.deepEqual(resolveTaskTitle(sources), { taskTitle: 'Custom', isCustom: true });
  assert.deepEqual(resolveTaskTitle({ ...sources, customTitle: '' }), { taskTitle: 'AI', isCustom: false });
  assert.deepEqual(resolveTaskTitle({ oscTitle: 'OSC', promptTitle: 'Prompt' }), { taskTitle: 'OSC', isCustom: false });
  assert.deepEqual(resolveTaskTitle({ promptTitle: 'Prompt' }), { taskTitle: 'Prompt', isCustom: false });
  assert.deepEqual(resolveTaskTitle({}), { taskTitle: null, isCustom: false });
  assert.equal(resolveTaskTitle({ customTitle: 'a'.repeat(150) }).taskTitle?.length, 120);
});
