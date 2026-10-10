import crypto from 'node:crypto';
import { errorMessage } from './core/text-core.ts';
import type { EventEmitter } from 'node:events';
import type { Session } from '../session/sessions.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';
import { STATES } from '../shared/states.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import { buildCoherenceSessionOverrides } from './core/coherence-session-core.ts';
import { buildOrchestratorPrompt, collapseWorkerEvents, decideOrchestrator, formatWorkerEvent, nextIntent } from './core/factory-core.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import { registerEphemeralSession } from './ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session-factory.ts';

export const FACTORY_ORCHESTRATOR_ALLOW = Object.freeze([
  'Bash(coherence work create:*)', 'Bash(coherence orient:*)', 'Bash(coherence work inspect:*)',
  'Bash(coherence context:*)', 'Bash(coherence decide:*)', 'Bash(coherence defects:*)', 'Bash(glimmervoid dispatch:*)',
]);

export const FACTORY_ORCHESTRATOR_DENY = Object.freeze([
  'Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh:*)',
  'Bash(coherence work close:*)', 'Bash(coherence work transition:*)', 'Bash(coherence work handoff:*)',
  'Bash(coherence consequence:*)', 'Bash(coherence defect:*)',
  'Bash(npx:*)', 'Bash(node:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(bunx:*)',
]);

export type FactoryOrchestratorSession = Pick<Session, 'id' | 'name' | 'path' | 'agentId' | 'state' | 'stateSince'
  | 'start' | 'destroy' | '_destroyed' | '_killReap' | 'hasLivePty' | 'pasteTextWhenReady' | 'write'> & Pick<EventEmitter, 'on'>;

export interface FactoryOrchestratorDeps<ManagedSession extends FactoryOrchestratorSession = Session> {
  config: GlimmervoidConfig;
  sessions: Map<string, ManagedSession>;
  makeSession: (project: ProjectEntry, config: GlimmervoidConfig, overrides: SessionSpawnOverrides) => ManagedSession;
  wireSessionEvents: (session: ManagedSession) => void;
  closeSessionDataClients: (id: string) => void;
  broadcast: ControlBroadcast;
  spawnGate: SpawnGate;
  recordLane: RecordLane;
  nodePath: string;
  hookCliPath: string;
  shimDir: string;
  ensureLedger: (projectId: string) => Promise<string>;
  commitAndLand: (projectId: string, intentId: string) => Promise<void>;
  readTrustedIntentIds: (projectId: string) => Promise<ReadonlySet<string>>;
  now?: () => number;
}

type OrchestratorRecord<ManagedSession> = {
  session: ManagedSession | null;
  intentId: string;
  recentExitTimesMs: number[];
  queuedLines: string[];
  shouldStop: boolean;
  turnPending: boolean;
  pendingTurnCount: number;
  turnChain: Promise<void>;
  error: string | null;
};

