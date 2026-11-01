import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigUpdate, RUNTIME_CONFIG_SCALAR_KEYS, configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { isRecord } from '../../../shared/coerce.ts';
import { errorCode, errorMessage } from '../../../shared/text.ts';
import type { AgentHookGroup } from '../../../shared/contracts/hooks.ts';
import { DEFAULT_AGENT_ID, describeAgentResolvability, getAdapter, listAgentIds, resetCommandCache } from '../../../session/adapters/index.ts';
import type { ResolvedHookTool } from '../../../session/core/hook-tools.ts';
import type { InstalledHookFlags } from '../../../session/core/user-hooks-core.ts';
import { agentHookGroupOf, HOOK_EVENT_CATALOG, ID_RE as HOOK_ID_RE, MAX_TIMEOUT_SEC as HOOK_MAX_TIMEOUT_SEC, normalizeHook, rawStoredHooks, readStoredHooks, removeHook, upsertHook } from '../../../session/core/user-hooks-core.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { ABORT_CONFIG_SAVE } from '../../config-store.ts';
import type { ProjectEntry } from '../../config-store.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { mergeSettingsBlock, settingsBlockSpecFor, validateSettingsBlock } from '../../core/settings-block-core.ts';
import { mergeWorkflowsUpdateOverStored } from '../../core/workflows-core.ts';
import { suggestRepoRoots } from '../../repo-root-suggestions.ts';
import { resolvePackageBin } from '../../runtime-paths.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import { buildSettingsPayload as buildSettingsPayloadFrom } from '../../settings-payload.ts';
import { expandTilde } from '../../usage/core/usage-scan-core.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, replyTo, sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function scanRepoRoots(roots: string[] | undefined): { root: string; projects: { name: string; path: string }[] }[] {
  const results: { root: string; projects: { name: string; path: string }[] }[] = [];
  if (!roots) return results;
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) {
        results.push({ root, projects: [] });
        continue;
      }
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const projects = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => ({ name: d.name, path: path.join(root, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      results.push({ root, projects });
    } catch (err) {
      console.warn(`[settings] Failed to scan root: ${root}: ${errorCode(err) || errorMessage(err)}`);
      results.push({ root, projects: [] });
    }
  }
  return results;
}

const SETTINGS_NOT_SAVED_MESSAGE = 'Settings were not saved: the config file could not be read, validated or written.';

function settingsNotSavedText(failureReason: string | null): string {
  if (failureReason === null) return SETTINGS_NOT_SAVED_MESSAGE;
  return `Settings were not saved. ${failureReason}`;
}
const WORKFLOWS_SETTINGS_KEY = 'workflows';

type IncomingSettingsBlock = readonly [key: string, block: Record<string, unknown>];

function incomingSettingsBlocks(incoming: Record<string, unknown>): IncomingSettingsBlock[] {
  return Object.entries(incoming)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[0] !== WORKFLOWS_SETTINGS_KEY && isRecord(entry[1]));
}

function incomingSettingsBlocksError(blocks: readonly IncomingSettingsBlock[]): string | null {
  for (const [key, block] of blocks) {
    const error = validateSettingsBlock(block, settingsBlockSpecFor(key));
    if (error) return error;
  }
  return null;
}

const AGENT_CONNECT_UNAVAILABLE = 'Agent sign-in is not available on this server.';

