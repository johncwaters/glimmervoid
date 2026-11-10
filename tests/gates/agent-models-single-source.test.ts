import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseClaudeInitialize, parseCodexModels, parseKimiModels, selectionArgs } from '../../shared/agent-models-core.ts';
import { CATALOG_AGENT_IDS, EFFORT_OPTION_ID } from '../../shared/contracts/agent-models.ts';
import { getAdapter } from '../../session/adapters/index.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'agent-models');
const MODEL_OWNERS = new Set(['shared/agent-models-core.ts', 'shared/contracts/agent-models.ts']);
const MODEL_FLAG_OR_NAME = [
  /(["'`])--(?:model|effort)(?:\1|=)/,
  /model_reasoning/,
  /(["'`])-m\1\s*,[^,\]]*model/i,
  /(["'`])[^"'`\n]*\b(?:opus|sonnet|haiku|fable)\b[^"'`\n]*\1/i,
];

function trackedSourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts', '*.mjs', '*.cjs', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return listed.split('\n').filter((file) => file !== '' && !file.startsWith('tests/') && !file.startsWith('site/') && !/\.test\.[cm]?[jt]sx?$/.test(file));
}

test('model flags and model names live only in the agent model catalog', () => {
  const offenders = trackedSourceFiles()
    .filter((file) => !MODEL_OWNERS.has(file))
    .flatMap((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n')
      .flatMap((line, index) => (MODEL_FLAG_OR_NAME.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}`] : [])));
  assert.deepEqual(offenders, [], 'build model flags with selectionArgs and name defaults through DEFAULT_MODELS');
});

test('every catalog agent is a real adapter that takes a model flag', () => {
  for (const agent of CATALOG_AGENT_IDS) {
    assert.ok(getAdapter(agent), agent);
    assert.ok(selectionArgs({ agent, model: 'some-model', options: [] }).includes('some-model'), agent);
  }
});

test('live-captured agent model lists parse into models with effort choices', () => {
  const claudeModels = parseClaudeInitialize(fs.readFileSync(path.join(FIXTURES, 'claude-initialize.jsonl'), 'utf8')) ?? [];
  const codexModels = parseCodexModels(fs.readFileSync(path.join(FIXTURES, 'codex-debug-models.json'), 'utf8')) ?? [];
  const kimiModels = parseKimiModels(fs.readFileSync(path.join(FIXTURES, 'kimi-config.toml'), 'utf8')) ?? [];
  for (const [agent, models] of Object.entries({ claudeModels, codexModels, kimiModels })) {
    assert.ok(models.length > 0, agent);
    assert.equal(models.filter((model) => model.isDefault).length, 1, `${agent} has one default`);
  }
  for (const models of [claudeModels, codexModels]) {
    assert.ok(models.some((model) => model.options.some((option) => option.id === EFFORT_OPTION_ID)));
  }
});
