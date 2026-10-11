import crypto from 'node:crypto';
import { STATES } from '../shared/states.ts';
import { errorMessage } from '../shared/text.ts';
import type { Session } from '../session/sessions.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { DEFAULT_FACTORY_CHECKS } from '../shared/contracts/browser-config.ts';
import { CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { AgentDispatchRequest } from '../shared/contracts/session.ts';
import type { FactoryDispatchResult, FactoryProjectState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { buildCoherenceSessionOverrides } from './core/coherence-session-core.ts';
import {
  FACTORY_LEDGER_SESSION, FACTORY_REFUSAL_PAUSED, FACTORY_SANE_YOLO_UNAVAILABLE, buildWorkerPrompt, decideAdmission, findFactoryProjectPath, isTransientAdmissionRefusal,
  isTurnEndHookEvent,
} from './core/factory-core.ts';
import type { FactoryLiveWorker, FactoryStallSession } from './core/factory-core.ts';
import type { LaneSpend } from './core/usage-scan-core.ts';
import { parseFilterDriverNames } from './core/git-invocation-core.ts';
import { LANE_CONFIG_EDIT_DENY_RULES } from './core/lane-permissions-core.ts';
import { runHardenedGit } from './git-workspace.ts';
import { registerEphemeralSession } from './ephemeral-session.ts';
import { resolveRequiredSaneYoloHookTools } from './hook-tools.ts';
import { resolveLanePosture } from './lane-posture.ts';
import { LANE_CREDENTIAL_DENY_READ } from './core/lane-posture-core.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import type { FactoryOrchestratorDeps, FactoryOrchestratorSession } from './factory-orchestrator.ts';
import type { FactoryCloseOutWorker } from './factory-closeout.ts';

const FACTORY_WORKER_DENY = Object.freeze(['Bash(git push:*)', 'Bash(gh:*)', 'Bash(glimmervoid:*)', 'WebFetch', ...LANE_CONFIG_EDIT_DENY_RULES]);

const FILTER_PROBE_GIT_OPTIONS = { encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 };

type FactoryWorkerRecord<ManagedSession> = FactoryLiveWorker & {
  session: ManagedSession;
  repoPath: string;
  spawnedAtMs: number | null;
  hasFirstHook: boolean;
};

export { readLaneCommonGitDir as readFactoryCommonGitDir } from './lane-posture.ts';

async function readFilterDriverNames(cwd: string): Promise<string[]> {
  const { stdout: trackedPaths } = await runHardenedGit(['ls-files', '-z'], { ...FILTER_PROBE_GIT_OPTIONS, cwd });
  if (trackedPaths === '') return [];
  const { stdout: attributes } = await runHardenedGit(['check-attr', '--stdin', '-z', 'filter'], { ...FILTER_PROBE_GIT_OPTIONS, cwd, input: trackedPaths });
  return parseFilterDriverNames(attributes);
}

interface FactoryDispatchDeps<ManagedSession extends FactoryOrchestratorSession = Session>
  extends Omit<FactoryOrchestratorDeps<ManagedSession>, 'ensureLedger' | 'commitAndLand' | 'now'> {
  onReadyIntent?: (projectId: string, intentId: string) => void;
  onWorkerTurnEnd?: (worker: FactoryCloseOutWorker) => Promise<void>;
  getOrchestrator: (sessionId: string) => { projectId: string; intentId: string } | null;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  commitAndLand: (projectId: string, projectPath: string, message: string) => Promise<void>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  readTodaySpend: () => LaneSpend;
  readPaused: (projectId: string) => Promise<boolean>;
  notifyOrchestrator: (projectId: string, event: FactoryWorkerEvent) => void;
  setException: (projectId: string, reason: string | null, expectedReason?: string) => void;
  now?: () => number;
}

export function createFactoryDispatch<ManagedSession extends FactoryOrchestratorSession>({
  config, sessions, makeSession, wireSessionEvents, closeSessionDataClients, broadcast, spawnGate, recordLane,
  nodePath, hookCliPath, shimDir, getOrchestrator, serializeProject, ensureLedger, commitAndLand, runCoherence,
  readTodaySpend, readPaused, readTrustedIntentIds, notifyOrchestrator, setException, onWorkerTurnEnd, onReadyIntent,
  now = Date.now, getHookPort, resolveSaneYoloHookTools = resolveRequiredSaneYoloHookTools,
}: FactoryDispatchDeps<ManagedSession>) {
  const liveWorkers = new Map<string, FactoryWorkerRecord<ManagedSession>>();
  const reconciledProjects = new Set<string>();
  const pendingRefusals = new Map<string, { workId: string; reason: string }>();
  let stopped = false;
  const liveWorkersOf = (projectId: string) => [...liveWorkers.values()].filter((worker) => worker.projectId === projectId);

  async function inspectWork(cwd: string): Promise<CoherenceWorkInspect['work']> {
    return CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd, args: ['work', 'inspect', '--json'] }))).work;
  }

  async function reopenIfActive(projectId: string, projectPath: string, workId: string, reason: string): Promise<void> {
    const ledger = await ensureLedger(projectId, projectPath);
    if ((await inspectWork(ledger.cwd)).find((candidate) => candidate.work === workId)?.state !== 'active') return;
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
    const projectPath = findFactoryProjectPath(config, project.projectId);
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
      pendingRefusals.delete(projectId);
      if (!readyIntent && isTransientAdmissionRefusal(reason)) pendingRefusals.set(projectId, { workId, reason });
      if (exception) setException(projectId, reason);
      notifyOrchestrator(projectId, { workId, event: 'refused', detail: reason });
      return { ok: false, reason };
    };
    try {
      return await serializeProject(projectId, async () => {
        const isAuthorized = () => !stopped && config.factory?.enabled === true
          && getOrchestrator(sessionId)?.intentId === intentId;
        if (!isAuthorized()) return refuse('factory orchestrator is no longer live');
        if (await readPaused(projectId)) return refuse(FACTORY_REFUSAL_PAUSED);
        const project = config.projects.find((candidate) => candidate.id === projectId);
        if (!project) return refuse('unknown factory project');
        const ledger = await ensureLedger(projectId, project.path);
        const inspectedWork = await inspectWork(ledger.cwd);
        const trustedIntentIds = await readTrustedIntentIds(projectId);
        if (readyIntent) {
          if (readyIntent !== intentId || !trustedIntentIds.has(readyIntent)) return refuse('ready intent must match the active intent');
          if (!inspectedWork.some((candidate) => candidate.work === readyIntent && candidate.opened.parent === null && candidate.state !== 'completed' && candidate.state !== 'cancelled')) return refuse('ready intent is not open');
          await commitAndLand(projectId, project.path, `factory: intent ready ${readyIntent}`);
          onReadyIntent?.(projectId, readyIntent);
          return { ok: true, sessionId };
        }
        const order = inspectedWork.find((candidate) => candidate.work === workId) ?? null;
        const intent = inspectedWork.find((candidate) => candidate.work === intentId) ?? null;
        const admission = decideAdmission({
          order, intent, trustedIntentIds, liveWorkers: liveWorkersOf(projectId),
          maxRisk: config.factory?.maxRisk, maxLiveWorkers: config.factory?.maxLiveWorkers,
          todaySpend: readTodaySpend(), dailyBudgetUsd: config.factory?.dailyBudgetUsd ?? null,
          filterDriverNames: await readFilterDriverNames(ledger.cwd),
        });
        if (!admission.admit) return refuse(admission.reason, admission.exception);
        pendingRefusals.delete(projectId);
        const checks = config.factory?.checks ?? DEFAULT_FACTORY_CHECKS;
        const posture = await resolveLanePosture({
          access: 'own-worktree', cwd: project.path, writableRoots: [], gitCommit: true, deferWorktree: true,
          integrationBranch: configuredIntegrationBranch(config), network: { domains: [] }, getHookPort,
          allowCommands: ['git add', 'git commit', 'coherence context', ...checks], extraDeny: FACTORY_WORKER_DENY,
          denyRead: LANE_CREDENTIAL_DENY_READ, scrubCredentials: true,
        }, { resolveSaneYoloHookTools: () => resolveSaneYoloHookTools(config) });
        if (!posture.ok) return refuse(posture.reason === 'Sane YOLO is unavailable' ? FACTORY_SANE_YOLO_UNAVAILABLE : posture.reason, true);
        if (!order || !intent || !isAuthorized()) return refuse('factory orchestrator is no longer live');
        const workerSessionId = `factory-work-${workId.slice(-8)}`;
        if (sessions.has(workerSessionId)) return refuse('worker session id is already in use');
        const claudeSessionId = crypto.randomUUID();
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'handoff', workId, '--owner-session', claudeSessionId, '--owner-agent', 'claude-code',
          '--because', 'Factory dispatch admitted this order', '--session', FACTORY_LEDGER_SESSION, '--json',
        ] });
        await runCoherence({ cwd: ledger.cwd, args: [
          'work', 'transition', workId, 'active', '--because', 'Factory worker dispatched', '--session', FACTORY_LEDGER_SESSION, '--json',
        ] });
        const launchWorker = async (): Promise<FactoryDispatchResult> => {
          if (!isAuthorized()) throw new Error('factory orchestrator is no longer live');
          const identity = {
            id: workerSessionId, name: `${project.name} worker ${workId.slice(-8)}`,
            path: project.path, dangerouslySkipPermissions: false,
          };
          const coherence = buildCoherenceSessionOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir });
          const worker = makeSession(identity, config, {
            ...coherence, ...posture.sessionOverrides,
            agent: 'claude-code', ephemeral: true, agentApi: false, requireWorktree: true, dangerouslySkipPermissions: false,
            gitIsolation: { disableRepoCommands: true },
            initialPrompt: buildWorkerPrompt({ projectName: project.name, intent, order, claudeSessionId, checks }),
            extraClaudeArgs: [...coherence.extraClaudeArgs, ...posture.sessionOverrides.extraClaudeArgs],
            spawnEnv: { ...coherence.spawnEnv, ...posture.sessionOverrides.spawnEnv },
          });
          const closeOutWorker: FactoryCloseOutWorker = {
            workId, intentId, projectId, projectPath: project.path, baseSha: null,
            objective: order.opened.objective, criteria: order.opened.criteria, writeScopes: order.opened.writeScopes, session: worker,
          };
          const liveWorker: FactoryWorkerRecord<ManagedSession> = { workId, sessionId: identity.id, writeScopes: order.opened.writeScopes, projectId, session: worker,
            repoPath: project.path, spawnedAtMs: null, hasFirstHook: false };
          worker.on('worktree-ready', ({ worktreeDir, branch, base }: { worktreeDir: string; branch: string | null; base: string | null }) => {
            if ('baseSha' in worker && typeof worker.baseSha === 'string') closeOutWorker.baseSha = worker.baseSha;
            try {
              posture.scopeWorktree({ worktreeDir, branch, base });
            } catch (error) {
              setException(projectId, `Factory worker sandbox could not be scoped to its worktree: ${errorMessage(error)}`);
              worker.destroy();
            }
          });
          worker.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
            if (payload.session_id === claudeSessionId) liveWorker.hasFirstHook = true;
            if (!isTurnEndHookEvent(event) || (typeof payload.session_id === 'string' && payload.session_id !== claudeSessionId)) return;
            void onWorkerTurnEnd?.(closeOutWorker);
          });
          let removed = false;
          let hasLaunched = false;
          const onRemoved = () => {
            if (removed) return;
            removed = true;
            liveWorkers.delete(identity.id);
            notifyOrchestrator(projectId, { workId, event: 'ended', detail: worker.state });
            broadcast({ type: 'session-removed', id: identity.id, session: identity.name });
            if (!hasLaunched || stopped) return;
            void serializeProject(projectId, () => reopenIfActive(projectId, project.path, workId, 'Factory worker ended without merging or blocking'))
              .catch((error: unknown) => reportReopenFailure(projectId, workId, error));
          };
          try {
            wireSessionEvents(worker);
            registerEphemeralSession({ map: sessions, id: identity.id, sess: worker, closeSessionDataClients, logPrefix: 'factory', name: identity.name, recordLane });
            liveWorkers.set(identity.id, liveWorker);
            worker.on('exit', onRemoved);
            worker.on('teardown', onRemoved);
            worker.on('error', () => { worker.destroy(); onRemoved(); });
            await spawnGate.run(() => {
              if (!isAuthorized() || worker._destroyed) return undefined;
              broadcast({ type: 'session-added', ...projectSessionCard(worker, { id: identity.id, name: identity.name }), ephemeral: true });
              liveWorker.spawnedAtMs = now();
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
    pendingRefusals.delete(projectId);
    for (const worker of liveWorkersOf(projectId)) worker.session.destroy();
  }

  async function stop(): Promise<void> {
    stopped = true;
    pendingRefusals.clear();
    const reaping = [...liveWorkers.values()].map((worker) => {
      worker.session.destroy();
      return worker.session._killReap;
    });
    await Promise.allSettled(reaping);
  }

  async function renudgeRefusedDispatch(project: FactoryProjectState, ledgerPath: string | null): Promise<void> {
    const refusal = pendingRefusals.get(project.projectId);
    const orchestrator = project.orchestrator;
    if (stopped || !refusal || !ledgerPath || !orchestrator || project.paused) return;
    if (orchestrator.state !== STATES.IDLE && orchestrator.state !== STATES.COMPLETE) return;
    await serializeProject(project.projectId, async () => {
      const context = getOrchestrator(orchestrator.sessionId);
      if (stopped || config.factory?.enabled !== true || !context || pendingRefusals.get(project.projectId) !== refusal) return;
      const inspectedWork = await inspectWork(ledgerPath);
      const admission = decideAdmission({
        order: inspectedWork.find((order) => order.work === refusal.workId) ?? null,
        intent: inspectedWork.find((order) => order.work === context.intentId) ?? null,
        trustedIntentIds: await readTrustedIntentIds(project.projectId),
        liveWorkers: liveWorkersOf(project.projectId),
        maxRisk: config.factory?.maxRisk, maxLiveWorkers: config.factory?.maxLiveWorkers,
        paused: await readPaused(project.projectId),
        todaySpend: readTodaySpend(), dailyBudgetUsd: config.factory?.dailyBudgetUsd ?? null,
        filterDriverNames: await readFilterDriverNames(ledgerPath),
      });
      if (stopped || pendingRefusals.get(project.projectId) !== refusal) return;
      if (!admission.admit) {
        if (!isTransientAdmissionRefusal(admission.reason)) pendingRefusals.delete(project.projectId);
        return;
      }
      const currentOrchestrator = sessions.get(orchestrator.sessionId);
      if (!currentOrchestrator?.hasLivePty || currentOrchestrator._destroyed) return;
      if (currentOrchestrator.state !== STATES.IDLE && currentOrchestrator.state !== STATES.COMPLETE) return;
      if (getOrchestrator(orchestrator.sessionId)?.intentId !== context.intentId) return;
      pendingRefusals.delete(project.projectId);
      setException(project.projectId, null, refusal.reason);
      notifyOrchestrator(project.projectId, { workId: refusal.workId, event: 'dispatch available', detail: refusal.reason });
    });
  }

  function getStallSessions(): FactoryStallSession[] {
    return [...liveWorkers.values()].flatMap((worker) => {
      const session = worker.session;
      if (!session.hasLivePty || session._destroyed || worker.spawnedAtMs === null) return [];
      return [{ projectId: worker.projectId, sessionId: session.id, repoPath: worker.repoPath, role: 'worker' as const,
        workId: worker.workId, state: session.state, stateSinceMs: session.stateSince,
        spawnedAtMs: worker.spawnedAtMs, hasFirstHook: worker.hasFirstHook }];
    });
  }

  return { dispatch, releaseProject, stop, reconcileActiveOrders, renudgeRefusedDispatch, getStallSessions,
    getLiveWorkers: (projectId: string) => liveWorkersOf(projectId).map(({ workId, sessionId: workerSessionId }) => ({ workId, sessionId: workerSessionId })),
  };
}
