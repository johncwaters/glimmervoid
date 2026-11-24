import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentModelCatalog } from '../shared/contracts/agent-models.ts';
import { StartPicksFile } from '../shared/contracts/start-picks.ts';
import { emptyStartPicks, rememberStart } from '../shared/start-picks-core.ts';
import { startToRemember, withRememberedStart } from '../server/core/start-picks-request-core.ts';

const DEFAULT_AGENT_ID = 'claude-code';
const agents = { defaultAgentId: DEFAULT_AGENT_ID, isKnownAgentId: (agentId: string) => agentId === 'codex' || agentId === DEFAULT_AGENT_ID };
const catalog = AgentModelCatalog.parse({
  agents: [{
    agent: 'codex',
    models: [{ id: 'gpt-5.6', label: 'GPT-5.6', aliases: [], isDefault: true, options: [{ id: 'effort', label: 'Effort', choices: ['low', 'high'], defaultChoice: 'low' }] }],
    configuredDefault: { model: 'gpt-5.6', effort: 'low' },
    error: null,
    checkedAt: 1,
  }],
});
const codexHigh = { agent: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'high' }] };

function startedFromDialog() {
  const dialogRequest = { name: 'repo', path: '/repo', agent: 'codex', setup: codexHigh };
  const filled = withRememberedStart(dialogRequest, emptyStartPicks(), catalog, agents);
  return rememberStart(emptyStartPicks(), startToRemember(filled, dialogRequest.setup, DEFAULT_AGENT_ID, catalog), 1);
}

test('quick add starts the agent, model and effort last picked in the dialog for that project', () => {
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), catalog, agents);
  assert.equal(quickAdd.agent, 'codex');
  assert.deepEqual(quickAdd.setup, codexHigh);
});

test('a remembered model gone from the catalog falls back to the agent own settings', () => {
  const renamedCatalog = AgentModelCatalog.parse({ agents: [{ ...catalog.agents[0], models: [{ ...catalog.agents[0].models[0], id: 'gpt-6' }] }] });
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), renamedCatalog, agents);
  assert.equal(quickAdd.agent, 'codex');
  assert.equal(quickAdd.setup, undefined);
});

test('quick add right after a restart, before the model catalog loads, starts on the agent own settings', () => {
  const coldCatalog = AgentModelCatalog.parse({ agents: [{ ...catalog.agents[0], models: [], checkedAt: null }] });
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), coldCatalog, agents);
  assert.equal(quickAdd.agent, 'codex');
  assert.equal(quickAdd.setup, undefined);
});

test('quick add on a project whose remembered agent is gone starts the default agent', () => {
  const removedCodex = { ...agents, isKnownAgentId: (agentId: string) => agentId === DEFAULT_AGENT_ID };
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), catalog, removedCodex);
  assert.equal(quickAdd.agent, DEFAULT_AGENT_ID);
});

test('quick add starts the agent own default once it changed after the dialog pick', () => {
  const changedDefaultCatalog = AgentModelCatalog.parse({ agents: [{ ...catalog.agents[0], configuredDefault: { model: 'gpt-5.6', effort: 'high' } }] });
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), changedDefaultCatalog, agents);
  assert.equal(quickAdd.agent, 'codex');
  assert.equal(quickAdd.setup, undefined);
});

test('a start picks file from before the default snapshot keeps its projects and forgets its model picks', () => {
  const version1File = { version: 1, agentByPath: { '/repo': { agentId: 'codex', startedAtMs: 1 } }, selectionByAgent: { codex: { selection: codexHigh, pickedAtMs: 1 } } };
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, StartPicksFile.parse(version1File), catalog, agents);
  assert.equal(quickAdd.agent, 'codex');
  assert.equal(quickAdd.setup, undefined);
});

test('quick add keeps the dialog pick while the agent own default cannot be read', () => {
  const { configuredDefault: _unread, ...unreadAgent } = catalog.agents[0];
  const unreadCatalog = AgentModelCatalog.parse({ agents: [unreadAgent] });
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, startedFromDialog(), unreadCatalog, agents);
  assert.deepEqual(quickAdd.setup, codexHigh);
});

test('a dialog pick made before the agent own default was known yields once it is known', () => {
  const { configuredDefault: _unread, ...unreadAgent } = catalog.agents[0];
  const unreadCatalog = AgentModelCatalog.parse({ agents: [unreadAgent] });
  const dialogRequest = { name: 'repo', path: '/repo', agent: 'codex', setup: codexHigh };
  const filled = withRememberedStart(dialogRequest, emptyStartPicks(), unreadCatalog, agents);
  const picks = rememberStart(emptyStartPicks(), startToRemember(filled, dialogRequest.setup, DEFAULT_AGENT_ID, unreadCatalog), 1);
  const quickAdd = withRememberedStart({ name: 'repo', path: '/repo' }, picks, catalog, agents);
  assert.equal(quickAdd.setup, undefined);
});
