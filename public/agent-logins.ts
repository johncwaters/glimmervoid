import { AgentLoginStatuses } from '#shared/contracts/control-messages.ts';
import type { AgentLoginStatus, ConnectableAgent } from '#shared/contracts/control-messages.ts';

let latestAgentLogins: AgentLoginStatus[] = [];
const agentLoginListeners = new Set<() => void>();

export function applyAgentLogins(logins: unknown) {
  const parsed = AgentLoginStatuses.safeParse(logins);
  if (!parsed.success) return;
  latestAgentLogins = parsed.data;
  for (const listener of agentLoginListeners) listener();
}

export function agentLoginOf(agent: ConnectableAgent): AgentLoginStatus | null {
  return latestAgentLogins.find((login) => login.agent === agent) ?? null;
}

export function onAgentLoginsChanged(listener: () => void): () => void {
  agentLoginListeners.add(listener);
  return () => { agentLoginListeners.delete(listener); };
}
