import { EFFORT_OPTION_ID } from './contracts/agent-models.ts';
import type { AgentModelCatalog, ModelSelection } from './contracts/agent-models.ts';
import type { StartPicks } from './contracts/start-picks.ts';

const MAX_REMEMBERED_STARTS = 50;

export function emptyStartPicks(): StartPicks {
  return { version: 1, agentByPath: {}, selectionByAgent: {} };
}

export type RememberedStart = { path: string | null; agentId: string; selection: ModelSelection | null };

function withAgentForPath(picks: StartPicks, path: string | null, agentId: string, nowMs: number): StartPicks['agentByPath'] {
  if (path === null) return picks.agentByPath;
  const newestFirst = Object.entries({ ...picks.agentByPath, [path]: { agentId, startedAtMs: nowMs } })
    .sort(([, first], [, second]) => second.startedAtMs - first.startedAtMs)
    .slice(0, MAX_REMEMBERED_STARTS);
  return Object.fromEntries(newestFirst);
}

function withSelectionForAgent(picks: StartPicks, selection: ModelSelection | null, nowMs: number): StartPicks['selectionByAgent'] {
  if (selection === null) return picks.selectionByAgent;
  return { ...picks.selectionByAgent, [selection.agent]: { selection, pickedAtMs: nowMs } };
}

export function rememberStart(picks: StartPicks, start: RememberedStart, nowMs: number): StartPicks {
  return {
    version: 1,
    agentByPath: withAgentForPath(picks, start.path, start.agentId, nowMs),
    selectionByAgent: withSelectionForAgent(picks, start.selection, nowMs),
  };
}

export function rememberedAgentFor(picks: StartPicks, path: string): string | null {
  return picks.agentByPath[path]?.agentId ?? null;
}

function listedModelsOf(catalog: AgentModelCatalog, selection: ModelSelection) {
  if (selection.provider === 'openrouter') return catalog.openrouter.models;
  return catalog.agents.find((agentModels) => agentModels.agent === selection.agent)?.models ?? [];
}

function listedModelOf(catalog: AgentModelCatalog, selection: ModelSelection) {
  return listedModelsOf(catalog, selection).find((model) => model.id === selection.model || model.aliases.includes(selection.model ?? ''));
}

function isNativeModelUnconfirmed(catalog: AgentModelCatalog, selection: ModelSelection): boolean {
  if (selection.provider === 'openrouter') return false;
  if (listedModelsOf(catalog, selection).length === 0) return true;
  return selection.model !== null && !listedModelOf(catalog, selection);
}

function withListedEffort(catalog: AgentModelCatalog, selection: ModelSelection): ModelSelection {
  const model = listedModelOf(catalog, selection);
  if (!model) return selection;
  const efforts = model.options.find((option) => option.id === EFFORT_OPTION_ID)?.choices ?? [];
  const options = selection.options.filter((option) => option.id !== EFFORT_OPTION_ID || efforts.includes(option.value));
  return { ...selection, options };
}

export function rememberedSelectionFor(picks: StartPicks, agentId: string, catalog: AgentModelCatalog): ModelSelection | null {
  const selection = picks.selectionByAgent[agentId]?.selection ?? null;
  if (selection === null || selection.agent !== agentId) return null;
  if (isNativeModelUnconfirmed(catalog, selection)) return null;
  return withListedEffort(catalog, selection);
}
