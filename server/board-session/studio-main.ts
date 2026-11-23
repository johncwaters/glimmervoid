import type { Session } from '../../session/sessions.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import { mainAgentStepOf } from '../core/studio-main-core.ts';

export function wakeStudioMain(sessions: Iterable<Session>, repoPath: string): string | null {
  const repoSessions = [...sessions].filter((session) => session.path === repoPath && branchParentIdOf(session.parent) === null);
  const step = mainAgentStepOf(repoSessions.map((session) => ({ id: session.id, state: session.state, isStudioMain: session.isStudioMain })));
  if (step.kind === 'create') return null;
  const main = repoSessions.find((session) => session.id === step.sessionId);
  if (step.kind === 'start') void main?.start();
  if (step.kind === 'restart') main?.restart();
  return step.sessionId;
}
