import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHELL_AGENT_ID } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { CLIENT_LOG_TEXT_MAX_CHARS } from '../../../shared/contracts/control-messages.ts';
import type { KeptWorkPath } from '../../../shared/contracts/control-messages.ts';
import { SESSION_NAME_PATTERN, SESSION_NAME_RULE_TEXT, TASK_TITLE_MAX_LENGTH, TaskTitle } from '../../../shared/contracts/session.ts';
import { sanitizeWorktreeName } from '../../../shared/paths.ts';
import { KILLABLE_STATES, STATES } from '../../../shared/states.ts';
import { errorMessage } from '../../../shared/text.ts';
import { DEFAULT_AGENT_ID, canRunUnderAccount, getAdapter, isKnownAgentId } from '../../../session/adapters/index.ts';
import { resolveNewSessionAccount } from '../../../session/core/agent-account-core.ts';
import { RESUME_ID_RE, resolveResumeTarget } from '../../../session/core/auto-resume.ts';
import { claudeProjectsDir, listRepoConversations } from '../../../session/core/conversation-history.ts';
import { planQuickSession } from '../../session/core/quick-session-core.ts';
import { manualPrLink } from '../../../session/core/session-pr-links-core.ts';
import { listDroppedRepoPaths, planWorkspaceMembers } from '../../../session/core/workspace-core.ts';
import type { Session } from '../../../session/sessions.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { ABORT_CONFIG_SAVE } from '../../config-store.ts';
import type { ProjectEntry } from '../../config-store.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { configuredIntegrationBranch } from '../../core/integration-branch-core.ts';
import { sanitizeOneLine } from '../../core/text-core.ts';
import { runGit } from '../../git/git-exec.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import { projectDirCandidates } from '../../usage/core/usage-scan-core.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT, isExistingDirectory, missingFolderError, replyTo, sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import { clock } from '../../../shared/clock.ts';

type AddSessionRefusal = { error: string };
type AddSessionRequest = ClientMessageOf<'add-session'>;
type RunSettings = Partial<ProjectEntry>;
type RemovalRefusal = { ok: false; error: string; canDiscardWork?: boolean; keptPaths?: KeptWorkPath[] };
type SessionRemoval = { ok: true } | RemovalRefusal;
type DiscardSession = (id: string) => Promise<SessionRemoval>;

const CONVERSATION_HISTORY_GIT_TIMEOUT_MS = 20000;

async function runGitForConversationHistory(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: CONVERSATION_HISTORY_GIT_TIMEOUT_MS, trim: false });
  if (!result.ok) throw result.error;
  return result.out;
}

interface SessionHandlerGroup extends ControlHandlerGroup {
  removeExitedSession(id: string): void;
  discardSession(id: string): Promise<SessionRemoval>;
}

