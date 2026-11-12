import path from 'node:path';
import type { PackLauncher, PackSessions } from '../../../shared/contracts/pack.ts';
import { choiceSelection } from '../../../shared/agent-models-core.ts';
import { nextSuggestedName } from '../../../shared/session-naming.ts';
import { githubRepoSlugFromRemote } from '../../github/core/team-review-core.ts';
import type { LauncherProjectResolution } from './pack-core.ts';

type LauncherAddSession = {
  name: string;
  path: string;
  agent: string;
  prompt: string;
  setup?: NonNullable<ReturnType<typeof choiceSelection>>;
  dangerouslySkipPermissions: boolean;
  saneYolo: boolean;
};

export function isRepositoryProject(project: string): boolean {
  return !path.isAbsolute(project) && !path.win32.isAbsolute(project);
}

export function buildProjectSlugIndex(projects: readonly { path: string; originUrl: string | null }[]): ReadonlyMap<string, string> {
  const pathBySlug = new Map<string, string>();
  for (const project of projects) {
    const slug = project.originUrl ? githubRepoSlugFromRemote(project.originUrl) : null;
    if (slug && !pathBySlug.has(slug.toLowerCase())) pathBySlug.set(slug.toLowerCase(), project.path);
  }
  return pathBySlug;
}

export function resolveLauncherProject(project: string, slugIndex: ReadonlyMap<string, string>, existingFolders: ReadonlySet<string>): LauncherProjectResolution {
  if (!isRepositoryProject(project)) {
    return existingFolders.has(project) ? { ok: true, path: project } : { ok: false, reason: `the folder ${project} does not exist on this machine` };
  }
  const projectPath = slugIndex.get(project.toLowerCase());
  return projectPath ? { ok: true, path: projectPath } : { ok: false, reason: `no project here has ${project} as its origin; add a session in that repository once` };
}

export function launcherAddSession({ launcher, sessions, projectPath, sessionNames, operatorSaneYolo }: {
  launcher: PackLauncher;
  sessions: PackSessions | null;
  projectPath: string;
  sessionNames: readonly string[];
  operatorSaneYolo: boolean;
}): LauncherAddSession {
  const setup = choiceSelection(launcher.agent, { model: launcher.model ?? null, effort: launcher.effort ?? null });
  const skipsPermissions = sessions?.dangerouslySkipPermissions ?? false;
  return {
    name: nextSuggestedName(launcher.label, sessionNames), path: projectPath, agent: launcher.agent, prompt: launcher.prompt,
    ...(setup ? { setup } : {}),
    dangerouslySkipPermissions: skipsPermissions, saneYolo: skipsPermissions && (sessions?.saneYolo ?? operatorSaneYolo),
  };
}
