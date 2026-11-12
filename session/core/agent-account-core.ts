import type { AgentAccount } from "../../shared/contracts/agent-accounts.ts";

type JsonObject = Record<string, unknown>;

type SessionAccountHome =
  | { kind: "machine-login" }
  | { kind: "account"; account: AgentAccount }
  | { kind: "refused"; reason: string };

function resolveSessionAccountHome(accounts: readonly AgentAccount[], accountId: string | null | undefined, agentId: string): SessionAccountHome {
  if (!accountId) return { kind: "machine-login" };
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return { kind: "refused", reason: `the account ${accountId} this session runs under no longer exists; pick another account for it` };
  if (account.agent !== agentId) return { kind: "refused", reason: `the account ${account.label} belongs to ${account.agent}, not ${agentId}` };
  return { kind: "account", account };
}

type NewSessionAccount = { accountId: string | null } | { refusal: string };

interface NewSessionAccountRequest {
  accounts: readonly AgentAccount[];
  defaults: Readonly<Record<string, string>>;
  requestedAccountId: string | null | undefined;
  agentId: string;
  isRemote: boolean;
}

function resolveNewSessionAccount({ accounts, defaults, requestedAccountId, agentId, isRemote }: NewSessionAccountRequest): NewSessionAccount {
  if (requestedAccountId === undefined) {
    const defaultAccount = accounts.find((account) => account.id === defaults[agentId] && account.agent === agentId);
    return { accountId: defaultAccount && !isRemote ? defaultAccount.id : null };
  }
  if (requestedAccountId === null) return { accountId: null };
  const account = accounts.find((candidate) => candidate.id === requestedAccountId);
  if (!account) return { refusal: `The account ${requestedAccountId} is not in config.json.` };
  if (account.agent !== agentId) return { refusal: `The account ${account.label} belongs to ${account.agent}, not ${agentId}.` };
  if (isRemote) return { refusal: `A Coder workspace session cannot run under the added account ${account.label} yet.` };
  return { accountId: account.id };
}

function mergeSharedKeys(accountFile: JsonObject, realFile: JsonObject, sharedKeys: readonly string[], seededKeys: readonly string[] = []): JsonObject | null {
  const merged: JsonObject = { ...accountFile };
  let hasChanged = false;
  for (const key of seededKeys) {
    if (!Object.hasOwn(realFile, key)) continue;
    if (Object.hasOwn(accountFile, key) && JSON.stringify(accountFile[key]) === JSON.stringify(realFile[key])) continue;
    merged[key] = realFile[key];
    hasChanged = true;
  }
  for (const key of sharedKeys) {
    const isInReal = Object.hasOwn(realFile, key);
    const isInAccount = Object.hasOwn(accountFile, key);
    if (!isInReal && !isInAccount) continue;
    if (!isInReal) {
      delete merged[key];
      hasChanged = true;
      continue;
    }
    if (isInAccount && JSON.stringify(accountFile[key]) === JSON.stringify(realFile[key])) continue;
    merged[key] = realFile[key];
    hasChanged = true;
  }
  return hasChanged ? merged : null;
}

export { mergeSharedKeys, resolveNewSessionAccount, resolveSessionAccountHome };
export type { SessionAccountHome };