function createSessionHandlers(context: ControlContext, deps: ControlHandlerDeps): SessionHandlerGroup {
  const { sessions, agentSessions, findSession, liveSessionNames, findConfiguredProject, createProjectSession } = context;
  const {
    markChildWorktreeDiscard = null,
    sessionWakes = null,
    config,
    configStore,
    broadcastControl,
    generateProjectId,
    applyConfigReload,
    getMyPrsStatus = null,
    conversationFs = fs,
    conversationGit = runGitForConversationHistory,
    conversationProjectsDir = claudeProjectsDir(process.env, os.homedir()),
    coderEnv = null,
    remoteRepoGit = null,
    secrets = null,
    agentAccounts = null,
  } = deps;

  async function handleSecretDecision(msg: ClientMessageOf<'secret-decision'>, ws: ControlSocket): Promise<void> {
    if (!secrets) return sendError(ws, 'Secret requests are unavailable on this host.', { id: msg.id });
    const refusal = await secrets.decide(msg);
    if (refusal) sendError(ws, refusal, { id: msg.id });
  }

  async function handleSecretRevoke(msg: ClientMessageOf<'secret-revoke'>, ws: ControlSocket): Promise<void> {
    if (!secrets) return sendError(ws, 'Secret approvals are unavailable on this host.');
    const refusal = await secrets.revoke(msg);
    if (refusal) sendError(ws, refusal);
  }

  function handleAddSession(request: AddSessionRequest, ws: ControlSocket): Promise<void> | undefined {
    return addSession(request, ws, {});
  }

  function addSession(request: AddSessionRequest, ws: ControlSocket, runSettings: RunSettings): Promise<void> | undefined {
    const msg = withShellDefaults(request);
    const refusal = shellAddSessionRefusal(msg) ?? addSessionRefusal(msg);
    if (refusal) {
      refuseAddSession(msg, ws, refusal);
      return undefined;
    }
    const environmentName = typeof msg.environment === 'string' ? msg.environment.trim() : '';
    if (environmentName) return createRemoteAddedSession(msg, ws, runSettings, environmentName);
    createAddedSession(msg, ws, runSettings);
    return undefined;
  }

  function handleQuickSession(msg: ClientMessageOf<'quick-session'>, ws: ControlSocket): Promise<void> | undefined {
    const source = findSession(msg);
    if (!source) {
      replyTo(ws, msg, 'add-session-result', { ok: false, error: 'The session to copy no longer exists.' });
      return undefined;
    }
    const plan = planQuickSession({
      live: source,
      project: config.projects.find((project) => project.id === source.id) ?? null,
      sessionNames: liveSessionNames(),
    });
    return addSession({ type: 'add-session', requestId: msg.requestId, ...plan.request }, ws, plan.runSettings);
  }

  function createAddedSession(msg: AddSessionRequest, ws: ControlSocket, runSettings: RunSettings, remote?: { id: string; environment: NonNullable<ProjectEntry['environment']> }): ProjectEntry | null {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();
    const repos = msg.repos;

    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';

    const sessionAccount = resolveNewSessionAccount({
      accounts: config.agentAccounts ?? [],
      defaults: config.agentAccountDefaults ?? {},
      requestedAccountId: msg.accountId,
      agentId: requestedAgent || DEFAULT_AGENT_ID,
      isRemote: remote !== undefined,
    });
    if ('refusal' in sessionAccount) {
      refuseAddSession(msg, ws, { error: sessionAccount.refusal });
      return null;
    }
    const skipPerms = typeof msg.dangerouslySkipPermissions === 'boolean'
      ? msg.dangerouslySkipPermissions
      : machineSkipsPermissionsByDefault(config);
    const created = createProjectSession({
      id: remote?.id,
      name,
      path: projectPath,
      repos,
      agent: requestedAgent && requestedAgent !== DEFAULT_AGENT_ID ? requestedAgent : undefined,
      dangerouslySkipPermissions: skipPerms,
      saneYolo: skipPerms && msg.saneYolo === true,
      requireExistingPath: !repos,
      environment: remote?.environment,
      accountId: sessionAccount.accountId,
      runSettings: runSettingsWithConversation(msg, runSettings),
    });
    if (!created.ok) {
      refuseAddSession(msg, ws, { error: created.error });
      return null;
    }
    sendFirstPrompt(created.project.id, msg.prompt);
    if (msg.requestId) replyTo(ws, msg, 'add-session-result', { ok: true, error: null, sessionId: created.project.id });
    console.log(`[control] Added session via UI: ${created.project.name}${skipPerms ? ' (skip permissions)' : ' (permission prompts)'}${remote ? ` (Coder environment ${remote.environment.name})` : ''}`);
    return created.project;
  }

  function sendFirstPrompt(sessionId: string, prompt: string | undefined) {
    const firstPrompt = prompt?.trim();
    if (!firstPrompt) return;
    const session = sessions.get(sessionId);
    if (!session) {
      console.warn(`[control] First prompt dropped: session ${sessionId} is not loaded`);
      return;
    }
    const pasted = session.pasteTextWhenReady(firstPrompt, { submit: true });
    if (!pasted.ok) console.warn(`[control] First prompt not sent to "${session.name}" (${pasted.reason})`);
  }

  async function remoteRepoSource(projectPath: string): Promise<{ ok: true; repoRemoteUrl: string; baseBranch: string } | { ok: false; error: string }> {
    if (!remoteRepoGit) return { ok: false, error: 'Coder environments are unavailable on this host' };
    const repoRemoteUrl = await remoteRepoGit.originUrl({ projectPath });
    if (!repoRemoteUrl) return { ok: false, error: `${projectPath} has no origin remote, so a Coder workspace cannot clone it.` };
    const baseBranch = configuredIntegrationBranch(config) ?? await remoteRepoGit.detectDefaultBranch({ projectPath });
    if (!baseBranch) return { ok: false, error: `Could not find the default branch of ${projectPath} on origin.` };
    return { ok: true, repoRemoteUrl, baseBranch };
  }

  async function restartSession(msg: ClientMessageOf<'restart'> | ClientMessageOf<'force-restart'>, ws: ControlSocket, restart: (session: Session, options: { fresh: boolean; conversationId?: string }) => boolean): Promise<void> {
    const sess = findSession(msg);
    if (!sess) return;
    const fresh = msg.fresh === true;
    const conversationId = fresh ? null : requestedConversationId(msg.conversationId);
    if (!conversationId) {
      await renewAndRestart(sess, ws, () => { restart(sess, { fresh }); });
      return;
    }
    const refusal = resumeConversationRefusal(sess, conversationId);
    if (refusal) { sendError(ws, refusal, { id: sess.id }); return; }
    await renewAndRestart(sess, ws, () => {
      if (restart(sess, { fresh, conversationId })) persistResumeConversation(sess.id, conversationId);
    });
  }

  async function renewAndRestart(sess: Session, ws: ControlSocket, restart: () => void): Promise<void> {
    const project = config.projects.find((candidate) => candidate.id === sess.id);
    if (sess.state !== STATES.FAILED || !project?.environment || !coderEnv) {
      restart();
      return;
    }
    const source = await remoteRepoSource(project.path);
    if (!source.ok) {
      sendError(ws, source.error, { id: sess.id });
      return;
    }
    const renewal = await coderEnv.renew({
      projectId: project.id,
      repoRemoteUrl: source.repoRemoteUrl,
      baseBranch: source.baseBranch,
      liveCount: liveWorkspaceCount(project.environment.name, project.id),
    });
    if (!renewal.ok) {
      sendError(ws, renewal.reason, { id: sess.id });
      return;
    }
    restart();
  }

  function liveWorkspaceCount(environmentName: string, excludedProjectId?: string): number {
    return config.projects.filter((project) => {
      if (project.environment?.name !== environmentName) return false;
      if (project.id === excludedProjectId) return false;
      const session = sessions.get(project.id);
      return session !== undefined && session.state !== STATES.DORMANT;
    }).length;
  }

  function remoteAddSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    if (msg.repos) return { error: 'A workspace session cannot run in a Coder environment. Pick a single repository.' };
    if (msg.runInPlace === true) return { error: 'A session in a Coder environment always gets its own checkout, so it cannot run in this folder.' };
    if (typeof msg.accountId === 'string') return { error: 'A Coder workspace session cannot run under an added account yet. Pick this machine\'s login.' };
    return null;
  }

  async function createRemoteAddedSession(msg: AddSessionRequest, ws: ControlSocket, runSettings: RunSettings, environmentName: string): Promise<void> {
    const refusal = remoteAddSessionRefusal(msg);
    if (refusal) {
      refuseAddSession(msg, ws, refusal);
      return;
    }
    if (!coderEnv || !remoteRepoGit) {
      refuseAddSession(msg, ws, { error: 'Coder environments are unavailable on this host' });
      return;
    }
    const source = await remoteRepoSource(path.resolve((msg.path || '').trim()));
    if (!source.ok) {
      refuseAddSession(msg, ws, { error: source.error });
      return;
    }
    const { repoRemoteUrl, baseBranch } = source;
    const id = generateProjectId();
    const reserved = await coderEnv.reserve({
      projectId: id,
      environmentName,
      branch: `glimmervoid/session/${sanitizeWorktreeName(id)}`,
      liveCount: liveWorkspaceCount(environmentName),
    });
    if (!reserved.ok) {
      refuseAddSession(msg, ws, { error: reserved.reason });
      return;
    }
    const project = createAddedSession(msg, ws, runSettings, { id, environment: reserved.mapping });
    if (!project) return;
    void coderEnv.provision({ projectId: id, mapping: reserved.mapping, repoRemoteUrl, baseBranch }).then((provisioned) => {
      if (!provisioned.ok) console.warn(`[control] Coder provision failed for ${project.name}: ${provisioned.reason}`);
    });
  }

  function isShellRequest(msg: AddSessionRequest): boolean {
    return typeof msg.agent === 'string' && msg.agent.trim() === SHELL_AGENT_ID;
  }

  function withShellDefaults(msg: AddSessionRequest): AddSessionRequest {
    if (!isShellRequest(msg)) return msg;
    return { ...msg, path: (msg.path || '').trim() || os.homedir() };
  }

  function shellAddSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    if (!isShellRequest(msg)) return null;
    if (typeof msg.environment === 'string' && msg.environment.trim()) return { error: 'A shell session runs on this machine, so it cannot run in a Coder environment.' };
    if (msg.repos) return { error: 'A shell session runs in one folder, so it cannot span a workspace.' };
    return null;
  }

  function runSettingsWithConversation(msg: AddSessionRequest, runSettings: RunSettings): RunSettings {
    const resumeSessionId = requestedConversationId(msg.resumeSessionId);
    if (!resumeSessionId) return runSettings;
    return { ...runSettings, resumeSessionId };
  }

  function addSessionResumeRefusal(msg: AddSessionRequest, agentId: string): AddSessionRefusal | null {
    const resumeSessionId = requestedConversationId(msg.resumeSessionId);
    if (!resumeSessionId) return null;
    const adapter = getAdapter(agentId);
    if (!adapter?.capabilities.resume) return { error: `A ${adapter?.label ?? agentId} session cannot resume a conversation` };
    if (!RESUME_ID_RE.test(resumeSessionId)) return { error: 'Invalid conversation id' };
    const isCoderSession = typeof msg.environment === 'string' && msg.environment.trim() !== '';
    if (adapter.usageVendor !== 'claude' || isCoderSession) return null;
    const projectsDirs = projectDirCandidates(process.env, [], os.homedir());
    const sessionFolders = msg.repos ?? [(msg.path || '').trim()];
    const resumeTarget = resolveResumeTarget(
      { resumeSessionId, transcriptPath: null, projectsDirs, cwds: sessionFolders.filter(Boolean) },
      { existsSync: fs.existsSync, readdirSync: fs.readdirSync },
    );
    if (resumeTarget.resumeSessionId) return null;
    return { error: `No conversation ${resumeSessionId} was found under ${projectsDirs.join(', ')}` };
  }

  function addSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();
    if (!name || (!projectPath && !msg.repos)) return { error: 'Name and path are required' };
    if (!SESSION_NAME_PATTERN.test(name)) return { error: SESSION_NAME_RULE_TEXT };
    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';
    if (requestedAgent && !isKnownAgentId(requestedAgent)) return { error: `Unknown agent "${requestedAgent}"` };
    const resumeRefusal = addSessionResumeRefusal(msg, requestedAgent || DEFAULT_AGENT_ID);
    if (resumeRefusal) return resumeRefusal;
    const missingRepo = msg.repos?.find((repoPath) => !isExistingDirectory(repoPath));
    if (missingRepo) return { error: missingFolderError(missingRepo) };
    if (msg.repos) return null;
    if (!isExistingDirectory(projectPath)) return { error: missingFolderError(projectPath) };
    return null;
  }

  function refuseAddSession(msg: AddSessionRequest, ws: ControlSocket, refusal: AddSessionRefusal): void {
    console.warn(`[control] add-session refused: name=${sanitizeOneLine(msg.name, CLIENT_LOG_TEXT_MAX_CHARS)} path=${sanitizeOneLine(msg.path, CLIENT_LOG_TEXT_MAX_CHARS)}: ${refusal.error}`);
    if (msg.requestId) {
      replyTo(ws, msg, 'add-session-result', { ok: false, ...refusal });
      return;
    }
    sendError(ws, refusal.error);
  }

  function handleStartSession(msg: ClientMessageOf<'start-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) return;
    if (agentSessions.get(sess.id) === sess) {
      sendError(ws, 'This session is started by the agent that spawned it', { id: sess.id });
      return;
    }
    if (sess.state !== STATES.DORMANT) return;
    sess.start();
  }

  const lastRemovalRefusalBySessionId = new Map<string, string>();

  function refuseRemoval(error: string, keptPaths?: KeptWorkPath[]): RemovalRefusal {
    return keptPaths ? { ok: false, error, canDiscardWork: true, keptPaths } : { ok: false, error, canDiscardWork: true };
  }

  function keptWorkRefusal(sess: Session, firstKept: KeptWorkPath, otherKeptCount: number, keptPaths: KeptWorkPath[]): RemovalRefusal {
    const more = otherKeptCount > 0 ? ` and ${otherKeptCount} more` : '';
    return refuseRemoval(`"${sess.name}" has work not saved in ${firstKept.path} (${firstKept.reason})${more}. Removing it deletes that work.`, keptPaths);
  }

  async function findLocalRemovalRefusal(sess: Session, confirmedKeptPaths: ReadonlySet<string>): Promise<RemovalRefusal | null> {
    const keptPaths = await sess.hasWorkspaceMembers() ? await sess.findWorkspaceKeptWork() : [];
    if (!sess.isWorkspace && await sess.hasUnmergedWork()) {
      const checkoutWork = keptPaths.length > 0 ? ` Its checkouts also hold work not saved: ${keptPaths.map((kept) => kept.path).join(', ')}.` : '';
      return refuseRemoval(`"${sess.name}" has uncommitted changes or commits not merged into its base branch. Removing it deletes them.${checkoutWork}`, keptPaths.length > 0 ? keptPaths : undefined);
    }
    const [firstUnconfirmedKept, ...otherUnconfirmedKept] = keptPaths.filter((kept) => !confirmedKeptPaths.has(kept.path));
    if (firstUnconfirmedKept) return keptWorkRefusal(sess, firstUnconfirmedKept, otherUnconfirmedKept.length, keptPaths);
    if (sess.state === STATES.RUNNING) return refuseRemoval(`"${sess.name}" is working. Removing it stops the agent mid-task.`);
    if (sess.state === STATES.WAITING) return refuseRemoval(`"${sess.name}" is waiting for your input. Removing it stops the agent mid-task.`);
    return null;
  }

  async function removeSession(msg: ClientMessageOf<'remove-session'>): Promise<SessionRemoval> {
    const sess = findSession(msg);
    if (!sess) return { ok: false, error: 'Session not found' };
    const isDiscardingWork = msg.discardWork === true;
    const isDiscardingWorkspaceWork = isDiscardingWork && await sess.hasWorkspaceMembers();
    if (isDiscardingWorkspaceWork) sess.killSession();

    const refusal = await findLocalRemovalRefusal(sess, new Set(isDiscardingWorkspaceWork ? msg.confirmedKeptPaths ?? [] : []));
    const isRefusalConfirmed = isDiscardingWork && refusal?.error === lastRemovalRefusalBySessionId.get(sess.id);
    if (refusal && !isRefusalConfirmed) {
      lastRemovalRefusalBySessionId.set(sess.id, refusal.error);
      return refusal;
    }
    if (msg.checkOnly === true) return { ok: true };

    if (agentSessions.get(sess.id) === sess) {
      if (isDiscardingWork) markChildWorktreeDiscard?.(sess.id);
      if (isDiscardingWorkspaceWork) sess.confirmWorkspaceWorkDiscard();
      lastRemovalRefusalBySessionId.delete(sess.id);
      sess.destroy();
      console.log(`[control] Removed spawned session via UI: ${sess.name}`);
      return { ok: true };
    }

    const hasRemoteWorkspace = config.projects.some((project) => project.id === sess.id && project.environment);
    if (hasRemoteWorkspace && coderEnv) {
      sess.killSession();
      const settlement = await coderEnv.settleRemoval({ projectId: sess.id, discardRemoteWork: isDiscardingWork });
      if (!settlement.ok && settlement.canDiscardRemoteWork) return refuseRemoval(`${settlement.reason}. Removing "${sess.name}" deletes its Coder workspace and that work with it.`);
      if (!settlement.ok) return { ok: false, error: settlement.reason, canDiscardWork: false };
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.id !== sess.id);
    });
    if (!freshConfig) return { ok: false, error: `Could not save the removal of session "${sess.name}"` };
    if (isDiscardingWorkspaceWork) sess.confirmWorkspaceWorkDiscard();
    lastRemovalRefusalBySessionId.delete(sess.id);
    applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${sess.name}`);
    return { ok: true };
  }

  async function handleRemoveSession(msg: ClientMessageOf<'remove-session'>, ws: ControlSocket): Promise<void> {
    const removal = await removeSession(msg);
    if (msg.requestId) {
      replyTo(ws, msg, 'remove-session-result', removal.ok ? { ok: true, error: null } : removal);
      return;
    }
    if (!removal.ok) sendError(ws, removal.error);
  }

  async function discardSession(id: string): Promise<SessionRemoval> {
    const removal = await removeSession({ type: 'remove-session', id, discardWork: true });
    if (removal.ok || !removal.canDiscardWork) return removal;
    return removeSession({ type: 'remove-session', id, discardWork: true, confirmedKeptPaths: removal.keptPaths?.map((kept) => kept.path) });
  }

  function removeExitedSession(id: string): void {
    void removeSession({ type: 'remove-session', id }).then((removal) => {
      if (removal.ok) return;
      const sess = sessions.get(id);
      if (removal.canDiscardWork && sess) {
        broadcastControl({ type: 'session-close-confirm', id, mergeStatus: sess.mergeStatus });
        return;
      }
      console.warn(`[control] Could not remove session ${id} after its agent quit: ${removal.error}`);
    });
  }

  function handleRenameSession(msg: ClientMessageOf<'rename-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    const newName = (msg.newName || '').trim();

    if (!sess || !newName) {
      sendError(ws, 'That session no longer exists or the new name was empty. Reload the page, then rename again with a name.');
      return;
    }

    if (sess.ephemeral) { sendError(ws, 'Glimmervoid manages this session itself, so it cannot be renamed.', { id: sess.id }); return; }

    if (!SESSION_NAME_PATTERN.test(newName)) {
      sendError(ws, `${SESSION_NAME_RULE_TEXT}. Pick another name.`, { id: sess.id });
      return;
    }

    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        sendError(ws, `A session named "${newName}" already exists. Pick another name.`, { id: sess.id });
        return;
      }
    }

    if (sess.name === newName) return;

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (project) project.name = newName;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleGetWorkspaceRepos(msg: ClientMessageOf<'get-workspace-repos'>, ws: ControlSocket): void {
    const project = findConfiguredProject(msg.id);
    if (!project?.repos) {
      replyTo(ws, msg, 'workspace-repos', { id: msg.id, ok: false, repos: [], error: 'This session is not a workspace' });
      return;
    }
    replyTo(ws, msg, 'workspace-repos', { id: msg.id, ok: true, repos: project.repos, error: null });
  }

  async function findDroppedMemberWithUncommittedWork(workspaceFolder: string, droppedRepoPaths: string[]): Promise<string | null> {
    for (const repoPath of droppedRepoPaths) {
      const memberName = path.basename(path.resolve(repoPath));
      const memberDir = path.join(workspaceFolder, memberName);
      const memberExists = await fs.promises.stat(memberDir).then(() => true, () => false);
      if (!memberExists) continue;
      const memberStatus = await runGit(['--no-optional-locks', 'status', '--porcelain'], { cwd: memberDir });
      if (!memberStatus.ok) throw memberStatus.error;
      if (memberStatus.out !== '') return memberName;
    }
    return null;
  }

  async function handleSetWorkspaceRepos(msg: ClientMessageOf<'set-workspace-repos'>, ws: ControlSocket): Promise<void> {
    const reply = (error: string | null) => replyTo(ws, msg, 'set-workspace-repos-result', { id: msg.id, ok: error === null, error });
    const project = findConfiguredProject(msg.id);
    const session = sessions.get(msg.id);
    if (!project?.repos || !session) {
      reply('This session is not a workspace');
      return;
    }
    const missingRepo = msg.repos.find((repoPath) => !isExistingDirectory(repoPath));
    if (missingRepo) {
      reply(missingFolderError(missingRepo));
      return;
    }
    const planned = planWorkspaceMembers({ folder: project.path, sessionId: project.id, repoPaths: msg.repos });
    if (!planned.ok) {
      reply(planned.error);
      return;
    }
    const nextRepos = planned.plan.members.map((member) => member.repoPath);
    try {
      const dirtyMemberName = await findDroppedMemberWithUncommittedWork(project.path, listDroppedRepoPaths(project.repos, nextRepos));
      if (dirtyMemberName) {
        reply(`${dirtyMemberName} has uncommitted changes. Commit or discard them before removing it from the workspace.`);
        return;
      }
    } catch (error) {
      reply(`Could not check the workspace for uncommitted changes: ${errorMessage(error)}`);
      return;
    }
    const freshConfig = configStore.save((cfg) => {
      const configured = cfg.projects.find((entry) => entry.id === project.id);
      if (!configured) return ABORT_CONFIG_SAVE;
      configured.repos = nextRepos;
      return undefined;
    });
    if (!freshConfig) {
      reply(`Could not save session "${project.name}"`);
      return;
    }
    applyConfigReload(freshConfig);
    console.log(`[control] Workspace repositories updated via UI: ${project.name} (${nextRepos.length} repos)`);
    reply(null);
  }

  async function switchSessionAccount(msg: ClientMessageOf<'switch-session-account'>): Promise<{ error: string; needsSignIn?: boolean } | null> {
    const session = findSession(msg);
    const project = config.projects.find((entry) => entry.id === session?.id);
    if (!session || !project) return { error: SESSION_GONE_TEXT };
    if (session.ephemeral) return { error: 'This session cannot switch accounts.' };
    const plan = resolveNewSessionAccount({ accounts: config.agentAccounts ?? [], defaults: {}, requestedAccountId: msg.accountId, agentId: session.agentId, isRemote: Boolean(project.environment) });
    if ('refusal' in plan) return { error: plan.refusal };
    if (plan.accountId === (project.accountId ?? null)) return null;
    const adapter = getAdapter(session.agentId);
    if (plan.accountId !== null && !canRunUnderAccount(adapter)) return { error: `${adapter?.label ?? session.agentId} sessions cannot run under an added account yet.` };
    const signInRefusal = await agentAccounts?.signInRefusal(session.agentId, plan.accountId) ?? null;
    if (signInRefusal) return signInRefusal;
    if (sessions.get(session.id) !== session) return { error: SESSION_GONE_TEXT };
    let savedRefusal: string | null = null;
    const freshConfig = configStore.save((cfg) => {
      const configured = cfg.projects.find((entry) => entry.id === session.id);
      if (!configured) return ABORT_CONFIG_SAVE;
      const savedPlan = resolveNewSessionAccount({ accounts: cfg.agentAccounts ?? [], defaults: {}, requestedAccountId: plan.accountId, agentId: session.agentId, isRemote: Boolean(configured.environment) });
      if ('refusal' in savedPlan) {
        savedRefusal = savedPlan.refusal;
        return ABORT_CONFIG_SAVE;
      }
      if (savedPlan.accountId === null) delete configured.accountId;
      if (savedPlan.accountId !== null) configured.accountId = savedPlan.accountId;
      return undefined;
    });
    if (savedRefusal !== null) return { error: savedRefusal };
    if (!freshConfig) return { error: 'Could not write config.json' };
    applyConfigReload(freshConfig);
    session.announceAccountChange();
    if (KILLABLE_STATES.includes(session.state)) session.forceRestart();
    return null;
  }

  async function handleSwitchSessionAccount(msg: ClientMessageOf<'switch-session-account'>, ws: ControlSocket): Promise<void> {
    const refusal = await switchSessionAccount(msg);
    replyTo(ws, msg, 'switch-session-account-result', { id: msg.id, ok: refusal === null, ...(refusal ?? {}) });
  }

  function handleSetSessionQuestionManager(msg: ClientMessageOf<'set-session-question-manager'>, ws: ControlSocket): void {
    const session = findSession(msg);
    if (!session) {
      sendError(ws, SESSION_GONE_TEXT);
      return;
    }
    if (session.isQuestionManagerOn === null) {
      sendError(ws, 'The question manager cannot answer for this session.', { id: session.id });
      return;
    }
    session.setQuestionManagerOn(msg.isOn);
  }

  function handleSetSessionTitle(msg: ClientMessageOf<'set-session-title'>, ws: ControlSocket): void {
    const session = findSession(msg);
    const parsedTitle = TaskTitle.safeParse(msg.title);
    if (!session) {
      sendError(ws, SESSION_GONE_TEXT);
      return;
    }
    if (!parsedTitle.success) {
      sendError(ws, `The task was not set: it must be at most ${TASK_TITLE_MAX_LENGTH} characters with no control characters. Shorten it and set it again.`, { id: session.id });
      return;
    }
    if (session.ephemeral) {
      sendError(ws, 'Glimmervoid manages this session itself, so it cannot have a custom task.', { id: session.id });
      return;
    }
    const freshConfig = configStore.save(config => {
      const project = config.projects.find(project => project.id === session.id);
      if (!project) return;
      if (!parsedTitle.data) {
        delete project.customTitle;
        return;
      }
      project.customTitle = parsedTitle.data;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleLinkSessionPr(msg: ClientMessageOf<'link-session-pr'>, ws: ControlSocket): void {
    const session = findSession(msg);
    if (!session) {
      sendError(ws, 'Session not found', { id: msg.id });
      return;
    }
    const link = manualPrLink(msg.key, (typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null)?.prs ?? [], clock.nowMs());
    if (!link) {
      sendError(ws, `Not a GitHub pull request: ${msg.key}`, { id: msg.id });
      return;
    }
    session.linkPrManually(link);
  }

  function handleUnlinkSessionPr(msg: ClientMessageOf<'unlink-session-pr'>, ws: ControlSocket): void {
    const session = findSession(msg);
    if (!session) {
      sendError(ws, 'Session not found', { id: msg.id });
      return;
    }
    session.unlinkPr(msg.key);
  }

  async function handleCancelWake(msg: ClientMessageOf<'cancel-wake'>, ws: ControlSocket): Promise<void> {
    if (!sessionWakes) {
      sendError(ws, 'Wakes are not available on this host.', { id: msg.id });
      return;
    }
    const refusal = await sessionWakes.cancelForOperator(msg.id, msg.wake);
    if (refusal) sendError(ws, refusal, { id: msg.id });
  }

  function sessionWakeFrames() {
    return (sessionWakes?.pendingWakesBySession() ?? []).map(({ sessionId, wakes }) => ({ type: 'session-wakes', id: sessionId, wakes }));
  }

  async function handleListConversations(msg: ClientMessageOf<'list-conversations'>, ws: ControlSocket): Promise<void> {
    const sess = findSession(msg);
    if (!sess) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: msg.id || null, conversations: [], error: 'Session not found' }));
      return;
    }
    let conversations: unknown[] = [];
    try {
      conversations = await listRepoConversations({
        repoPath: sess.path,
        projectsDir: conversationProjectsDir,
        git: conversationGit,
        fsMod: conversationFs,
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: sess.id, conversations: [], error: errorMessage(err) }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'conversations',
      requestId: msg.requestId || null,
      id: sess.id,
      current: sess.resumeSessionId || null,
      conversations,
    }));
  }

  function resumeConversationRefusal(sess: Session, conversationId: string | null): string | null {
    if (sess.ephemeral) return 'This session cannot resume a conversation';
    if (conversationId && !RESUME_ID_RE.test(conversationId)) return 'Invalid conversation id';
    return null;
  }

  function persistResumeConversation(sessionId: string, conversationId: string | null): void {
    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sessionId);
      if (!project) return;
      if (!conversationId) {
        delete project.resumeSessionId;
        return;
      }
      project.resumeSessionId = conversationId;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function requestedConversationId(conversationId: unknown): string | null {
    const trimmed = typeof conversationId === 'string' ? conversationId.trim() : '';
    return trimmed || null;
  }

  function handleResumeConversation(msg: ClientMessageOf<'resume-conversation'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
    if (!sess) { sendError(ws, 'Session not found', { requestId }); return; }
    const conversationId = requestedConversationId(msg.conversationId);
    const refusal = resumeConversationRefusal(sess, conversationId);
    if (refusal) { sendError(ws, refusal, { requestId }); return; }

    persistResumeConversation(sess.id, conversationId);

    const live = sessions.get(sess.id) || sess;
    live.setResumeConversation(conversationId);

    ws.send(JSON.stringify({ type: 'resume-conversation-ack', requestId, id: live.id, resumeSessionId: conversationId, ok: true }));
    console.log(`[control] resume-conversation: id=${live.id} -> ${conversationId || '(cleared)'}`);
  }

  const handlers = {
    'add-session': handleAddSession,
    'quick-session': handleQuickSession,
    'list-conversations': handleListConversations,
    'resume-conversation': handleResumeConversation,
    'remove-session': handleRemoveSession,
    'rename-session': handleRenameSession,
    'get-workspace-repos': handleGetWorkspaceRepos,
    'set-workspace-repos': handleSetWorkspaceRepos,
    'set-session-title': handleSetSessionTitle,
    'set-session-question-manager': handleSetSessionQuestionManager,
    'switch-session-account': handleSwitchSessionAccount,
    'link-session-pr': handleLinkSessionPr,
    'unlink-session-pr': handleUnlinkSessionPr,
    'cancel-wake': handleCancelWake,
    'kill': (msg: ClientMessageOf<'kill'>) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session': handleStartSession,
    'restart': (msg: ClientMessageOf<'restart'>, ws: ControlSocket) => restartSession(msg, ws, (s, options) => s.restart(options)),
    'force-restart': (msg: ClientMessageOf<'force-restart'>, ws: ControlSocket) => restartSession(msg, ws, (s, options) => s.forceRestart(options)),
    'dismiss': (msg: ClientMessageOf<'dismiss'>) => {
      const session = findSession(msg);
      if (!session) return;
      if (msg.expectedState !== undefined && session.state !== msg.expectedState) return;
      session.dismiss();
    },
    'secret-decision': handleSecretDecision,
    'secret-revoke': handleSecretRevoke,
    'manager-seen': (msg: ClientMessageOf<'manager-seen'>) => {
      findSession(msg)?.markManagerDecisionsSeen(msg.throughSeq);
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'list-conversations': (msg, requestId, message) => ({ type: 'conversations', requestId, id: typeof msg?.id === 'string' ? msg.id : null, conversations: [], error: message }),
    'resume-conversation': (msg, requestId, message) => ({ type: 'resume-conversation-ack', requestId, id: typeof msg?.id === 'string' ? msg.id : undefined, ok: false, error: message }),
    'add-session': (_msg, requestId, message) => ({ type: 'add-session-result', requestId, ok: false, error: message }),
    'quick-session': (_msg, requestId, message) => ({ type: 'add-session-result', requestId, ok: false, error: message }),
    'remove-session': (_msg, requestId, message) => ({ type: 'remove-session-result', requestId, ok: false, error: message }),
    'switch-session-account': (msg, requestId, message) => ({ type: 'switch-session-account-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames: sessionWakeFrames, removeExitedSession, discardSession };
}

export { createSessionHandlers };
export type { DiscardSession };
