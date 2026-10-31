import fs from 'node:fs';
import path from 'node:path';
import type { ClientMessage, OperatorActionOf, OperatorSurface } from '../../shared/contracts/index.ts';
import { nextSuggestedName } from '../../shared/session-naming.ts';
import type { Session } from '../../session/sessions.ts';
import { planWorkspace } from '../../session/core/workspace-core.ts';
import type { ControlSocket } from '../backend/backend-websockets.ts';
import type { ProjectEntry } from '../config-store.ts';
import type { ControlHandlerDeps } from '../control-handlers.ts';

const SESSION_GONE_TEXT = 'That session no longer exists. Reload the page to refresh the session list.';

type RequestWithId = Pick<ClientMessage, 'requestId'>;

interface SendErrorOptions {
  type?: string;
  requestId?: string | null;
  id?: string;
  scope?: string;
}

function sendError(ws: ControlSocket, message: string, { type = 'error', requestId, id, scope }: SendErrorOptions = {}): void {
  const payload = {
    type,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(id ? { id } : {}),
    ...(scope ? { scope } : {}),
    message,
  };
  ws.send(JSON.stringify(payload));
}

function replyTo(ws: ControlSocket, msg: RequestWithId, type: string, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type, requestId: msg.requestId || null, ...payload }));
}

function missingFolderError(folderPath: string): string {
  return `No folder at ${folderPath}. It may have been moved or renamed; pick it again or enter its current path.`;
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

interface CreateProjectSessionArgs {
  id?: string;
  name: string;
  path: string;
  repos?: string[];
  baseBranch?: string;
  agent?: ProjectEntry['agent'];
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  requireExistingPath?: boolean;
  environment?: ProjectEntry['environment'];
  runSettings?: Partial<ProjectEntry>;
}

type CreateProjectSessionResult = { ok: true; project: ProjectEntry } | { ok: false; error: string };

interface ControlContext {
  sessions: Map<string, Session>;
  agentSessions: Map<string, Session>;
  findSession(msg: { id?: string | null }): Session | null;
  liveSessionNames(): string[];
  findConfiguredProject(projectId: unknown): ProjectEntry | null;
  createProjectSession(args: CreateProjectSessionArgs): CreateProjectSessionResult;
  captureOperatorAction<Surface extends OperatorSurface>(surface: Surface, action: OperatorActionOf<Surface>): void;
}

function createControlContext(deps: ControlHandlerDeps): ControlContext {
  const { sessions, agentSessions = new Map<string, Session>(), config, configStore, generateProjectId, applyConfigReload } = deps;

  function findSession(msg: { id?: string | null }): Session | null {
    if (!msg.id) return null;
    return sessions.get(msg.id) ?? agentSessions.get(msg.id) ?? null;
  }

  function liveSessionNames(): string[] {
    return [...sessions.values(), ...agentSessions.values()].map((session) => session.name);
  }

  function findConfiguredProject(projectId: unknown): ProjectEntry | null {
    if (typeof projectId !== 'string') return null;
    return config.projects.find((project) => project.id === projectId) ?? null;
  }

  function createProjectSession({ id = generateProjectId(), name, path: projectPath, repos, baseBranch, agent, dangerouslySkipPermissions, saneYolo, requireExistingPath, environment, runSettings }: CreateProjectSessionArgs): CreateProjectSessionResult {
    const uniqueName = nextSuggestedName(name, liveSessionNames());
    let resolvedPath = path.resolve(projectPath);
    let workspaceRepos: string[] | undefined;
    if (repos) {
      const firstRepo = repos[0];
      if (!firstRepo) return { ok: false, error: 'A workspace needs at least two repositories' };
      const worktreeRoot = config.worktreeRoot || path.join(path.dirname(path.resolve(firstRepo)), '.glimmervoid-worktrees');
      const planned = planWorkspace({ worktreeRoot, sessionName: uniqueName, sessionId: id, repoPaths: repos });
      if (!planned.ok) return { ok: false, error: planned.error };
      resolvedPath = planned.plan.folder;
      workspaceRepos = planned.plan.members.map((member) => member.repoPath);
    }
    if (requireExistingPath && !fs.existsSync(resolvedPath)) return { ok: false, error: missingFolderError(projectPath) };
    const project: ProjectEntry = { ...runSettings, id, name: uniqueName, path: resolvedPath };
    if (workspaceRepos) project.repos = workspaceRepos;
    if (baseBranch) project.baseBranch = baseBranch;
    if (typeof dangerouslySkipPermissions === 'boolean') project.dangerouslySkipPermissions = dangerouslySkipPermissions;
    if (saneYolo) project.saneYolo = true;
    if (agent) project.agent = agent;
    if (environment) project.environment = environment;
    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (!freshConfig) return { ok: false, error: `Could not save session "${uniqueName}"` };
    applyConfigReload(freshConfig);
    return { ok: true, project };
  }

  function captureOperatorAction<Surface extends OperatorSurface>(surface: Surface, action: OperatorActionOf<Surface>): void {
    deps.telemetry?.capture?.('operator_action', { surface, action });
  }

  return { sessions, agentSessions, findSession, liveSessionNames, findConfiguredProject, createProjectSession, captureOperatorAction };
}

export { SESSION_GONE_TEXT, createControlContext, isExistingDirectory, missingFolderError, replyTo, sendError };
export type { ControlContext, RequestWithId };
