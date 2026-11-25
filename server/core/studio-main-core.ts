import { RESTARTABLE_STATES, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';

interface OrchestratorFact {
  id: string;
  state: SessionState;
}

type OrchestratorStep =
  | { kind: 'use'; sessionId: string }
  | { kind: 'start'; sessionId: string }
  | { kind: 'restart'; sessionId: string }
  | { kind: 'create' };

export const ORCHESTRATOR_NAME = 'Orchestrator';
export const STUDIO_HOME_FOLDER_NAME = 'studio-home';
export const ORCHESTRATOR_RUN_SETTINGS = Object.freeze({ isStudioMain: true, studioRole: 'orchestrator' } as const);

export function orchestratorStepOf(orchestrator: OrchestratorFact | null): OrchestratorStep {
  if (orchestrator === null) return { kind: 'create' };
  if (orchestrator.state === STATES.DORMANT) return { kind: 'start', sessionId: orchestrator.id };
  if (RESTARTABLE_STATES.includes(orchestrator.state)) return { kind: 'restart', sessionId: orchestrator.id };
  return { kind: 'use', sessionId: orchestrator.id };
}
