import { z } from 'zod';
import { AgentHookGroup, AgentNote } from '../hooks.ts';
import { AgentAccountId, AgentAccountStatuses, LaneAccountLane } from '../agent-accounts.ts';
import { requestId, loose, openObject, nullableString, optionalTimestamp, optionalError, opaqueObject, ConnectableAgent, TelegramDeliveryStatus } from './control-fields.ts';

export const settingsClientVariants = [
  loose('get-settings', { requestId }),
  loose('start-remote-setup', { agent: ConnectableAgent, requestId }),
  loose('get-agent-accounts', { requestId }),
  loose('agent-account-add', { agent: ConnectableAgent, requestId }),
  loose('agent-account-sign-in', { accountId: AgentAccountId, requestId }),
  loose('agent-account-cancel', { accountId: AgentAccountId, requestId }),
  loose('agent-account-code', { accountId: AgentAccountId, code: z.string(), requestId }),
  loose('agent-account-remove', { accountId: AgentAccountId, requestId }),
  loose('agent-account-default', { agent: z.string().min(1), accountId: AgentAccountId.nullable(), requestId }),
  loose('agent-lane-account', { lane: LaneAccountLane, followsDefault: z.boolean(), accountId: AgentAccountId.nullable(), requestId }),
  loose('update-settings', { settings: z.record(z.string(), z.unknown()), requestId }),
  loose('scan-repo-roots', { requestId, includeSuggestions: z.boolean().optional(), includeActivity: z.boolean().optional() }),
  loose('list-agents', { requestId, rescan: z.boolean().optional() }),
  loose('clone-repository', { requestId, source: z.string().max(2048) }),
  loose('list-github-repos', { requestId }),
  loose('list-folders', { requestId, query: z.string().max(4096) }),
  loose('telegram-test', { requestId }),
  loose('request-hooks-report', { requestId }),
  loose('save-hook', { hook: z.record(z.string(), z.unknown()), requestId }),
  loose('delete-hook', { id: z.string(), requestId }),
] as const;

export const settingsServerVariants = [
  loose('hooks-report', {
    requestId,
    ts: optionalTimestamp,
    hooks: z.array(opaqueObject).optional(),
    builtinByAgent: z.array(AgentHookGroup).optional(),
    agentNotes: z.array(AgentNote).optional(),
    events: z.array(openObject({ name: z.string(), matcher: nullableString, description: z.string(), http: z.boolean().optional() })).optional(),
    projects: z.array(openObject({ id: z.string(), name: z.string(), agent: z.string() })).optional(),
    limits: openObject({ maxTimeoutSec: z.number().int().positive() }).optional(),
    error: optionalError,
  }),
  loose('save-hook-result', { requestId, ok: z.boolean(), error: optionalError, hook: opaqueObject.optional() }),
  loose('agent-accounts', { requestId, accounts: AgentAccountStatuses, accountId: AgentAccountId.optional(), error: optionalError }),
  loose('start-remote-setup-result', { requestId, ok: z.boolean(), error: optionalError, sessionId: z.string().optional(), sessionName: z.string().optional() }),
  loose('delete-hook-result', { requestId, ok: z.boolean(), error: optionalError, id: z.string().optional() }),
  loose('hooks-updated', { count: z.number().int().nonnegative() }),
  loose('settings', { settings: opaqueObject, requestId }),
  loose('settings-error', { message: z.string(), requestId }),
  loose('settings-updated', { settings: opaqueObject, requestId }),
  loose('agents-listed', {
    requestId,
    agents: z.array(openObject({ id: z.string(), label: z.string(), resolvable: z.boolean(), hidden: z.boolean().optional() })),
  }),
  loose('repo-roots-scanned', {
    requestId,
    directories: z.array(openObject({
      root: z.string(),
      projects: z.array(openObject({ name: z.string(), path: z.string(), isGit: z.boolean().optional(), lastActivityMs: z.number().optional() })),
    })),
    suggestions: z.array(openObject({ path: z.string(), label: z.string(), gitRepoCount: z.number().int().nonnegative() })).optional(),
    error: z.string().optional(),
  }),
  loose('repository-cloned', { requestId, ok: z.boolean(), path: z.string().optional(), error: optionalError }),
  loose('folders-listed', { requestId, folder: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string(), isGit: z.boolean() })), error: optionalError }),
  loose('github-repos-listed', {
    requestId,
    source: z.enum(['gh', 'app', 'token', 'none']),
    repos: z.array(z.object({ fullName: z.string(), cloneUrl: z.string(), isPrivate: z.boolean(), pushedAt: z.string().nullable() })),
    error: optionalError,
  }),
  loose('telegram-test-result', { requestId, ok: z.boolean(), error: optionalError, telegramDelivery: TelegramDeliveryStatus.nullable() }),
] as const;
