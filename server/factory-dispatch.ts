import crypto from 'node:crypto';
import { errorMessage } from './core/text-core.ts';
import type { Session } from '../session/sessions.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { DEFAULT_FACTORY_CHECKS } from '../shared/contracts/browser-config.ts';
import { CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { AgentDispatchRequest } from '../shared/contracts/session.ts';
import type { FactoryDispatchResult, FactoryProjectState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { buildCoherenceSessionOverrides } from './core/coherence-session-core.ts';
import { FACTORY_LEDGER_SESSION, buildWorkerPrompt, decideAdmission } from './core/factory-core.ts';
import type { FactoryLiveWorker } from './core/factory-core.ts';
import { registerEphemeralSession } from './ephemeral-session.ts';
import type { FactoryOrchestratorDeps, FactoryOrchestratorSession } from './factory-orchestrator.ts';
import type { FactoryCloseOutWorker } from './factory-closeout.ts';

interface FactoryDispatchDeps<ManagedSession extends FactoryOrchestratorSession = Session>
  extends Omit<FactoryOrchestratorDeps<ManagedSession>, 'ensureLedger' | 'commitAndLand' | 'now'> {
  onReadyIntent?: (projectId: string, intentId: string) => void;
  onWorkerTurnEnd?: (worker: FactoryCloseOutWorker) => Promise<void>;
  getOrchestrator: (sessionId: string) => { projectId: string; intentId: string } | null;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  commitAndLand: (projectId: string, projectPath: string, message: string) => Promise<void>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  readSpentTodayUsd: () => number | null;
  readPaused: (projectId: string) => Promise<boolean>;
  notifyOrchestrator: (projectId: string, event: FactoryWorkerEvent) => void;
  setException: (projectId: string, reason: string | null) => void;
}

export function createFactoryDispatch<ManagedSession extends FactoryOrchestratorSession>({
  config, sessions, makeSession, wireSessionEvents, closeSessionDataClients, broadcast, spawnGate, recordLane,
  nodePath, hookCliPath, shimDir, getOrchestrator, serializeProject, ensureLedger, commitAndLand, runCoherence,
  readSpentTodayUsd, readPaused, readTrustedIntentIds, notifyOrchestrator, setException, onWorkerTurnEnd, onReadyIntent,
}: FactoryDispatchDeps<ManagedSession>) {
  const liveWorkers = new Map<string, FactoryLiveWorker & { session: ManagedSession }>();
  const reconciledProjects = new Set<string>();
  let stopped = false;

  async function reopenIfActive(projectId: string, projectPath: string, workId: string, reason: string): Promise<void> {
    const ledger = await ensureLedger(projectId, projectPath);
    const inspection = CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd: ledger.cwd, args: ['work', 'inspect', '--json'] })));
    if (inspection.work.find((candidate) => candidate.work === workId)?.state !== 'active') return;
    await runCoherence({ cwd: ledger.cwd, args: [
      'work', 'transition', workId, 'open', '--because', reason, '--session', FACTORY_LEDGER_SESSION, '--json',
    ] });
    await commitAndLand(projectId, projectPath, `factory: reopen ${workId}`);
  }

  function reportReopenFailure(projectId: string, workId: string, error: unknown): void {
    setException(projectId, `Could not reopen factory order ${workId}: ${errorMessage(error)}`);
  }

  async function reconcileActiveOrders(project: FactoryProjectState): Promise<void> {
    if (stopped || reconciledProjects.has(project.projectId) || project.error !== null || project.heading.action === 'refuse') return;
    const projectPath = config.projects.find((candidate) => candidate.id === project.projectId)?.path;
    if (!projectPath) return;
    const isWorkerLive = (workId: string) => [...liveWorkers.values()].some((worker) => worker.workId === workId);
    const orphanedOrders = project.orders.filter((order) => order.parent !== null && order.state === 'active'
      && order.lastEvent?.session === FACTORY_LEDGER_SESSION && !isWorkerLive(order.id));
    try {
      await serializeProject(project.projectId, async () => {
        for (const order of orphanedOrders) {
          if (stopped || isWorkerLive(order.id)) continue;
          await reopenIfActive(project.projectId, projectPath, order.id, 'Factory restarted without a live worker for this order');
        }
      });
      reconciledProjects.add(project.projectId);
    } catch (error) {
      setException(project.projectId, `Could not reconcile active factory orders: ${errorMessage(error)}`);
    }
  }

  async function dispatch(sessionId: string, payload: Record<string, unknown>): Promise<FactoryDispatchResult> {
    const parsed = AgentDispatchRequest.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'invalid dispatch work id' };
    const context = getOrchestrator(sessionId);
    if (stopped || config.factory?.enabled !== true || !context) return { ok: false, reason: 'dispatch requires a live factory orchestrator' };
    const { projectId, intentId } = context;
    const { readyIntent } = parsed.data;
    const workId = parsed.data.workId ?? readyIntent ?? intentId;
    const refuse = (reason: string, exception = false): FactoryDispatchResult => {
      if (exception) setException(projectId, reason);
      notifyOrchestrator(projectId, { workId, event: 'refused', detail: reason });
      return { ok: false, reason };
    };
    try {
      return await serializeProject(projectId, async () => {
        const isAuthorized = () => !stopped && config.factory?.enabled === true
          && getOrchestrator(sessionId)?.intentId === intentId;
        if (!isAuthorized()) return refuse('factory orchestrator is no longer live');
        if (await readPaused(projectId)) return refuse('factory is paused');
        const project = config.projects.find((candidate) => candidate.id === projectId);
        if (!project) return refuse('unknown factory project');
        const ledger = await ensureLedger(projectId, project.path);
        const inspection = CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd: ledger.cwd, args: ['work', 'inspect', '--json'] })));
        const trustedIntentIds = await readTrustedIntentIds(projectId);
        if (readyIntent) {
          if (readyIntent !== intentId || !trustedIntentIds.has(readyIntent)) return refuse('ready intent must match the active intent');
          if (!inspection.work.some((candidate) => candidate.work === readyIntent && candidate.opened.parent === null && candidate.state !== 'completed' && candidate.state !== 'cancelled')) return refuse('ready intent is not open');
          await commitAndLand(projectId, project.path, `factory: intent ready ${readyIntent}`);
          onReadyIntent?.(projectId, readyIntent);
          return { ok: true, sessionId };
        }
        const order = inspection.work.find((candidate) => candidate.work === workId) ?? null;
        const intent = inspection.work.find((candidate) => candidate.work === intentId) ?? null;
        const admission = decideAdmission({
          order, intent, trustedIntentIds, liveWorkers: [...liveWorkers.values()].filter((worker) => worker.projectId === projectId),
          maxRisk: config.factory?.maxRisk, maxLiveWorkers: config.factory?.maxLiveWorkers,
          spentTodayUsd: readSpentTodayUsd(), dailyBudgetUsd: config.factory?.dailyBudgetUsd ?? null,
        });
        if (!admission.admit) return refuse(admission.reason, admission.exception);
        if (!order || !intent || !isAuthorized()) return refuse('factory orchestrator is no longer live');
        const workerSessionId = `factory-work-${workId.slice(-8)}`;
        if (sessions.has(workerSessionId)) return refuse('worker session id is already in use');
        const claudeSessionId = crypto.randomUUID();
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'handoff', workId, '--owner-session', claudeSessionId, '--owner-agent', 'claude-code',
          '--because', 'Factory dispatch admitted this order', '--session', 'glimmervoid-factory', '--json',
        ] });
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'transition', workId, 'active', '--because', 'Factory worker dispatched', '--session', 'glimmervoid-factory', '--json',
        ] });
        const launchWorker = async (): Promise<FactoryDispatchResult> => {
          if (!isAuthorized()) throw new Error('factory orchestrator is no longer live');
          const checks = config.factory?.checks ?? DEFAULT_FACTORY_CHECKS;
          const identity = {
            id: workerSessionId, name: `${project.name} worker ${workId.slice(-8)}`,
            path: project.path, dangerouslySkipPermissions: false,
          };
          const worker = makeSession(identity, config, {
            ...buildCoherenceSessionOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir }),
            agent: 'claude-code', ephemeral: true, agentApi: false, requireWorktree: true, dangerouslySkipPermissions: false,
            initialPrompt: buildWorkerPrompt({ projectName: project.name, intent, order, claudeSessionId, checks }),
            settingsPermissions: {
              defaultMode: 'acceptEdits',
              allow: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(coherence context:*)', ...checks.map((check) => `Bash(${check}:*)`)],
              deny: ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(glimmervoid:*)', 'WebFetch'],
            },
          });
          const closeOutWorker: FactoryCloseOutWorker = {
            workId, intentId, projectId, projectPath: project.path, claudeSessionId, baseSha: null,
            objective: order.opened.objective, criteria: order.opened.criteria, writeScopes: order.opened.writeScopes, session: worker,
          };
          worker.on('worktree-ready', () => {
            if ('baseSha' in worker && typeof worker.baseSha === 'string') closeOutWorker.baseSha = worker.baseSha;
          });
          worker.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
            if (event !== 'Stop' || (typeof payload.session_id === 'string' && payload.session_id !== claudeSessionId)) return;
            void onWorkerTurnEnd?.(closeOutWorker);
          });
          let removed = false;
          let hasLaunched = false;
          const projectPath = project.path;
          const onRemoved = () => {
            if (removed) return;
            removed = true;
            liveWorkers.delete(identity.id);
            notifyOrchestrator(projectId, { workId, event: 'ended', detail: worker.state });
            broadcast({ type: 'session-removed', id: identity.id, session: identity.name });
            if (!hasLaunched || stopped) return;
            void serializeProject(projectId, () => reopenIfActive(projectId, projectPath, workId, 'Factory worker ended without merging or blocking'))
              .catch((error: unknown) => reportReopenFailure(projectId, workId, error));
          };
          try {
            wireSessionEvents(worker);
            registerEphemeralSession({ map: sessions, id: identity.id, sess: worker, closeSessionDataClients, logPrefix: 'factory', name: identity.name, recordLane });
            liveWorkers.set(identity.id, { workId, sessionId: identity.id, writeScopes: order.opened.writeScopes, projectId, session: worker });
            worker.on('exit', onRemoved);
            worker.on('teardown', onRemoved);
            worker.on('error', () => { worker.destroy(); onRemoved(); });
            await spawnGate.run(() => {
              if (!isAuthorized() || worker._destroyed) return undefined;
              broadcast({ type: 'session-added', ...projectSessionCard(worker, { id: identity.id, name: identity.name }), ephemeral: true });
              return worker.start();
            });
            if (!isAuthorized() || !worker.hasLivePty || removed) throw new Error('Factory worker did not reach a live terminal');
          } catch (error) {
            worker.destroy();
            onRemoved();
            throw error;
          }
          hasLaunched = true;
          setException(projectId, null);
          notifyOrchestrator(projectId, { workId, event: 'dispatched', sessionId: identity.id, detail: identity.name });
          return { ok: true, sessionId: identity.id };
        };
        try {
          await commitAndLand(projectId, project.path, `factory: dispatch ${workId}`);
          return await launchWorker();
        } catch (error) {
          await reopenIfActive(projectId, project.path, workId, `Factory worker failed to start: ${errorMessage(error)}`)
            .catch((reopenError: unknown) => reportReopenFailure(projectId, workId, reopenError));
          throw error;
        }
      });
    } catch (error) {
      return refuse(errorMessage(error));
    }
  }

  function releaseProject(projectId: string): void {
    for (const worker of liveWorkers.values()) {
      if (worker.projectId !== projectId) continue;
      worker.session.destroy();
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    const reaping = [...liveWorkers.values()].map((worker) => {
      worker.session.destroy();
      return worker.session._killReap;
    });
    await Promise.allSettled(reaping);
  }

  return { dispatch, releaseProject, stop, reconcileActiveOrders,
    getLiveWorkers: (projectId: string) => [...liveWorkers.values()].filter((worker) => worker.projectId === projectId)
      .map(({ workId, sessionId: workerSessionId }) => ({ workId, sessionId: workerSessionId })),
  };
}
