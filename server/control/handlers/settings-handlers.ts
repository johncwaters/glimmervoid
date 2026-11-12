import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigUpdate, RUNTIME_CONFIG_SCALAR_KEYS, configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { isRecord } from '../../../shared/coerce.ts';
import { errorCode, errorMessage } from '../../../shared/text.ts';
import type { AgentHookGroup } from '../../../shared/contracts/hooks.ts';
import { PackApproveRequest } from '../../../shared/contracts/control/pack-messages.ts';
import { routeAgentNotes } from '../../../session/core/session-routes.ts';
import { REFOCUS_NOTE } from '../../../session/core/refocus-core.ts';
import { ATTACHED_BOARD_NOTE, BOARD_CONTEXT_NOTE } from '../../core/whiteboard-store-core.ts';
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
import { resolvePackageBin, scriptLaunch } from '../../runtime-paths.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import { buildSettingsPayload as buildSettingsPayloadFrom } from '../../settings-payload.ts';
import { expandTilde } from '../../usage/core/usage-scan-core.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, replyTo, sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import { clock } from '../../../shared/clock.ts';

type ScannedProject = { name: string; path: string; lastActivityMs?: number };

function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function scannedProjectOf(root: string, entry: fs.Dirent): ScannedProject | null {
  const entryPath = path.join(root, entry.name);
  if (entry.isDirectory()) return { name: entry.name, path: entryPath };
  if (!entry.isSymbolicLink() || !isExistingDirectory(entryPath)) return null;
  return { name: entry.name, path: realPathOrSelf(entryPath) };
}

function scanRepoRoots(roots: string[] | undefined): { root: string; projects: ScannedProject[] }[] {
  const results: { root: string; projects: ScannedProject[] }[] = [];
  if (!roots) return results;
  const seenRealPaths = new Set<string>();
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) {
        results.push({ root, projects: [] });
        continue;
      }
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const projects = entries
        .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => scannedProjectOf(root, d))
        .filter((project): project is ScannedProject => project !== null)
        .filter((project) => {
          const projectRealPath = realPathOrSelf(project.path);
          if (seenRealPaths.has(projectRealPath)) return false;
          seenRealPaths.add(projectRealPath);
          return true;
        });
      results.push({ root, projects });
    } catch (err) {
      console.warn(`[settings] Failed to scan root: ${root}: ${errorCode(err) || errorMessage(err)}`);
      results.push({ root, projects: [] });
    }
  }
  return results;
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

async function gitDirectoryOf(projectPath: string): Promise<string | undefined> {
  const gitEntry = path.join(projectPath, '.git');
  const gitEntryStat = await fs.promises.stat(gitEntry);
  if (gitEntryStat.isDirectory()) return gitEntry;
  const linkedGitDir = GITDIR_LINE.exec(await fs.promises.readFile(gitEntry, 'utf8'))?.[1];
  return linkedGitDir ? path.resolve(projectPath, linkedGitDir) : undefined;
}

