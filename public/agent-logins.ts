import { DEFAULT_REPLY_TIMEOUT_MS } from './action-status.ts';
import { sendControlRequest } from './control-ws.ts';
import { AgentLoginStatuses, type ConnectableAgent } from '#shared/contracts/control-messages.ts';
import type { AgentLoginStatus } from '#shared/contracts/control-messages.ts';

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

export const CONNECTABLE_AGENT_NAMES: Readonly<Record<ConnectableAgent, string>> = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });

export function agentLoginSummary(login: AgentLoginStatus | null, agent: ConnectableAgent): string {
  const name = CONNECTABLE_AGENT_NAMES[agent];
  if (!login) return `Checking whether ${name} is signed in.`;
  if (login.state === 'signed-in' && login.source === 'host') return `${name} uses the login already on this machine.`;
  if (login.state === 'signed-in') return `${name} uses the login Glimmervoid connected.`;
  if (login.state === 'connecting') return login.reason ?? `${name} sign-in is waiting for you.`;
  if (login.state === 'failed') return login.reason ?? `${name} sign-in failed.`;
  return `${name} has no login on this machine, so remote ${name} sessions cannot sign in.`;
}

export function refreshAgentLogins() {
  sendControlRequest('get-agent-logins', {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((reply) => { if (reply.type === 'agent-logins') applyAgentLogins(reply.logins); })
    .catch(() => {});
}
