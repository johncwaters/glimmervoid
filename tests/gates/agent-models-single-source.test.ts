import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { claudeConfiguredDefault, codexConfiguredDefault, parseAntigravityModels, parseClaudeInitialize, parseCodexModels, parseKimiModels, selectionArgs } from '../../shared/agent-models-core.ts';
import { CATALOG_AGENT_IDS, EFFORT_OPTION_ID } from '../../shared/contracts/agent-models.ts';
import type { ModelSelection } from '../../shared/contracts/agent-models.ts';
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
  return listed.split('\n').filter((file) => file !== '' && !file.startsWith('tests/') && !file.startsWith('site/') && !file.startsWith('examples/') && !/\.test\.[cm]?[jt]sx?$/.test(file) && fs.existsSync(path.join(REPO_ROOT, file)));
}

test('model flags and model names live only in the agent model catalog', () => {
  const offenders = trackedSourceFiles()
    .filter((file) => !MODEL_OWNERS.has(file))
    .flatMap((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n')
      .flatMap((line, index) => (MODEL_FLAG_OR_NAME.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}`] : [])));
  assert.deepEqual(offenders, [], 'build model flags with selectionArgs and name defaults through DEFAULT_MODELS');
});

function generatedLaunchConfigOf(agent: string, modelSelection: ModelSelection): string {
  const injection = getAdapter(agent)?.hooks?.injection;
  if (injection?.kind !== 'generated-home') return '';
  const prepared = injection.prepareHome({ ...process.env }, { listenerPort: 1, folderTrustRoot: REPO_ROOT, sessionFolder: REPO_ROOT, isCleanHome: false, modelSelection });
  return 'homeEnvValue' in prepared ? prepared.homeEnvValue ?? '' : '';
}

test('every catalog agent is a real adapter whose launch carries the picked model', () => {
  for (const agent of CATALOG_AGENT_IDS) {
    assert.ok(getAdapter(agent), agent);
    const modelSelection: ModelSelection = { agent, model: 'some-model', options: [] };
    const isModelInFlags = selectionArgs(modelSelection).includes('some-model');
    const isModelInLaunchConfig = generatedLaunchConfigOf(agent, modelSelection).includes('"some-model"');
    assert.ok(isModelInFlags || isModelInLaunchConfig, agent);
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

test('the default model and effort shown are the ones the agent own settings start', () => {
  const claudeModels = parseClaudeInitialize(fs.readFileSync(path.join(FIXTURES, 'claude-initialize.jsonl'), 'utf8')) ?? [];
  const claudeStartsOn = (settings: unknown) => claudeConfiguredDefault(JSON.stringify(settings), claudeModels);
  const opusHigh = { model: 'claude-opus-5-5', effort: 'high' };
  assert.deepEqual(claudeStartsOn({ model: 'claude-opus-5-5[1m]', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }), opusHigh);
  assert.deepEqual(claudeStartsOn({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }), opusHigh);
  assert.deepEqual(claudeStartsOn({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }), opusHigh);
  assert.deepEqual(claudeStartsOn({ effortLevel: 'high' }), { model: null, effort: null });
  const codexModels = parseCodexModels(fs.readFileSync(path.join(FIXTURES, 'codex-debug-models.json'), 'utf8')) ?? [];
  const pickedCodex = codexModels[codexModels.length - 1];
  const pickedEffort = pickedCodex.options.find((option) => option.id === EFFORT_OPTION_ID)?.choices.at(-1) ?? null;
  const codexToml = `model = "${pickedCodex.id}"\nmodel_reasoning_effort = "${pickedEffort}"\n\n[profiles.fast]\nmodel = "other"\n`;
  assert.deepEqual(codexConfiguredDefault(codexToml, codexModels), { model: pickedCodex.id, effort: pickedEffort });
});

test('a live-captured agy model list parses every row into a launchable model', () => {
  const agyModels = parseAntigravityModels(fs.readFileSync(path.join(FIXTURES, 'agy-models.txt'), 'utf8')) ?? [];
  assert.ok(agyModels.length > 0);
  assert.ok(agyModels.every((model) => model.id !== model.label && selectionArgs({ agent: 'antigravity', model: model.id, options: [] }).includes(model.id)));
});