async function projectLastActivityMs(projectPath: string): Promise<number | undefined> {
  try {
    const gitDirectory = await gitDirectoryOf(projectPath);
    return gitDirectory ? (await fs.promises.stat(gitDirectory)).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function withProjectActivity(directories: { root: string; projects: ScannedProject[] }[]) {
  return Promise.all(directories.map(async ({ root, projects }) => ({
    root,
    projects: await Promise.all(projects.map(async (project) => ({ ...project, lastActivityMs: await projectLastActivityMs(project.path) }))),
  })));
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

const AGENT_ACCOUNTS_UNAVAILABLE = 'Agent accounts are not available on this server.';
type AgentAccountMessageType = 'get-agent-accounts' | 'agent-account-add' | 'agent-account-sign-in' | 'agent-account-cancel' | 'agent-account-code' | 'agent-account-remove' | 'agent-account-default' | 'agent-lane-account';

function createSettingsHandlers(_context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const {
    config,
    configStore,
    broadcastControl,
    applyConfigReload,
    applySettingsReload,
    telegramDelivery = null,
    agentAccounts = null,
    remoteSetup = null,
  } = deps;

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, telegramDelivery: telegramDelivery?.status() ?? null});
  }

  function handleGetSettings(msg: ClientMessageOf<'get-settings'>, ws: ControlSocket): void {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
  }

  async function handleStartRemoteSetup(msg: ClientMessageOf<'start-remote-setup'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'start-remote-setup-result', { ok: false, error: null, ...payload });
    if (!remoteSetup) { reply({ error: 'Remote host setup is not available on this server.' }); return; }
    const { label, resolvable } = describeAgentResolvability(msg.agent);
    if (!resolvable) { reply({ error: `Install ${label} on this machine before starting the remote setup session.` }); return; }
    const outcome = await remoteSetup.start(msg.agent);
    if (!outcome.ok) { reply({ error: outcome.error }); return; }
    reply({ ok: true, sessionId: outcome.sessionId, sessionName: outcome.sessionName });
  }

  async function answerAgentAccounts(msg: ClientMessageOf<AgentAccountMessageType>, ws: ControlSocket, act: (accounts: NonNullable<typeof agentAccounts>) => Promise<{ ok: true; accountId?: string } | { ok: false; error: string }>): Promise<void> {
    if (!agentAccounts) {
      replyTo(ws, msg, 'agent-accounts', { accounts: [], error: AGENT_ACCOUNTS_UNAVAILABLE });
      return;
    }
    const outcome = await act(agentAccounts);
    if (!outcome.ok) {
      replyTo(ws, msg, 'agent-accounts', { accounts: agentAccounts.list(), error: outcome.error });
      return;
    }
    replyTo(ws, msg, 'agent-accounts', { accounts: agentAccounts.list(), accountId: outcome.accountId });
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
    const hiddenAgentIds = new Set(config.hiddenAgents ?? []);
    const agents = listAgentIds().map((id) => {
      const { label, resolvable } = describeAgentResolvability(id);
      return { id, label, resolvable, hidden: hiddenAgentIds.has(id) };
    });
    ws.send(JSON.stringify({
      type: 'agents-listed',
      requestId: msg.requestId || null,
      agents,
    }));
  }

  async function handleScanRepoRoots(msg: ClientMessageOf<'scan-repo-roots'>, ws: ControlSocket): Promise<void> {
    const scannedDirectories = scanRepoRoots(config.repoRoots);
    const directories = msg.includeActivity ? await withProjectActivity(scannedDirectories) : scannedDirectories;
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
    if (saneYoloPath) hookTools.push({ id: 'saneYolo', binPath: saneYoloPath, launch: scriptLaunch(saneYoloPath, 'cc-safety-net') });
    const flags: InstalledHookFlags = {
      detectScheduledWakeups: config.detectScheduledWakeups !== false,
      observeToolCalls: false,
      hookTools,
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
      ts: clock.nowMs(),
      hooks: readStoredHooks(config.hooks),
      builtinByAgent: builtinHookGroups(),
      agentNotes: [...routeAgentNotes(), BOARD_CONTEXT_NOTE, ATTACHED_BOARD_NOTE, REFOCUS_NOTE],
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

  async function handlePackApprove(msg: ClientMessageOf<'pack-approve'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: { ok: boolean; error?: string }) => replyTo(ws, msg, 'pack-approve-result', outcome);
    const parsed = PackApproveRequest.safeParse({ fingerprint: msg.fingerprint });
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    if (!deps.packs) { reply({ ok: false, error: 'Packs are not running' }); return; }
    reply(await deps.packs.approve(parsed.data.fingerprint));
  }

  async function handlePackDataGet(msg: ClientMessageOf<'pack-data-get'>, ws: ControlSocket): Promise<void> {
    if (!deps.packData) { replyTo(ws, msg, 'pack-data-result', { ok: false, error: 'Packs are not running' }); return; }
    replyTo(ws, msg, 'pack-data-result', await deps.packData.get(msg.pack));
  }

  async function handlePackDataSet(msg: ClientMessageOf<'pack-data-set'>, ws: ControlSocket): Promise<void> {
    if (!deps.packData) { replyTo(ws, msg, 'pack-data-result', { ok: false, error: 'Packs are not running' }); return; }
    replyTo(ws, msg, 'pack-data-result', await deps.packData.set(msg.pack, msg.key, msg.value));
  }

  async function replySourceChange(ws: ControlSocket, msg: { requestId?: string | null }, change: (sources: NonNullable<typeof deps.packSources>) => Promise<{ ok: true; text: string } | { ok: false; error: string }>): Promise<void> {
    if (!deps.packSources) { replyTo(ws, msg, 'pack-source-result', { ok: false, error: 'Packs are not running' }); return; }
    const outcome = await change(deps.packSources);
    replyTo(ws, msg, 'pack-source-result', outcome.ok ? { ok: true, text: outcome.text, error: null } : { ok: false, error: outcome.error });
  }

  function connectFrames(): readonly unknown[] {
    return deps.packs ? [deps.packs.statusFrame()] : [];
  }

  const handlers = {
    'get-settings': handleGetSettings,
    'start-remote-setup': handleStartRemoteSetup,
    'get-agent-accounts': (msg, ws) => answerAgentAccounts(msg, ws, async (accounts) => { await accounts.refresh(); return { ok: true }; }),
    'agent-account-add': (msg, ws) => answerAgentAccounts(msg, ws, (accounts) => accounts.add(msg.agent)),
    'agent-account-sign-in': (msg, ws) => answerAgentAccounts(msg, ws, (accounts) => accounts.signIn(msg.accountId)),
    'agent-account-cancel': (msg, ws) => answerAgentAccounts(msg, ws, (accounts) => accounts.cancel(msg.accountId)),
    'agent-account-code': (msg, ws) => answerAgentAccounts(msg, ws, async (accounts) => accounts.submitCode(msg.accountId, msg.code)),
    'agent-account-remove': (msg, ws) => answerAgentAccounts(msg, ws, (accounts) => accounts.remove(msg.accountId)),
    'agent-account-default': (msg, ws) => answerAgentAccounts(msg, ws, async (accounts) => accounts.setDefault(msg.agent, msg.accountId)),
    'agent-lane-account': (msg, ws) => answerAgentAccounts(msg, ws, async (accounts) => accounts.setLaneAccount(msg.lane, msg.followsDefault ? { followsDefault: true } : { followsDefault: false, accountId: msg.accountId })),
    'update-settings': handleUpdateSettings,
    'scan-repo-roots': handleScanRepoRoots,
    'list-agents': handleListAgents,
    'telegram-test': handleTelegramTest,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'delete-hook': handleDeleteHook,
    'pack-approve': handlePackApprove,
    'pack-data-get': handlePackDataGet,
    'pack-data-set': handlePackDataSet,
    'pack-source-add': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.add(msg.url)),
    'pack-source-update': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.update(msg.slug)),
    'pack-source-remove': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.remove(msg.slug)),
    'pack-source-enable': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.setPackEnabled(msg.slug, msg.pack, msg.isEnabled)),
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'get-settings': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'start-remote-setup': (_msg, requestId, message) => ({ type: 'start-remote-setup-result', requestId, ok: false, error: message }),
    'get-agent-accounts': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-add': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-sign-in': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-cancel': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-code': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-remove': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-default': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-lane-account': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'update-settings': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': (_msg, requestId, message) => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'list-agents': (_msg, requestId, message) => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'telegram-test': (_msg, requestId, message) => ({ type: 'telegram-test-result', requestId, ok: false, error: message, telegramDelivery: null }),
    'request-hooks-report': (_msg, requestId, message) => ({ type: 'hooks-report', requestId, error: message }),
    'save-hook': (_msg, requestId, message) => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'delete-hook': (_msg, requestId, message) => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
    'pack-approve': (_msg, requestId, message) => ({ type: 'pack-approve-result', requestId, ok: false, error: message }),
    'pack-data-get': (_msg, requestId, message) => ({ type: 'pack-data-result', requestId, ok: false, error: message }),
    'pack-data-set': (_msg, requestId, message) => ({ type: 'pack-data-result', requestId, ok: false, error: message }),
    'pack-source-add': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-update': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-remove': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-enable': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames };
}

export { createSettingsHandlers };
