import path from 'node:path';
import type { ProjectConfig } from '../../../shared/contracts/config.ts';
import { SESSION_NAME_PATTERN } from '../../../shared/contracts/session.ts';
import { nextSuggestedName } from '../../../shared/session-naming.ts';

interface LiveSessionSettings {
  name: string;
  path: string;
  workspaceRepos: readonly string[] | null;
  agentId: string;
  dangerouslySkipPermissions: boolean;
}

interface QuickSessionRequest {
  name: string;
  path: string;
  repos?: string[];
  agent?: string;
  dangerouslySkipPermissions?: boolean;
  accountId?: string | null;
}

type UnnamedQuickSessionRequest = Omit<QuickSessionRequest, 'name'>;

interface QuickSessionPlan {
  request: QuickSessionRequest;
  runSettings: Partial<ProjectConfig>;
}

const COPIED_RUN_SETTINGS = ['baseBranch', 'codexBypassHookTrust', 'saneYolo'] as const;

const AUTO_NAME_SUFFIX = / \(\d+\)$/;

function autoNameBase(name: string): string {
  return name.replace(AUTO_NAME_SUFFIX, '');
}

function runSettingsOf(project: ProjectConfig): Partial<ProjectConfig> {
  const runSettings: Partial<ProjectConfig> = {};
  for (const field of COPIED_RUN_SETTINGS) {
    if (project[field] !== undefined) Object.assign(runSettings, { [field]: project[field] });
  }
  return runSettings;
}

function requestFromLiveSession(live: LiveSessionSettings): UnnamedQuickSessionRequest {
  const repos = live.workspaceRepos && live.workspaceRepos.length >= 2 ? [...live.workspaceRepos] : undefined;
  return {
    path: repos?.[0] ?? live.path,
    repos,
    agent: live.agentId,
    dangerouslySkipPermissions: live.dangerouslySkipPermissions,
  };
}

function requestFromProject(project: ProjectConfig): UnnamedQuickSessionRequest {
  return {
    path: project.repos?.[0] ?? project.path,
    repos: project.repos ? [...project.repos] : undefined,
    agent: project.agent,
    dangerouslySkipPermissions: project.dangerouslySkipPermissions,
    accountId: project.accountId ?? null,
  };
}

function folderSessionName(request: UnnamedQuickSessionRequest, sessionNames: readonly string[]): string | null {
  if (request.repos) return null;
  const folderName = nextSuggestedName(path.basename(request.path), sessionNames);
  return SESSION_NAME_PATTERN.test(folderName) ? folderName : null;
}

export function planQuickSession({ live, project, sessionNames }: { live: LiveSessionSettings; project: ProjectConfig | null; sessionNames: readonly string[] }): QuickSessionPlan {
  const unnamedRequest = project ? requestFromProject(project) : requestFromLiveSession(live);
  const name = folderSessionName(unnamedRequest, sessionNames) ?? nextSuggestedName(autoNameBase(live.name), sessionNames);
  return { request: { ...unnamedRequest, name }, runSettings: project ? runSettingsOf(project) : {} };
}
