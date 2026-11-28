import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigUpdate, RUNTIME_CONFIG_SCALAR_KEYS, configIssueMessage } from '../../../shared/contracts/index.ts';
import { withRepoRootsAdded } from '../../../shared/repo-roots.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { isRecord } from '../../../shared/coerce.ts';
import { errorCode, errorMessage } from '../../../shared/text.ts';
import type { AgentHookGroup } from '../../../shared/contracts/hooks.ts';
import { PackApproveRequest } from '../../../shared/contracts/control/pack-messages.ts';
import { routeAgentNotes } from '../../../session/core/session-routes.ts';
import { REFOCUS_NOTE } from '../../../session/core/refocus-core.ts';
import { ATTACHED_BOARD_NOTE, BOARD_CONTEXT_NOTE } from '../../core/whiteboard-store-core.ts';
import { DEFAULT_AGENT_ID, describeAgentResolvability, getAdapter, listAgentIds, resetCommandCache } from '../../../session/adapters/index.ts';
import { buildAcpAgentTable, describeAcpAgentResolvability } from '../../../session/drivers/acp-agents.ts';
import type { ResolvedHookTool } from '../../../session/core/hook-tools.ts';
import type { InstalledHookFlags } from '../../../session/core/user-hooks-core.ts';
import { agentHookGroupOf, HOOK_EVENT_CATALOG, ID_RE as HOOK_ID_RE, MAX_TIMEOUT_SEC as HOOK_MAX_TIMEOUT_SEC, normalizeHook, rawStoredHooks, readStoredHooks, removeHook, upsertHook } from '../../../session/core/user-hooks-core.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { ABORT_CONFIG_SAVE } from '../../config-store.ts';
import type { ProjectEntry } from '../../config-store.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { mergeSettingsBlock, settingsBlockSpecFor, validateSettingsBlock } from '../../core/settings-block-core.ts';
import { mergeWorkflowsUpdateOverStored } from '../../core/workflows-core.ts';
import { listFolders, suggestRepoRoots } from '../../repo-root-suggestions.ts';
import { resolveFromHome } from '../../core/repo-root-suggestions-core.ts';
import { createCloneJobs, listGithubRepos, removeInterruptedCloneFolders, resolveGithubCredential } from '../../repository-clone.ts';
import { cloneRootOf, defaultRepoRootOf, githubOwnerOfSource, parseRepositorySource } from '../../core/repository-source-core.ts';
import type { GithubCredential, RootCheckouts } from '../../core/repository-source-core.ts';
import { NO_GITHUB_APP_GRANTS } from '../../lanes/core/lane-permissions-core.ts';
import { resolvePackageBin, scriptLaunch } from '../../runtime-paths.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import { buildSettingsPayload as buildSettingsPayloadFrom } from '../../settings-payload.ts';
import { expandTilde } from '../../usage/core/usage-scan-core.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import { clock } from '../../../shared/clock.ts';
import { runCommandSafely } from '../../child-process-safe.ts';

type ScannedProject = { name: string; path: string; isGit?: boolean; hasCommits?: boolean; lastActivityMs?: number };

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

