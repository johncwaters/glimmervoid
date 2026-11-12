import { DEFAULT_REPLY_TIMEOUT_MS } from './action-status.ts';
import { sendControlRequest } from './control-ws.ts';
import { ConnectableAgent } from '#shared/contracts/control-messages.ts';
import { AgentAccountStatuses } from '#shared/contracts/agent-accounts.ts';
import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';

export const CONNECTABLE_AGENT_NAMES: Readonly<Record<ConnectableAgent, string>> = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });

export function connectableAgentOf(agentId: string): ConnectableAgent | null {
  const parsed = ConnectableAgent.safeParse(agentId);
  return parsed.success ? parsed.data : null;
}

let latestAgentAccounts: AgentAccountStatus[] = [];
const agentAccountListeners = new Set<() => void>();

export function applyAgentAccounts(accounts: unknown) {
  const parsed = AgentAccountStatuses.safeParse(accounts);
  if (!parsed.success) return;
  latestAgentAccounts = parsed.data;
  for (const listener of agentAccountListeners) listener();
}

export function agentAccountsOf(agent: string): AgentAccountStatus[] {
  return latestAgentAccounts.filter((account) => account.agent === agent);
}

export function agentAccountOf(accountId: string): AgentAccountStatus | null {
  return latestAgentAccounts.find((account) => account.accountId === accountId) ?? null;
}

export function onAgentAccountsChanged(listener: () => void): () => void {
  agentAccountListeners.add(listener);
  return () => { agentAccountListeners.delete(listener); };
}

export function refreshAgentAccounts() {
  sendControlRequest('get-agent-accounts', {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((reply) => { if (reply.type === 'agent-accounts') applyAgentAccounts(reply.accounts); })
    .catch(() => {});
}

export function agentAccountSummary(account: AgentAccountStatus | null): string {
  if (!account) return 'Start sign-in to add the account.';
  if (account.login.state === 'signed-in') return `Signed in as ${account.label}${account.detail ? ` (${account.detail})` : ''}.`;
  if (account.login.state === 'connecting') return account.login.reason ?? 'The sign-in is waiting for you.';
  if (account.login.state === 'failed') return account.login.reason ?? 'The sign-in failed.';
  return account.login.reason ?? `${account.label} is signed out.`;
}