function createSettingsHandlers(_context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const {
    config,
    configStore,
    broadcastControl,
    applyConfigReload,
    applySettingsReload,
    telegramDelivery = null,
    coderEnv = null,
    agentConnect = null,
    remoteSetup = null,
  } = deps;

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, telegramDelivery: telegramDelivery?.status() ?? null, coderEnvironments: coderEnv?.availableEnvironments() ?? null, agentLogins: agentConnect?.logins() ?? null });
  }

  function handleGetSettings(msg: ClientMessageOf<'get-settings'>, ws: ControlSocket): void {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
    void agentConnect?.refresh();
  }

  async function handleGetAgentLogins(msg: ClientMessageOf<'get-agent-logins'>, ws: ControlSocket): Promise<void> {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    replyTo(ws, msg, 'agent-logins', { logins: await agentConnect.refresh() });
  }

  async function handleStartRemoteSetup(msg: ClientMessageOf<'start-remote-setup'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'start-remote-setup-result', { ok: false, error: null, ...payload });
    if (!remoteSetup) { reply({ error: 'Remote host setup is not available on this server.' }); return; }
    const login = agentConnect?.logins().find((status) => status.agent === msg.agent);
    if (login?.state !== 'signed-in') { reply({ error: `Sign in to ${msg.agent} before starting the remote setup session.` }); return; }
    const outcome = await remoteSetup.start(msg.agent);
    if (!outcome.ok) { reply({ error: outcome.error }); return; }
    reply({ ok: true, sessionId: outcome.sessionId, sessionName: outcome.sessionName });
  }

  async function handleAgentConnect(msg: ClientMessageOf<'agent-connect'>, ws: ControlSocket): Promise<void> {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    const outcome = msg.action === 'start' ? await agentConnect.start(msg.agent) : agentConnect.cancel(msg.agent);
    replyTo(ws, msg, 'agent-logins', { logins: agentConnect.logins(), error: outcome.ok ? undefined : outcome.error });
  }

  function handleAgentConnectCode(msg: ClientMessageOf<'agent-connect-code'>, ws: ControlSocket): void {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    const outcome = agentConnect.submitCode(msg.agent, msg.code);
    replyTo(ws, msg, 'agent-logins', { logins: agentConnect.logins(), error: outcome.ok ? undefined : outcome.error });
  }

  function handleUpdateSettings(msg: ClientMessageOf<'update-settings'>, ws: ControlSocket): void {
    const parsedSettings = ConfigUpdate.safeParse(msg.settings || {});
    if (!parsedSettings.success) {
      sendError(ws, configIssueMessage(parsedSettings.error), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    const s = parsedSettings.data;

    const incoming: Record<string, unknown> = s;

    if (s.repoRoots) s.repoRoots = s.repoRoots.map((root) => expandTilde(root, process.env, os.homedir()));
    const invalidPaths = (s.repoRoots || []).filter(root => !isExistingDirectory(root));
    if (invalidPaths.length > 0) {
      sendError(ws, `Repository roots must be existing directories: ${invalidPaths.join(', ')}`, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const blocks = incomingSettingsBlocks(incoming);
    const blockError = incomingSettingsBlocksError(blocks);
    if (blockError) {
      sendError(ws, blockError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const workflowsUpdate = s.workflows;
    const workflowsMerge = workflowsUpdate ? mergeWorkflowsUpdateOverStored(config.workflows, workflowsUpdate) : null;
    if (workflowsMerge && !workflowsMerge.ok) {
      sendError(ws, workflowsMerge.error, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const inSaveWorkflowsFailure: { error: string | null } = { error: null };
    const skippedPermissionsByDefault = machineSkipsPermissionsByDefault(config);
    const freshConfig = configStore.save(cfg => {
      for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
        if (incoming[key] == null) continue;
        if (typeof incoming[key] === 'boolean' && configStore.isUnchosenLaunchDefault(cfg, key, incoming[key])) continue;
        cfg[key] = incoming[key];
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
      for (const [key, block] of blocks) cfg[key] = mergeSettingsBlock(cfg[key], block, settingsBlockSpecFor(key));
      if (!workflowsUpdate) return undefined;
      const storedWorkflowsMerge = mergeWorkflowsUpdateOverStored(cfg.workflows, workflowsUpdate);
      if (!storedWorkflowsMerge.ok) {
        inSaveWorkflowsFailure.error = storedWorkflowsMerge.error;
        return ABORT_CONFIG_SAVE;
      }
      cfg.workflows = storedWorkflowsMerge.workflows;
      return undefined;
    });
    if (inSaveWorkflowsFailure.error !== null) {
      sendError(ws, inSaveWorkflowsFailure.error, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    if (!freshConfig) {
      sendError(ws, settingsNotSavedText(configStore.lastSaveFailureReason()), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    applySettingsReload(freshConfig);
    if (machineSkipsPermissionsByDefault(freshConfig) !== skippedPermissionsByDefault) applyConfigReload(freshConfig);
    const updatedSettings = buildSettingsPayload();

    ws.send(JSON.stringify({
      type: 'settings-updated',
      requestId: msg.requestId || null,
      settings: updatedSettings,
    }));
    broadcastControl({
      type: 'settings-updated',
      settings: updatedSettings,
    });
    console.log('[control] Settings updated via UI');
  }

  function handleListAgents(msg: ClientMessageOf<'list-agents'>, ws: ControlSocket): void {
    if (msg.rescan) resetCommandCache();
    const agents = listAgentIds().map((id) => {
      const { label, resolvable } = describeAgentResolvability(id);
      return { id, label, resolvable };
    });
    ws.send(JSON.stringify({
      type: 'agents-listed',
      requestId: msg.requestId || null,
      agents,
    }));
  }

  async function handleScanRepoRoots(msg: ClientMessageOf<'scan-repo-roots'>, ws: ControlSocket): Promise<void> {
    const directories = scanRepoRoots(config.repoRoots);
    const suggestions = msg.includeSuggestions ? await suggestRepoRoots({ homeDir: os.homedir(), configuredRoots: config.repoRoots || [] }) : undefined;
    ws.send(JSON.stringify({
      type: 'repo-roots-scanned',
      requestId: msg.requestId || null,
      directories,
      suggestions,
    }));
  }

  async function handleTelegramTest(msg: ClientMessageOf<'telegram-test'>, ws: ControlSocket): Promise<void> {
    if (!telegramDelivery) {
      replyTo(ws, msg, 'telegram-test-result', { ok: false, error: 'Telegram is not running on this server.', telegramDelivery: null });
      return;
    }
    const sendResult = await telegramDelivery.sendTest();
    replyTo(ws, msg, 'telegram-test-result', { ok: sendResult.ok, error: sendResult.error, telegramDelivery: telegramDelivery.status() });
  }

  function builtinHookGroups(): AgentHookGroup[] {
    const hookTools: ResolvedHookTool[] = [];
    const saneYoloPath = config.saneYolo !== false ? resolvePackageBin('cc-safety-net', 'cc-safety-net') : null;
    if (saneYoloPath) hookTools.push({ id: 'saneYolo', binPath: saneYoloPath });
    const flags: InstalledHookFlags = {
      detectScheduledWakeups: config.detectScheduledWakeups !== false,
      observeToolCalls: false,
      hookTools,
      planReview: config.planReview?.enabled !== false,
      holdsQuestionsForParent: true,
    };
    return listAgentIds().flatMap((agentId) => {
      const adapter = getAdapter(agentId);
      const describeInstalledHooks = adapter?.hooks?.describeInstalledHooks;
      if (!adapter || !describeInstalledHooks) return [];
      return [agentHookGroupOf(adapter.id, adapter.label, describeInstalledHooks(flags))];
    });
  }

  function hooksReportProjects(): { id: string; name: string; agent: string }[] {
    return (config.projects || [])
      .filter((project): project is ProjectEntry & { id: string; name: string } => (
        typeof project?.id === 'string' && typeof project?.name === 'string'
      ))
      .map((project) => ({ id: project.id, name: project.name, agent: typeof project.agent === 'string' ? project.agent : DEFAULT_AGENT_ID }));
  }

  function handleRequestHooksReport(msg: ClientMessageOf<'request-hooks-report'>, ws: ControlSocket): void {
    replyTo(ws, msg, 'hooks-report', {
      ts: Date.now(),
      hooks: readStoredHooks(config.hooks),
      builtinByAgent: builtinHookGroups(),
      events: HOOK_EVENT_CATALOG,
      projects: hooksReportProjects(),

      limits: { maxTimeoutSec: HOOK_MAX_TIMEOUT_SEC },
      error: null,
    });
  }

  function handleSaveHook(msg: ClientMessageOf<'save-hook'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'save-hook-result', { ok: false, error: null, ...payload });
    const input = msg.hook && typeof msg.hook === 'object' ? msg.hook : {};
    const requestedId = typeof input.id === 'string' ? input.id : '';
    if (requestedId && !HOOK_ID_RE.test(requestedId)) { reply({ error: 'hook id is invalid' }); return; }
    const id = requestedId || crypto.randomUUID();

    const stored = requestedId ? readStoredHooks(config.hooks).find((hook) => hook.id === requestedId) : null;
    if (requestedId && !stored) { reply({ error: 'Unknown hook' }); return; }

    const knownProjectIds = new Set(hooksReportProjects().map((project) => project.id));
    for (const projectId of stored?.projects || []) knownProjectIds.add(projectId);
    const normalized = normalizeHook(input, { id, knownProjectIds });
    if (!normalized.ok) { reply({ error: normalized.error }); return; }

    const freshConfig = configStore.save((cfg) => {
      cfg.hooks = upsertHook(rawStoredHooks(cfg.hooks), normalized.hook);
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, hook: normalized.hook });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] save-hook: ${normalized.hook.name} (${normalized.hook.event})`);
  }

  function handleDeleteHook(msg: ClientMessageOf<'delete-hook'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'delete-hook-result', { ok: false, error: null, ...payload });
    const id = typeof msg.id === 'string' ? msg.id : '';

    if (!rawStoredHooks(config.hooks).some((hook) => hook && hook.id === id)) { reply({ error: 'Unknown hook' }); return; }
    const freshConfig = configStore.save((cfg) => {
      const remaining = removeHook(rawStoredHooks(cfg.hooks), id);

      if (remaining.length === 0) delete cfg.hooks;
      if (remaining.length > 0) cfg.hooks = remaining;
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, id });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] delete-hook: ${id}`);
  }

  const handlers = {
    'get-settings': handleGetSettings,
    'get-agent-logins': handleGetAgentLogins,
    'agent-connect': handleAgentConnect,
    'start-remote-setup': handleStartRemoteSetup,
    'agent-connect-code': handleAgentConnectCode,
    'update-settings': handleUpdateSettings,
    'scan-repo-roots': handleScanRepoRoots,
    'list-agents': handleListAgents,
    'telegram-test': handleTelegramTest,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'delete-hook': handleDeleteHook,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'get-settings': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'get-agent-logins': (_msg, requestId, message) => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'agent-connect': (_msg, requestId, message) => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'start-remote-setup': (_msg, requestId, message) => ({ type: 'start-remote-setup-result', requestId, ok: false, error: message }),
    'agent-connect-code': (_msg, requestId, message) => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'update-settings': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': (_msg, requestId, message) => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'list-agents': (_msg, requestId, message) => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'telegram-test': (_msg, requestId, message) => ({ type: 'telegram-test-result', requestId, ok: false, error: message, telegramDelivery: null }),
    'request-hooks-report': (_msg, requestId, message) => ({ type: 'hooks-report', requestId, error: message }),
    'save-hook': (_msg, requestId, message) => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'delete-hook': (_msg, requestId, message) => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies };
}

export { createSettingsHandlers };
