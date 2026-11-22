import { RESTARTABLE_STATES, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';

export interface RepoSessionFact {
  id: string;
  state: SessionState;
  isStudioMain: boolean;
}

export type MainAgentStep =
  | { kind: 'use'; sessionId: string }
  | { kind: 'start'; sessionId: string }
  | { kind: 'restart'; sessionId: string }
  | { kind: 'create' };

export function mainAgentStepOf(repoSessions: readonly RepoSessionFact[]): MainAgentStep {
  const main = repoSessions.find((session) => session.isStudioMain);
  if (main === undefined) return { kind: 'create' };
  if (main.state === STATES.DORMANT) return { kind: 'start', sessionId: main.id };
  if (RESTARTABLE_STATES.includes(main.state)) return { kind: 'restart', sessionId: main.id };
  return { kind: 'use', sessionId: main.id };
}

export function mainAgentNameOf(repoPath: string): string {
  const trimmedPath = repoPath.replace(/[\\/]+$/, '');
  const repoLabel = trimmedPath.slice(Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\')) + 1) || trimmedPath;
  return `${repoLabel} main`;
}
