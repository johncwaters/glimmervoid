import { z } from 'zod';

const AGENT_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const AgentAccountId = z.string({ error: 'an agent account id must be a string' })
  .regex(AGENT_ACCOUNT_ID_RE, { error: 'an agent account id must be 1 to 40 lowercase letters, digits and dashes, starting with a letter or digit' });
export type AgentAccountId = z.infer<typeof AgentAccountId>;

export const AgentAccount = z.strictObject({
  id: AgentAccountId,
  agent: z.string({ error: 'agentAccounts[].agent must be a string' }).min(1, { error: 'agentAccounts[].agent must not be empty' }),
  label: z.string({ error: 'agentAccounts[].label must be a string' })
    .min(1, { error: 'agentAccounts[].label must not be empty' })
    .max(60, { error: 'agentAccounts[].label must be at most 60 characters' }),
  folder: z.string({ error: 'agentAccounts[].folder must be a string' }).min(1, { error: 'agentAccounts[].folder must not be empty' }),
});
export type AgentAccount = z.infer<typeof AgentAccount>;

export const AgentAccounts = z.array(AgentAccount, { error: 'agentAccounts must be an array' })
  .superRefine((accounts, ctx) => {
    const seenIds = new Set<string>();
    for (const [index, account] of accounts.entries()) {
      if (seenIds.has(account.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `agentAccounts[${index}].id "${account.id}" is declared more than once` });
      seenIds.add(account.id);
    }
  });

export const AgentAccountDefaults = z.record(
  z.string({ error: 'agentAccountDefaults keys must be agent ids' }),
  AgentAccountId,
  { error: 'agentAccountDefaults must map an agent id to an agentAccounts id' },
);
export type AgentAccountDefaults = z.infer<typeof AgentAccountDefaults>;

export const AgentAccountLogin = z.strictObject({
  state: z.enum(['signed-in', 'signed-out', 'connecting', 'failed', 'unchecked']),
  verificationUrl: z.string().nullable(),
  userCode: z.string().nullable(),
  needsPastedCode: z.boolean(),
  reason: z.string().nullable(),
});
export type AgentAccountLogin = z.infer<typeof AgentAccountLogin>;

export const AgentAccountStatus = z.strictObject({
  accountId: AgentAccountId.nullable(),
  agent: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  login: AgentAccountLogin,
  usedBy: z.array(z.string()),
  isPending: z.boolean(),
  isDefault: z.boolean(),
});
export type AgentAccountStatus = z.infer<typeof AgentAccountStatus>;

export const AgentAccountStatuses = z.array(AgentAccountStatus);
