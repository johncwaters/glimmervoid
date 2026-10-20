import type { SessionState } from '../../shared/states.ts';
import { errorMessage } from '../../shared/text.ts';
import { CODER_ENV_IDLE_TICK_MS, parseGlimmervoidWorkspaces, planReconcile, shouldIdleStop } from './core/coder-env-core.ts';
import type { CoderWorkspace, ReconcilePlan, WorkspaceMapping } from './core/coder-env-core.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickLoopOptions, TickOutcome } from '../lanes/lane-runner.ts';

interface RemoteIdleSession {
  projectId: string;
  workspace: string;
  state: SessionState;
  idleSinceMs: number | null;
  idleStopMinutes: number;
}

type CoderEnvPollerDeps = Pick<TickLoopOptions, 'now' | 'setIntervalFn' | 'clearIntervalFn' | 'setTimeoutFn' | 'clearTimeoutFn' | 'firstTickDelayMs' | 'random' | 'log'> & {
  listWorkspaces: () => Promise<string>;
  stopWorkspace: (workspace: string) => Promise<void>;
  deleteWorkspace: (workspace: string) => Promise<void>;
  sessionsForIdleCheck: () => RemoteIdleSession[];
  mappings: () => WorkspaceMapping[];
  busyWorkspaces: () => ReadonlySet<string>;
  ownedWorkspaces: () => ReadonlySet<string>;
  isReconcilePending: () => boolean;
  deleteAfterStoppedDays: () => number;
  onReconciled: (plan: ReconcilePlan) => void | Promise<void>;
};

function createCoderEnvPoller({
  listWorkspaces, stopWorkspace, deleteWorkspace, sessionsForIdleCheck, mappings, busyWorkspaces, ownedWorkspaces, isReconcilePending, deleteAfterStoppedDays, onReconciled,
  now = Date.now, log = console, ...loopOptions
}: CoderEnvPollerDeps) {
  const stoppedIdlePeriods = new Map<string, number>();

  async function mutateUnmappedWorkspace(mutate: (workspace: string) => Promise<void>, workspace: string): Promise<void> {
    try {
      await mutate(workspace);
    } catch (error) {
      log.warn(`[coder-env] ${errorMessage(error)}; skipping ${workspace}`);
    }
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    try {
      const workspaces = parseGlimmervoidWorkspaces(await listWorkspaces());
      if (workspaces === null) throw new Error('Invalid Coder workspace listing');
      if (loop.isStopped()) return;
      const workspaceByName = new Map<string, CoderWorkspace>(workspaces.map((workspace) => [workspace.name, workspace]));
      const stoppedThisTick = new Set<string>();
      const plan = planReconcile({ workspaces, mappings: mappings(), busyWorkspaces: busyWorkspaces(), ownedWorkspaces: ownedWorkspaces(), nowMs: now(), deleteAfterStoppedDays: deleteAfterStoppedDays() });
      for (const workspace of plan.delete) {
        if (loop.isStopped()) return;
        await mutateUnmappedWorkspace(deleteWorkspace, workspace);
      }
      for (const workspace of plan.stopUnmapped) {
        if (loop.isStopped()) return;
        log.warn(`[coder-env] stopping unmapped workspace ${workspace}`);
        await mutateUnmappedWorkspace(stopWorkspace, workspace);
      }
      if (isReconcilePending()) {
        for (const mapping of plan.stop) {
          if (loop.isStopped()) return;
          const status = workspaceByName.get(mapping.workspace)?.status;
          if (status === 'stopped' || status === 'stopping' || status === 'deleting') continue;
          await stopWorkspace(mapping.workspace);
          stoppedThisTick.add(mapping.workspace);
        }
        await onReconciled(plan);
      }
      const idleSessions = sessionsForIdleCheck();
      const liveWorkspaces = new Set(idleSessions.map((session) => session.workspace));
      for (const workspace of stoppedIdlePeriods.keys()) {
        if (!liveWorkspaces.has(workspace)) stoppedIdlePeriods.delete(workspace);
      }
      const nowMs = now();
      for (const session of idleSessions) {
        if (loop.isStopped()) return;
        const shouldStop = shouldIdleStop({ sessionState: session.state, idleSinceMs: session.idleSinceMs, idleStopMinutes: session.idleStopMinutes, nowMs });
        if (!shouldStop || session.idleSinceMs === null) {
          stoppedIdlePeriods.delete(session.workspace);
          continue;
        }
        if (stoppedIdlePeriods.get(session.workspace) === session.idleSinceMs) continue;
        const status = workspaceByName.get(session.workspace)?.status;
        if (status !== 'running' && status !== 'starting') continue;
        if (!stoppedThisTick.has(session.workspace)) await stopWorkspace(session.workspace);
        stoppedIdlePeriods.set(session.workspace, session.idleSinceMs);
      }
      return;
    } catch (error) {
      log.warn(`[coder-env] ${errorMessage(error)}`);
      return { failed: true };
    }
  }

  const loop = createTickLoop({
    ...loopOptions,
    tag: 'coder-env',
    intervalMs: CODER_ENV_IDLE_TICK_MS,
    now,
    log,
    tick: () => loop.track(runTick()),
  });
  return { start: loop.start, stop: loop.stop, tick: loop.tick };
}

export { createCoderEnvPoller };
export type { CoderEnvPollerDeps };