export function createFactoryOrchestrator<ManagedSession extends FactoryOrchestratorSession>({
  config, sessions, makeSession, wireSessionEvents, closeSessionDataClients, broadcast, spawnGate, recordLane,
  nodePath, hookCliPath, shimDir, ensureLedger, commitAndLand, readTrustedIntentIds, now = Date.now,
}: FactoryOrchestratorDeps<ManagedSession>) {
  const records = new Map<string, OrchestratorRecord<ManagedSession>>();
  const queuedLinesByProject = new Map<string, string[]>();
  const pendingTurns = new Set<Promise<void>>();
  let stopped = false;

  function destroySession(record: OrchestratorRecord<ManagedSession>): void {
    record.shouldStop = true;
    record.session?.destroy();
  }

  function flushEvents(record: OrchestratorRecord<ManagedSession>): void {
    const session = record.session;
    if (stopped || record.shouldStop || record.turnPending || !session?.hasLivePty || record.queuedLines.length === 0) return;
    if (session.state !== STATES.IDLE && session.state !== STATES.COMPLETE) return;
    const pasted = session.pasteTextWhenReady(collapseWorkerEvents(record.queuedLines));
    if (!pasted.ok || pasted.deferred) return;
    record.queuedLines.splice(0);
    session.write('\r');
  }

  function turnEnded(projectId: string, record: OrchestratorRecord<ManagedSession>): void {
    if (stopped) return;
    const started = record.turnPending ? record.turnChain.then(() => commitAndLand(projectId, record.intentId)) : commitAndLand(projectId, record.intentId);
    record.pendingTurnCount += 1;
    record.turnPending = true;
    const landing = started.then(() => { record.error = null; }, (error: unknown) => {
      record.error = errorMessage(error);
    }).then(() => {
      record.pendingTurnCount -= 1;
      record.turnPending = record.pendingTurnCount > 0;
      if (record.turnPending) return;
      if (stopped || record.shouldStop) {
        destroySession(record);
        return;
      }
      flushEvents(record);
    });
    record.turnChain = landing;
    pendingTurns.add(landing);
    void landing.then(() => pendingTurns.delete(landing));
  }

  async function spawn(project: FactoryProjectState, intentId: string, previous: OrchestratorRecord<ManagedSession> | undefined): Promise<void> {
    const intent = project.orders.find((order) => order.id === intentId);
    if (!intent) return;
    const queuedLines = queuedLinesByProject.get(project.projectId) ?? [];
    queuedLinesByProject.set(project.projectId, queuedLines);
    const record: OrchestratorRecord<ManagedSession> = {
      session: null, intentId, recentExitTimesMs: previous?.recentExitTimesMs ?? [],
      queuedLines, shouldStop: false, turnPending: false, pendingTurnCount: 0, turnChain: Promise.resolve(), error: previous?.error ?? null,
    };
    records.set(project.projectId, record);
    let hasRegisteredSession = false;
    try {
      const ledgerPath = await ensureLedger(project.projectId);
      if (stopped) return;
      const claudeSessionId = crypto.randomUUID();
      const coherence = buildCoherenceSessionOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir });
      const permissions = buildLanePermissions({ denyTools: FACTORY_ORCHESTRATOR_DENY });
      const identity = { id: `factory-orch-${project.projectId}`, name: `${project.projectName} orchestrator`, path: ledgerPath, dangerouslySkipPermissions: false };
      const session = makeSession(identity, config, {
        ...coherence, agent: 'claude-code', ephemeral: true, agentApi: true, gitWorkspace: null, dangerouslySkipPermissions: false,
        initialPrompt: buildOrchestratorPrompt({ projectName: project.projectName, intent, claudeSessionId }),
        settingsPermissions: { ...permissions.permissions, allow: [...FACTORY_ORCHESTRATOR_ALLOW] }, extraClaudeArgs: [...coherence.extraClaudeArgs, ...permissions.args],
      });
      record.session = session;
      wireSessionEvents(session);
      registerEphemeralSession({ map: sessions, id: identity.id, sess: session, closeSessionDataClients, logPrefix: 'factory', name: identity.name, recordLane });
      let removed = false;
      const onRemoved = () => {
        if (removed) return;
        removed = true;
        if (!record.shouldStop && !stopped) record.recentExitTimesMs = [...record.recentExitTimesMs.filter((exitedAtMs) => exitedAtMs > now() - 600_000), now()];
        if (record.session === session) record.session = null;
        broadcast({ type: 'session-removed', id: identity.id, session: identity.name });
      };
      session.on('exit', onRemoved);
      session.on('teardown', onRemoved);
      session.on('error', (error: Error) => {
        record.error = error.message;
        session.destroy();
      });
      session.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
        if (event !== 'Stop' || (typeof payload.session_id === 'string' && payload.session_id !== claudeSessionId)) return;
        turnEnded(project.projectId, record);
      });
      hasRegisteredSession = true;
      await spawnGate.run(() => {
        if (stopped || session._destroyed) return undefined;
        broadcast({ type: 'session-added', ...projectSessionCard(session, { id: identity.id, name: identity.name }), ephemeral: true });
        return session.start();
      });
      if (!stopped && !session.hasLivePty) throw new Error('Factory orchestrator did not reach a live terminal');
      if (!stopped) record.error = null;
    } catch (error) {
      record.error = errorMessage(error);
      if (!hasRegisteredSession) record.recentExitTimesMs.push(now());
      record.session?.destroy();
    }
  }

  async function tick(project: FactoryProjectState): Promise<FactoryProjectState> {
    let record = records.get(project.projectId);
    const trustedIntentIds = await readTrustedIntentIds(project.projectId);
    const activeIntent = project.orders.find((order) => order.id === record?.intentId && trustedIntentIds.has(order.id) && order.state !== 'completed' && order.state !== 'cancelled');
    const upcoming = nextIntent(project.orders, trustedIntentIds);
    const decision = decideOrchestrator({
      paused: project.paused, laneRunning: !stopped, hasLedger: project.error === null && project.heading.action !== 'refuse',
      activeIntentId: activeIntent?.id ?? null, nextIntentId: upcoming?.id ?? null,
      orchestratorLive: record?.session != null, orchestratorIntentId: record?.intentId ?? null,
      recentExitTimesMs: record?.recentExitTimesMs ?? [], nowMs: now(),
    });
    if (decision.action === 'spawn' && !record?.turnPending) await spawn(project, decision.intentId, record);
    if (decision.action === 'stop' && record) {
      record.shouldStop = true;
      const session = record.session;
      const hasActiveTurn = session && [STATES.INITIALIZING, STATES.STARTING, STATES.RUNNING, STATES.WAITING].some((state) => state === session.state);
      if (decision.reason !== 'project-paused' || (!hasActiveTurn && !record.turnPending)) destroySession(record);
    }
    if (decision.action === 'keep' && record) {
      record.shouldStop = false;
      flushEvents(record);
    }
    record = records.get(project.projectId);
    const exception = decision.action === 'wait' && decision.reason.startsWith('factory-exception') ? decision.reason : null;
    const session = record?.session;
    return {
      ...project, error: project.error ?? exception ?? record?.error ?? null,
      orchestrator: session && record ? { sessionId: session.id, intentId: record.intentId, state: session.state } : null,
    };
  }

  async function stop(): Promise<void> {
    stopped = true;
    const reaping = [...records.values()].map((record) => {
      const session = record.session;
      destroySession(record);
      return session?._killReap;
    });
    await Promise.allSettled([...pendingTurns, ...reaping]);
    queuedLinesByProject.clear();
  }

  function releaseProject(projectId: string): void {
    queuedLinesByProject.delete(projectId);
    const record = records.get(projectId);
    if (!record) return;
    destroySession(record);
    records.delete(projectId);
  }

  function notifyOrchestrator(projectId: string, event: FactoryWorkerEvent): void {
    if (stopped) return;
    const line = formatWorkerEvent(FactoryWorkerEvent.parse(event));
    const queuedLines = queuedLinesByProject.get(projectId) ?? [];
    queuedLinesByProject.set(projectId, queuedLines);
    queuedLines.push(line);
    const record = records.get(projectId);
    if (record) flushEvents(record);
  }

  function getLiveOrchestrator(sessionId: string) {
    if (stopped) return null;
    for (const [projectId, record] of records) {
      if (record.shouldStop || !record.session?.hasLivePty || record.session._destroyed || record.session.id !== sessionId) continue;
      return { projectId, intentId: record.intentId };
    }
    return null;
  }

  return { tick, stop, releaseProject, notifyOrchestrator, getLiveOrchestrator, activeIntentId: (projectId: string) => records.get(projectId)?.intentId ?? null };
}
