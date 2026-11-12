import path from 'node:path';
import type { PackLauncher, PackSessions } from '../../../shared/contracts/pack.ts';
import { choiceSelection } from '../../../shared/agent-models-core.ts';
import { nextSuggestedName } from '../../../shared/session-naming.ts';
import { remoteMatchesGithubRepo } from '../../github/core/team-review-core.ts';
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

export type ProjectOrigin = { path: string; originUrl: string | null };

export function resolveLauncherProject(project: string, projectOrigins: readonly ProjectOrigin[], existingFolders: ReadonlySet<string>): LauncherProjectResolution {
  if (!isRepositoryProject(project)) {
    return existingFolders.has(project) ? { ok: true, path: project } : { ok: false, reason: `the folder ${project} does not exist on this machine` };
  }
  const match = projectOrigins.find((candidate) => candidate.originUrl !== null && remoteMatchesGithubRepo(candidate.originUrl, project));
  return match ? { ok: true, path: match.path } : { ok: false, reason: `no project here has ${project} as its origin; add a session in that repository once` };
}

type ScheduledFireDecision = 'start' | 'skip-missed' | 'skip-running' | 'skip-cap' | 'skip-unresolved';

export function decideScheduledFire({ lateByMs, missedGraceMs, isProjectResolved, isPreviousRunLive, liveScheduledCount, maxScheduledSessions }: {
  lateByMs: number;
  missedGraceMs: number;
  isProjectResolved: boolean;
  isPreviousRunLive: boolean;
  liveScheduledCount: number;
  maxScheduledSessions: number;
}): ScheduledFireDecision {
  if (lateByMs > missedGraceMs) return 'skip-missed';
  if (!isProjectResolved) return 'skip-unresolved';
  if (isPreviousRunLive) return 'skip-running';
  if (liveScheduledCount >= maxScheduledSessions) return 'skip-cap';
  return 'start';
}

export function launcherAddSession({ launcher, sessions, projectPath, sessionNames, operatorSaneYolo }: {
  launcher: Pick<PackLauncher, 'label' | 'agent' | 'model' | 'effort' | 'prompt'>;
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
