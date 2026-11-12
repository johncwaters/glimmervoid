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

function mergeSharedKeys(accountFile: JsonObject, realFile: JsonObject, sharedKeys: readonly string[]): JsonObject | null {
  const merged: JsonObject = { ...accountFile };
  let hasChanged = false;
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

export { mergeSharedKeys, resolveSessionAccountHome };
export type { SessionAccountHome };