function isCheckoutWithoutChildCheckouts(root: string): boolean {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const childFolders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  return !childFolders.some((entry) => fs.existsSync(path.join(root, entry.name, '.git')));
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
      if (isCheckoutWithoutChildCheckouts(root)) {
        const rootRealPath = realPathOrSelf(root);
        results.push({ root, projects: seenRealPaths.has(rootRealPath) ? [] : [{ name: path.basename(root), path: root }] });
        seenRealPaths.add(rootRealPath);
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

const HEAD_REF_LINE = /^ref:\s*(\S+)/;

async function hasLooseOrPackedHeadRef(gitDirectory: string): Promise<boolean> {
  const headRef = HEAD_REF_LINE.exec(await fs.promises.readFile(path.join(gitDirectory, 'HEAD'), 'utf8'))?.[1];
  if (!headRef) return true;
  const commonDirectoryText = await fs.promises.readFile(path.join(gitDirectory, 'commondir'), 'utf8').catch(() => '');
  const commonDirectory = commonDirectoryText.trim() ? path.resolve(gitDirectory, commonDirectoryText.trim()) : gitDirectory;
  if (await fs.promises.stat(path.join(commonDirectory, headRef)).then(() => true, () => false)) return true;
  const packedRefs = await fs.promises.readFile(path.join(commonDirectory, 'packed-refs'), 'utf8').catch(() => '');
  return packedRefs.split('\n').some((line) => line.endsWith(` ${headRef}`));
}

const HEAD_CHECK_TIMEOUT_MS = 5000;
const HEAD_CHECK_OUTPUT_LIMIT_BYTES = 4096;

async function hasHeadCommit(projectPath: string, gitDirectory: string): Promise<boolean> {
  if (await hasLooseOrPackedHeadRef(gitDirectory).catch(() => false)) return true;
  const headCheck = await runCommandSafely('git', ['-C', projectPath, 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: projectPath, env: process.env, timeoutMs: HEAD_CHECK_TIMEOUT_MS, maxBufferBytes: HEAD_CHECK_OUTPUT_LIMIT_BYTES });
  return headCheck.ok;
}

async function projectGitFacts(projectPath: string): Promise<{ isGit: boolean; hasCommits?: boolean; lastActivityMs?: number }> {
  try {
    const gitDirectory = await gitDirectoryOf(projectPath);
    if (!gitDirectory) return { isGit: false };
    const [hasCommits, gitDirectoryStat] = await Promise.all([hasHeadCommit(projectPath, gitDirectory), fs.promises.stat(gitDirectory)]);
    return { isGit: true, hasCommits, lastActivityMs: gitDirectoryStat.mtimeMs };
  } catch {
    return { isGit: false };
  }
}

async function withProjectActivity(directories: { root: string; projects: ScannedProject[] }[]) {
  return Promise.all(directories.map(async ({ root, projects }) => ({
    root,
    projects: await Promise.all(projects.map(async (project) => ({ ...project, ...await projectGitFacts(project.path) }))),
  })));
}

async function rootCheckoutsOf(roots: readonly string[]): Promise<RootCheckouts[]> {
  const scanned = await withProjectActivity(scanRepoRoots([...roots]));
  return Promise.all(scanned.map(async ({ root, projects }) => ({
    root,
    isCheckoutItself: await fs.promises.stat(path.join(root, '.git')).then(() => true, () => false),
    hasGitCheckout: projects.some((project) => project.isGit && project.path !== root),
  })));
}

function createDefaultRepoRoot(): void {
  const defaultRoot = defaultRepoRootOf(os.homedir());
  try {
    fs.mkdirSync(defaultRoot, { recursive: true });
  } catch (err) {
    console.warn(`[settings] Could not create the default repository folder ${defaultRoot}: ${errorCode(err) || errorMessage(err)}`);
  }
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
type MutatingAgentAccountMessageType = 'agent-account-add' | 'agent-account-sign-in' | 'agent-account-cancel' | 'agent-account-code' | 'agent-account-remove' | 'agent-account-rename' | 'agent-account-default' | 'agent-lane-account';
type PackSourceMessageType = 'pack-source-add' | 'pack-source-update' | 'pack-source-remove' | 'pack-folder-remove' | 'pack-source-enable';

const CLONE_JOBS_BROADCAST_GAP_MS = 250;

function createSettingsHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { replyApplied } = context;
  const {
    config,
    configStore,
    broadcastControl,
    applyConfigReload,
    applySettingsReload,
    telegramDelivery = null,
    agentAccounts = null,
    remoteSetup = null,
    githubAppGrants = NO_GITHUB_APP_GRANTS,
    githubUserCredential = async () => null,
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
    const reply = (payload: Record<string, unknown>) => replyApplied(ws, msg, 'start-remote-setup-result', { ok: false, error: null, ...payload });
    if (!remoteSetup) { reply({ error: 'Remote host setup is not available on this server.' }); return; }
    const { label, resolvable } = describeAgentResolvability(msg.agent);
    if (!resolvable) { reply({ error: `Install ${label} on this machine before starting the remote setup session.` }); return; }
    const outcome = await remoteSetup.start(msg.agent);
    if (!outcome.ok) { reply({ error: outcome.error }); return; }
    reply({ ok: true, sessionId: outcome.sessionId, sessionName: outcome.sessionName });
  }

  async function handleGetAgentAccounts(msg: ClientMessageOf<'get-agent-accounts'>, ws: ControlSocket): Promise<void> {
    if (!agentAccounts) {
      replyTo(ws, msg, 'agent-accounts', { accounts: [], error: AGENT_ACCOUNTS_UNAVAILABLE });
      return;
    }
    await agentAccounts.refresh();
    replyTo(ws, msg, 'agent-accounts', { accounts: agentAccounts.list() });
  }

  async function answerMutatingAgentAccounts(msg: ClientMessageOf<MutatingAgentAccountMessageType>, ws: ControlSocket, act: (accounts: NonNullable<typeof agentAccounts>) => Promise<{ ok: true; accountId?: string } | { ok: false; error: string }>): Promise<void> {
    if (!agentAccounts) {
      replyApplied(ws, msg, 'agent-accounts', { accounts: [], error: AGENT_ACCOUNTS_UNAVAILABLE });
      return;
    }
    const outcome = await act(agentAccounts);
    if (!outcome.ok) {
      replyApplied(ws, msg, 'agent-accounts', { accounts: agentAccounts.list(), error: outcome.error });
      return;
    }
    replyApplied(ws, msg, 'agent-accounts', { accounts: agentAccounts.list(), accountId: outcome.accountId });
  }

  function handleUpdateSettings(msg: ClientMessageOf<'update-settings'>, ws: ControlSocket): void {
    const parsedSettings = ConfigUpdate.safeParse(msg.settings || {});
    if (!parsedSettings.success) {
      replyApplied(ws, msg, 'settings-error', { message: configIssueMessage(parsedSettings.error) });
      return;
    }
    const s = parsedSettings.data;

    const incoming: Record<string, unknown> = s;

    const resolvedRoots = s.repoRoots ? resolvedRepoRoots(s.repoRoots) : null;
    if (resolvedRoots && 'error' in resolvedRoots) {
      replyApplied(ws, msg, 'settings-error', { message: resolvedRoots.error });
      return;
    }
    if (resolvedRoots) s.repoRoots = resolvedRoots.roots;

    const blocks = incomingSettingsBlocks(incoming);
    const blockError = incomingSettingsBlocksError(blocks);
    if (blockError) {
      replyApplied(ws, msg, 'settings-error', { message: blockError });
      return;
    }

    const workflowsUpdate = s.workflows;
    const workflowsMerge = workflowsUpdate ? mergeWorkflowsUpdateOverStored(config.workflows, workflowsUpdate) : null;
    if (workflowsMerge && !workflowsMerge.ok) {
      replyApplied(ws, msg, 'settings-error', { message: workflowsMerge.error });
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
      replyApplied(ws, msg, 'settings-error', { message: inSaveWorkflowsFailure.error });
      return;
    }
    if (!freshConfig) {
      replyApplied(ws, msg, 'settings-error', { message: settingsNotSavedText(configStore.lastSaveFailureReason()) });
      return;
    }
    applySettingsReload(freshConfig);
    if (machineSkipsPermissionsByDefault(freshConfig) !== skippedPermissionsByDefault) applyConfigReload(freshConfig);
    const updatedSettings = buildSettingsPayload();

    broadcastControl({
      type: 'settings-updated',
      settings: updatedSettings,
    });
    replyApplied(ws, msg, 'settings-updated', { settings: updatedSettings });
    console.log('[control] Settings updated via UI');
  }

  function handleListAgents(msg: ClientMessageOf<'list-agents'>, ws: ControlSocket): void {
    if (msg.rescan) resetCommandCache();
    const hiddenAgentIds = new Set(config.hiddenAgents ?? []);
    if (msg.driver === 'acp') {
      const table = buildAcpAgentTable(config.acpAgents ?? []);
      const agents = table.ok
        ? table.entries.map((entry) => {
          const { label, resolvable } = describeAcpAgentResolvability(entry);
          return { id: entry.id, label, resolvable, hidden: hiddenAgentIds.has(entry.id) };
        })
        : [];
      ws.send(JSON.stringify({
        type: 'agents-listed',
        requestId: msg.requestId || null,
        agents,
      }));
      return;
    }
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

  function resolvedRepoRoots(roots: readonly string[]): { roots: string[] } | { error: string } {
    const resolvedRoots = roots.map((root) => resolveFromHome(expandTilde(root, process.env, os.homedir()), os.homedir()));
    if (resolvedRoots.includes(defaultRepoRootOf(os.homedir()))) createDefaultRepoRoot();
    const invalidPaths = resolvedRoots.filter((root) => !isExistingDirectory(root));
    if (invalidPaths.length > 0) return { error: `Repository roots must be existing directories: ${invalidPaths.join(', ')}` };
    return { roots: resolvedRoots };
  }

  function saveAddedRepoRoots(addedRoots: readonly string[]): ReturnType<typeof configStore.save> {
    const freshConfig = configStore.save((cfg) => { cfg.repoRoots = withRepoRootsAdded(cfg.repoRoots ?? [], addedRoots) ?? cfg.repoRoots; });
    if (!freshConfig) return null;
    applySettingsReload(freshConfig);
    broadcastControl({ type: 'settings-updated', settings: buildSettingsPayload() });
    return freshConfig;
  }

  function handleAddRepoRoots(msg: ClientMessageOf<'add-repo-roots'>, ws: ControlSocket): void {
    const resolvedRoots = resolvedRepoRoots(msg.roots);
    if ('error' in resolvedRoots) {
      replyApplied(ws, msg, 'settings-error', { message: resolvedRoots.error });
      return;
    }
    if (!saveAddedRepoRoots(resolvedRoots.roots)) {
      replyApplied(ws, msg, 'settings-error', { message: settingsNotSavedText(configStore.lastSaveFailureReason()) });
      return;
    }
    replyApplied(ws, msg, 'settings-updated', { settings: buildSettingsPayload() });
  }

  function currentGithubCredential() {
    return resolveGithubCredential({ readToken: config.github?.readToken || null, userToken: async () => (await githubUserCredential())?.token ?? null, appTokens: githubAppGrants.tokens() });
  }

  async function handleListFolders(msg: ClientMessageOf<'list-folders'>, ws: ControlSocket): Promise<void> {
    const listed = await listFolders({ query: msg.query, homeDir: os.homedir() });
    if ('error' in listed) {
      replyTo(ws, msg, 'folders-listed', { folder: listed.folder, entries: [], error: listed.error });
      return;
    }
    replyTo(ws, msg, 'folders-listed', { folder: listed.folder, entries: listed.entries });
  }

  async function handleListGithubRepos(msg: ClientMessageOf<'list-github-repos'>, ws: ControlSocket): Promise<void> {
    const credential = await currentGithubCredential();
    if (credential.kind === 'none') {
      replyTo(ws, msg, 'github-repos-listed', { source: 'none', repos: [] });
      return;
    }
    const listed = await listGithubRepos(credential);
    if (!listed.ok) {
      replyTo(ws, msg, 'github-repos-listed', { source: credential.kind, repos: [], error: listed.error });
      return;
    }
    replyTo(ws, msg, 'github-repos-listed', { source: credential.kind, repos: listed.repos });
  }

  function cloneTokenOf(credential: GithubCredential, source: string): string | null {
    if (credential.kind === 'none') return null;
    if (credential.kind !== 'app') return credential.token;
    const parsedSource = parseRepositorySource(source);
    return parsedSource.ok ? githubAppGrants.tokenFor(githubOwnerOfSource(parsedSource)) : null;
  }

  const cloneJobs = createCloneJobs({
    cloneRootFor: async () => cloneRootOf(await rootCheckoutsOf(config.repoRoots ?? []), defaultRepoRootOf(os.homedir())),
    tokenFor: async (source) => cloneTokenOf(await currentGithubCredential(), source),
    onCloned: (cloneRoot) => {
      if (!(config.repoRoots ?? []).includes(cloneRoot)) saveAddedRepoRoots([cloneRoot]);
    },
  });
  void removeInterruptedCloneFolders([...new Set([...(config.repoRoots ?? []), defaultRepoRootOf(os.homedir())])]);
  let cloneJobsBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  cloneJobs.onChange(() => {
    if (cloneJobsBroadcastTimer !== null) return;
    cloneJobsBroadcastTimer = setTimeout(() => {
      cloneJobsBroadcastTimer = null;
      broadcastControl({ type: 'repository-clones', jobs: cloneJobs.list() });
    }, CLONE_JOBS_BROADCAST_GAP_MS);
    cloneJobsBroadcastTimer.unref();
  });

  function flushCloneJobsBroadcast(): void {
    if (cloneJobsBroadcastTimer === null) return;
    clearTimeout(cloneJobsBroadcastTimer);
    cloneJobsBroadcastTimer = null;
    broadcastControl({ type: 'repository-clones', jobs: cloneJobs.list() });
  }

  async function handleStartRepositoryClones(msg: ClientMessageOf<'start-repository-clones'>, ws: ControlSocket): Promise<void> {
    await cloneJobs.forgetMissingFolders();
    const refusal = cloneJobs.start(msg.sources);
    flushCloneJobsBroadcast();
    replyApplied(ws, msg, 'repository-clones', { jobs: cloneJobs.list(), ...(refusal === null ? {} : { error: refusal }) });
  }

  function handleCancelRepositoryClone(msg: ClientMessageOf<'cancel-repository-clone'>, ws: ControlSocket): void {
    cloneJobs.cancel(msg.source);
    flushCloneJobsBroadcast();
    replyApplied(ws, msg, 'repository-clones', { jobs: cloneJobs.list() });
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
    const reply = (payload: Record<string, unknown>) => replyApplied(ws, msg, 'save-hook-result', { ok: false, error: null, ...payload });
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
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    reply({ ok: true, hook: normalized.hook });
    console.log(`[control] save-hook: ${normalized.hook.name} (${normalized.hook.event})`);
  }

  function handleDeleteHook(msg: ClientMessageOf<'delete-hook'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyApplied(ws, msg, 'delete-hook-result', { ok: false, error: null, ...payload });
    const id = typeof msg.id === 'string' ? msg.id : '';

    if (!rawStoredHooks(config.hooks).some((hook) => hook && hook.id === id)) { reply({ error: 'Unknown hook' }); return; }
    const freshConfig = configStore.save((cfg) => {
      const remaining = removeHook(rawStoredHooks(cfg.hooks), id);

      if (remaining.length === 0) delete cfg.hooks;
      if (remaining.length > 0) cfg.hooks = remaining;
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    reply({ ok: true, id });
    console.log(`[control] delete-hook: ${id}`);
  }

  async function handlePackApprove(msg: ClientMessageOf<'pack-approve'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: { ok: boolean; error?: string }) => replyApplied(ws, msg, 'pack-approve-result', outcome);
    const parsed = PackApproveRequest.safeParse({ fingerprint: msg.fingerprint });
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    if (!deps.packs) { reply({ ok: false, error: 'Packs are not running' }); return; }
    reply(await deps.packs.approve(parsed.data.fingerprint));
  }

  function handlePackRequestDismiss(msg: ClientMessageOf<'pack-request-dismiss'>, ws: ControlSocket): void {
    if (!deps.packs) { replyTo(ws, msg, 'pack-request-dismiss-result', { ok: false, error: 'Packs are not running' }); return; }
    deps.packs.dismissRequest(msg.pack);
    replyTo(ws, msg, 'pack-request-dismiss-result', { ok: true });
  }

  async function handlePackDataGet(msg: ClientMessageOf<'pack-data-get'>, ws: ControlSocket): Promise<void> {
    if (!deps.packData) { replyTo(ws, msg, 'pack-data-result', { ok: false, error: 'Packs are not running' }); return; }
    replyTo(ws, msg, 'pack-data-result', await deps.packData.get(msg.pack));
  }

  async function handlePackDataSet(msg: ClientMessageOf<'pack-data-set'>, ws: ControlSocket): Promise<void> {
    if (!deps.packData) { replyApplied(ws, msg, 'pack-data-set-result', { ok: false, error: 'Packs are not running' }); return; }
    replyApplied(ws, msg, 'pack-data-set-result', await deps.packData.set(msg.pack, msg.key, msg.value));
  }

  async function handlePackSettingsGet(msg: ClientMessageOf<'pack-settings-get'>, ws: ControlSocket): Promise<void> {
    if (!deps.packSettings) { replyTo(ws, msg, 'pack-settings-result', { ok: false, error: 'Packs are not running' }); return; }
    replyTo(ws, msg, 'pack-settings-result', await deps.packSettings.view(msg.pack));
  }

  async function handlePackSettingsSave(msg: ClientMessageOf<'pack-settings-save'>, ws: ControlSocket): Promise<void> {
    if (!deps.packSettings) { replyTo(ws, msg, 'pack-settings-result', { ok: false, error: 'Packs are not running' }); return; }
    const saved = await deps.packSettings.save(msg.pack, msg.valuesByKey);
    if (!saved.ok) { replyTo(ws, msg, 'pack-settings-result', saved); return; }
    replyTo(ws, msg, 'pack-settings-result', await deps.packSettings.view(msg.pack));
  }

  async function replySourceChange(ws: ControlSocket, msg: ClientMessageOf<PackSourceMessageType>, change: (sources: NonNullable<typeof deps.packSources>) => Promise<{ ok: true; text: string } | { ok: false; error: string }>): Promise<void> {
    if (!deps.packSources) { replyApplied(ws, msg, 'pack-source-result', { ok: false, error: 'Packs are not running' }); return; }
    const outcome = await change(deps.packSources);
    replyApplied(ws, msg, 'pack-source-result', outcome.ok ? { ok: true, text: outcome.text, error: null } : { ok: false, error: outcome.error });
  }

  function connectFrames(): readonly unknown[] {
    void cloneJobs.forgetMissingFolders();
    const cloneJobsFrame = { type: 'repository-clones', jobs: cloneJobs.list() };
    return deps.packs ? [deps.packs.statusFrame(), cloneJobsFrame] : [cloneJobsFrame];
  }

  const handlers = {
    'get-settings': handleGetSettings,
    'start-remote-setup': handleStartRemoteSetup,
    'get-agent-accounts': handleGetAgentAccounts,
    'agent-account-add': (msg, ws) => answerMutatingAgentAccounts(msg, ws, (accounts) => accounts.add(msg.agent)),
    'agent-account-sign-in': (msg, ws) => answerMutatingAgentAccounts(msg, ws, (accounts) => accounts.signIn(msg.accountId)),
    'agent-account-cancel': (msg, ws) => answerMutatingAgentAccounts(msg, ws, (accounts) => accounts.cancel(msg.accountId)),
    'agent-account-code': (msg, ws) => answerMutatingAgentAccounts(msg, ws, async (accounts) => accounts.submitCode(msg.accountId, msg.code)),
    'agent-account-remove': (msg, ws) => answerMutatingAgentAccounts(msg, ws, (accounts) => accounts.remove(msg.accountId)),
    'agent-account-rename': (msg, ws) => answerMutatingAgentAccounts(msg, ws, async (accounts) => accounts.rename(msg.accountId, msg.label)),
    'agent-account-default': (msg, ws) => answerMutatingAgentAccounts(msg, ws, async (accounts) => accounts.setDefault(msg.agent, msg.accountId)),
    'agent-lane-account': (msg, ws) => answerMutatingAgentAccounts(msg, ws, async (accounts) => accounts.setLaneAccount(msg.lane, msg.followsDefault ? { followsDefault: true } : { followsDefault: false, accountId: msg.accountId })),
    'update-settings': handleUpdateSettings,
    'scan-repo-roots': handleScanRepoRoots,
    'add-repo-roots': handleAddRepoRoots,
    'list-agents': handleListAgents,
    'start-repository-clones': handleStartRepositoryClones,
    'cancel-repository-clone': handleCancelRepositoryClone,
    'list-github-repos': handleListGithubRepos,
    'list-folders': handleListFolders,
    'telegram-test': handleTelegramTest,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'delete-hook': handleDeleteHook,
    'pack-approve': handlePackApprove,
    'pack-request-dismiss': handlePackRequestDismiss,
    'pack-data-get': handlePackDataGet,
    'pack-settings-get': handlePackSettingsGet,
    'pack-settings-save': handlePackSettingsSave,
    'pack-data-set': handlePackDataSet,
    'pack-source-add': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.add(msg.url)),
    'pack-source-update': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.update(msg.slug)),
    'pack-source-remove': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.remove(msg.slug)),
    'pack-folder-remove': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.removeHandPlacedFolder(msg.dir)),
    'pack-source-enable': (msg, ws) => replySourceChange(ws, msg, (sources) => sources.setPackEnabled(msg.slug, msg.pack, msg.isEnabled)),
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'get-settings': (_msg, requestId, message) => ({ type: 'error', requestId, message }),
    'start-remote-setup': (_msg, requestId, message) => ({ type: 'start-remote-setup-result', requestId, ok: false, error: message }),
    'get-agent-accounts': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-add': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-sign-in': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-cancel': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-code': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-remove': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-rename': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-account-default': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'agent-lane-account': (_msg, requestId, message) => ({ type: 'agent-accounts', requestId, accounts: [], error: message }),
    'update-settings': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': (_msg, requestId, message) => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'add-repo-roots': (_msg, requestId, message) => ({ type: 'settings-error', requestId, message }),
    'list-agents': (_msg, requestId, message) => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'start-repository-clones': (_msg, requestId, message) => ({ type: 'repository-clones', requestId, error: message }),
    'cancel-repository-clone': (_msg, requestId, message) => ({ type: 'repository-clones', requestId, error: message }),
    'list-folders': (_msg, requestId, message) => ({ type: 'folders-listed', requestId, folder: '', entries: [], error: message }),
    'list-github-repos': (_msg, requestId, message) => ({ type: 'github-repos-listed', requestId, source: 'none', repos: [], error: message }),
    'telegram-test': (_msg, requestId, message) => ({ type: 'telegram-test-result', requestId, ok: false, error: message, telegramDelivery: null }),
    'request-hooks-report': (_msg, requestId, message) => ({ type: 'hooks-report', requestId, error: message }),
    'save-hook': (_msg, requestId, message) => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'delete-hook': (_msg, requestId, message) => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
    'pack-approve': (_msg, requestId, message) => ({ type: 'pack-approve-result', requestId, ok: false, error: message }),
    'pack-request-dismiss': (_msg, requestId, message) => ({ type: 'pack-request-dismiss-result', requestId, ok: false, error: message }),
    'pack-data-get': (_msg, requestId, message) => ({ type: 'pack-data-result', requestId, ok: false, error: message }),
    'pack-settings-get': (_msg, requestId, message) => ({ type: 'pack-settings-result', requestId, ok: false, error: message }),
    'pack-settings-save': (_msg, requestId, message) => ({ type: 'pack-settings-result', requestId, ok: false, error: message }),
    'pack-data-set': (_msg, requestId, message) => ({ type: 'pack-data-set-result', requestId, ok: false, error: message }),
    'pack-source-add': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-update': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-remove': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-folder-remove': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
    'pack-source-enable': (_msg, requestId, message) => ({ type: 'pack-source-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames };
}

export { createSettingsHandlers };
