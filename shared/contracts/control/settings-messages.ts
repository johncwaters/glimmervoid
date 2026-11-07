import { z } from 'zod';
import { AgentHookGroup, AgentNote } from '../hooks.ts';
import { requestId, loose, openObject, nullableString, optionalTimestamp, optionalError, opaqueObject, ConnectableAgent, AgentLoginStatuses, TelegramDeliveryStatus } from './control-fields.ts';

export const settingsClientVariants = [
  loose('get-settings', { requestId }),
  loose('get-agent-logins', { requestId }),
  loose('start-remote-setup', { agent: ConnectableAgent, requestId }),
  loose('agent-connect', { agent: ConnectableAgent, action: z.enum(['start', 'cancel']), requestId }),
  loose('agent-connect-code', { agent: ConnectableAgent, code: z.string(), requestId }),
  loose('update-settings', { settings: z.record(z.string(), z.unknown()), requestId }),
  loose('scan-repo-roots', { requestId, includeSuggestions: z.boolean().optional(), includeActivity: z.boolean().optional() }),
  loose('list-agents', { requestId, rescan: z.boolean().optional() }),
  loose('telegram-test', { requestId }),
  loose('request-hooks-report', { requestId }),
  loose('save-hook', { hook: z.record(z.string(), z.unknown()), requestId }),
  loose('delete-hook', { id: z.string(), requestId }),
  loose('add-host', { host: z.record(z.string(), z.unknown()), requestId }),
  loose('remove-host', { id: z.string(), requestId }),
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
  loose('agent-logins', { requestId, logins: AgentLoginStatuses, error: optionalError }),
  loose('start-remote-setup-result', { requestId, ok: z.boolean(), error: optionalError, sessionId: z.string().optional(), sessionName: z.string().optional() }),
  loose('host-change-result', { requestId, ok: z.boolean(), error: optionalError }),
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
  loose('telegram-test-result', { requestId, ok: z.boolean(), error: optionalError, telegramDelivery: TelegramDeliveryStatus.nullable() }),
] as const;
