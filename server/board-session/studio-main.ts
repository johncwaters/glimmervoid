import fs from 'node:fs';
import path from 'node:path';

import type { Session } from '../../session/sessions.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import type { ProjectEntry } from '../config-store.ts';
import { ORCHESTRATOR_NAME, ORCHESTRATOR_RUN_SETTINGS, STUDIO_HOME_FOLDER_NAME, orchestratorStepOf } from '../core/studio-main-core.ts';

type OrchestratorLaunch = Pick<ProjectEntry, 'agent' | 'dangerouslySkipPermissions' | 'saneYolo'> & { accountId?: string | null };

type CreateOrchestratorSession = (args: OrchestratorLaunch & { name: string; path: string; requireExistingPath: boolean; runSettings: Partial<ProjectEntry> }) => { ok: true; project: ProjectEntry } | { ok: false; error: string };

type OrchestratorOutcome = { ok: true; orchestratorId: string; isCreated: boolean } | { ok: false; error: string };

export function studioHomeDir(): string {
  return path.join(glimmervoidHomeDir(), STUDIO_HOME_FOLDER_NAME);
}

export function wakeOrchestrator(sessions: Iterable<Session>): string | null {
  const orchestrator = [...sessions].find((session) => session.isStudioMain && !session._destroyed) ?? null;
  const step = orchestratorStepOf(orchestrator);
  if (step.kind === 'create') return null;
  if (step.kind === 'start') void orchestrator?.start();
  if (step.kind === 'restart') orchestrator?.restart();
  return step.sessionId;
}

export function ensureOrchestrator(sessions: Iterable<Session>, createSession: CreateOrchestratorSession, launch: OrchestratorLaunch): OrchestratorOutcome {
  const wokenId = wakeOrchestrator(sessions);
  if (wokenId !== null) return { ok: true, orchestratorId: wokenId, isCreated: false };
  fs.mkdirSync(studioHomeDir(), { recursive: true });
  const created = createSession({ ...launch, name: ORCHESTRATOR_NAME, path: studioHomeDir(), requireExistingPath: true, runSettings: { ...ORCHESTRATOR_RUN_SETTINGS } });
  if (!created.ok) return created;
  return { ok: true, orchestratorId: created.project.id, isCreated: true };
}
