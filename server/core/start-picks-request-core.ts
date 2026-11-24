import type { AgentModelCatalog, ModelSelection } from '../../shared/contracts/agent-models.ts';
import type { StartPicks } from '../../shared/contracts/start-picks.ts';
import { configuredDefaultOf, rememberedAgentFor, rememberedSelectionFor } from '../../shared/start-picks-core.ts';
import type { RememberedStart } from '../../shared/start-picks-core.ts';
import { SHELL_AGENT_ID } from '../../shared/contracts/config.ts';

type StartRequest = { path?: string; repos?: string[]; agent?: string; setup?: ModelSelection };

function requestedAgentOf(request: StartRequest): string | null {
  const agent = request.agent?.trim() ?? '';
  return agent === '' ? null : agent;
}

function rememberedPathOf(request: StartRequest): string | null {
  if (request.repos) return null;
  const path = request.path?.trim() ?? '';
  return path === '' ? null : path;
}

type KnownAgents = { defaultAgentId: string; isKnownAgentId: (agentId: string) => boolean };

function knownRememberedAgent(picks: StartPicks, path: string | null, agents: KnownAgents): string | null {
  const agentId = path === null ? null : rememberedAgentFor(picks, path);
  if (agentId === null || agentId === SHELL_AGENT_ID) return null;
  return agents.isKnownAgentId(agentId) ? agentId : null;
}

export function withRememberedStart<Request extends StartRequest>(request: Request, picks: StartPicks, catalog: AgentModelCatalog, agents: KnownAgents): Request & { agent: string; setup?: ModelSelection } {
  const path = rememberedPathOf(request);
  const agentId = requestedAgentOf(request) ?? knownRememberedAgent(picks, path, agents) ?? agents.defaultAgentId;
  const setup = request.setup ?? rememberedSelectionFor(picks, agentId, catalog);
  const withAgent = { ...request, agent: agentId };
  return setup === null ? withAgent : { ...withAgent, setup };
}

export function startToRemember(filled: StartRequest, explicitSelection: ModelSelection | null, defaultAgentId: string, catalog: AgentModelCatalog): RememberedStart {
  const agentId = requestedAgentOf(filled) ?? defaultAgentId;
  const configuredAtPick = configuredDefaultOf(catalog, agentId);
  return { path: agentId === SHELL_AGENT_ID ? null : rememberedPathOf(filled), agentId, selection: explicitSelection, configuredAtPick };
}
