import type { ProjectConfig } from '../../../shared/contracts/config.ts';
import { nextSuggestedName } from '../../../shared/session-naming.ts';

interface LiveSessionSettings {
  name: string;
  path: string;
  workspaceRepos: readonly string[] | null;
  agentId: string;
  dangerouslySkipPermissions: boolean;
  isMarkedUnguarded: boolean;
  isGuardrailsReleased: boolean;
}

interface QuickSessionRequest {
  name: string;
  path: string;
  repos?: string[];
  agent?: string;
  dangerouslySkipPermissions?: boolean;
  unguarded: boolean;
  environment?: string;
}

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

function requestFromLiveSession(live: LiveSessionSettings, name: string): QuickSessionRequest {
  const repos = live.workspaceRepos && live.workspaceRepos.length >= 2 ? [...live.workspaceRepos] : undefined;
  return {
    name,
    path: repos?.[0] ?? live.path,
    repos,
    agent: live.agentId,
    dangerouslySkipPermissions: live.dangerouslySkipPermissions,
    unguarded: live.isMarkedUnguarded && !live.isGuardrailsReleased,
  };
}

function requestFromProject(project: ProjectConfig, live: LiveSessionSettings, name: string): QuickSessionRequest {
  return {
    name,
    path: project.repos?.[0] ?? project.path,
    repos: project.repos ? [...project.repos] : undefined,
    agent: project.agent,
    dangerouslySkipPermissions: project.dangerouslySkipPermissions,
    unguarded: project.unguarded === true && !live.isGuardrailsReleased,
    environment: project.environment?.name,
  };
}

export function planQuickSession({ live, project, sessionNames }: { live: LiveSessionSettings; project: ProjectConfig | null; sessionNames: readonly string[] }): QuickSessionPlan {
  const name = nextSuggestedName(autoNameBase(live.name), sessionNames);
  if (!project) return { request: requestFromLiveSession(live, name), runSettings: {} };
  return { request: requestFromProject(project, live, name), runSettings: runSettingsOf(project) };
}
