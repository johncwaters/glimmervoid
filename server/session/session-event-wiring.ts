import { createNotifyGate, decideAcknowledge, explainNotification } from '../../session/core/notify-gate.ts';
import type { ClaudeSessionIdEvent, Session } from '../../session/sessions.ts';
import { SHELL_AGENT_ID, type PersistedTaskTitle } from '../../shared/contracts/config.ts';
import type { CoherenceHooksState, UnseenOutcome } from '../../shared/contracts/session.ts';
import type { SessionStatusFields } from '../../shared/contracts/control-messages.ts';
import type { SessionPrLinks } from '../../shared/contracts/my-prs.ts';
import { AGENT_ATTENTION_NOTE_SEPARATOR } from '../../shared/contracts/session.ts';
import { decideExitClose } from '../../session/core/exit-close.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { decideWasActiveFlip, decideWasWorkingFlip, isTurnWorkHookEvent } from './core/session-registry-core.ts';
import { adapterBucket, classifySessionExit } from '../core/telemetry-core.ts';
import { INTERACTIVE_LANE } from '../usage/core/usage-lane-core.ts';
import type { Telemetry } from '../telemetry.ts';
import type { CommitSessions } from '../commit-sessions.ts';
import type { SessionEndCause, SessionExitKind } from '../../shared/contracts/telemetry.ts';
import { errorMessage } from '../../shared/text.ts';

const IDLE_COMPACTION_CONFIRM_MS = 10000;

interface WiringProject extends Record<string, unknown> {
  id?: string;
}

interface WiringConfig {
  projects: WiringProject[];
}


interface SessionEventDependencies {
  configStore: SessionPersistenceStore;
  config: WiringConfig;
  recordLane: (sessionId: string, lane: string, vendor?: string) => void;
  usage: { refreshSessions: () => void; nudgeSession: (transcriptPath?: string | null) => void };
  broadcastControl: (message: ControlMessageRecord) => void;
  telegramChannel: { noteStateChange: (id: string) => void; recheck: (id: string) => void };
  notificationManager: {
    acknowledge: (id: string) => void;
    trigger: (id: string, category: string, message: string, kind?: 'plan' | null) => void;
    noteOperatorActivity: () => void;
  };
  attachSessionPrLink: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  removeExitedSession?: (id: string) => void;
  taskTitleRefiner?: { attachSession: (session: Session) => void; onTurnEnd: (session: Session) => void } | null;
  coherenceFeed?: { attachSession: (session: Session) => void; onTurnEnd: (session: Session) => void } | null;
  traceWiring?: { attachSession: (session: Session) => void } | null;
  featureHints?: { attachSession: (session: Session) => void } | null;
  commitSessions?: Pick<CommitSessions, 'noteHeadChange'> | null;
  planReview?: {
    attachSession: (session: Session) => void;
    latestPlanTitle: (sessionId: string) => string | null;
  } | null;
  telemetry?: Pick<Telemetry, 'capture' | 'captureException'> | null;
  logger: Pick<Console, 'error' | 'log' | 'warn'>;
}

interface NotifyCopyContext {
  planTitle: string | null;
  agentNote: string | null;
}

function waitingCopy(name: string, context: NotifyCopyContext): string {
  if (context.planTitle) return `${name} has a plan ready for review: ${context.planTitle}`;
  if (context.agentNote) return `${name}: ${context.agentNote}`;
  return `${name} needs your input`;
}

const NOTIFY_MESSAGES: Record<string, (name: string, context: NotifyCopyContext) => string> = {
  waiting: waitingCopy,
  complete: (name) => `${name} finished working`,
  failed: (name) => `${name} failed`,
};

interface SessionPersistenceStore {
  save: (mutator: (config: WiringConfig) => void) => unknown;
  saveAsync?: (mutator: (config: WiringConfig) => void) => Promise<unknown>;
}

function persistSessionField(
  configStore: SessionPersistenceStore,
  liveConfig: WiringConfig,
  sessionId: string,
  field: string,
  value: unknown,
): void | Promise<void> {
  const mutator = (config: WiringConfig) => {
    const project = config.projects.find((candidate) => candidate.id === sessionId);
    if (!project) return;
    if (value === undefined) {
      delete project[field];
      return;
    }
    project[field] = value;
  };
  const applySavedField = (freshConfig: unknown) => {
    if (freshConfig) mutator(liveConfig);
  };
  if (configStore.saveAsync) return configStore.saveAsync(mutator).then(applySavedField);
  applySavedField(configStore.save(mutator));
}

function createSessionEventWiring(dependencies: SessionEventDependencies): (session: Session) => void {
  return function wireSessionEvents(session: Session): void {
    dependencies.traceWiring?.attachSession(session);
    dependencies.taskTitleRefiner?.attachSession(session);
    dependencies.coherenceFeed?.attachSession(session);
    dependencies.planReview?.attachSession(session);
    dependencies.featureHints?.attachSession(session);
    let pendingPromptKind: string | null = null;
    let pendingAgentNote: string | null = null;
    const notifyGate = createNotifyGate();
    let isAcknowledgeDeferredForCompaction = false;
    let isCompacting = false;
    let compactionConfirmTimer: NodeJS.Timeout | null = null;
    const clearCompactionConfirm = () => {
      if (compactionConfirmTimer === null) return;
      clearTimeout(compactionConfirmTimer);
      compactionConfirmTimer = null;
    };
    const releaseDeferredAcknowledge = () => {
      clearCompactionConfirm();
      if (!isAcknowledgeDeferredForCompaction) return;
      isAcknowledgeDeferredForCompaction = false;
      dependencies.notificationManager.acknowledge(session.id);
    };
    const armCompactionConfirm = () => {
      compactionConfirmTimer = setTimeout(() => {
        compactionConfirmTimer = null;
        if (isCompacting) return;
        releaseDeferredAcknowledge();
      }, IDLE_COMPACTION_CONFIRM_MS);
      compactionConfirmTimer.unref();
    };
    let pendingStatus: SessionStatusFields | null = null;
    const flushStatus = () => {
      const fields = pendingStatus;
      pendingStatus = null;
      if (fields === null || session._destroyed) return;
      dependencies.broadcastControl({ type: 'session-status', id: session.id, session: session.name, timestamp: Date.now(), ...fields });
    };
    const noteStatus = (fields: SessionStatusFields) => {
      if (pendingStatus === null) setImmediate(flushStatus);
      pendingStatus = { ...pendingStatus, ...fields };
    };
    let lastPersistedWasActive: boolean | null = null;
    let lastPersistedWasWorking: boolean | null = null;
    let isTurnWorking: boolean | null = null;
    let spawnedAtMs: number | null = null;
    const persistProjectField = (field: string, value: unknown) => {
      void Promise.resolve(persistSessionField(dependencies.configStore, dependencies.config, session.id, field, value))
        .catch((error: unknown) => dependencies.logger.warn(`[config] Failed to persist ${field}: ${errorMessage(error)}`));
    };
    const captureSessionEnded = (exitKind: SessionExitKind) => {
      if (spawnedAtMs === null) return;
      const durationSeconds = Math.max(0, Math.round((Date.now() - spawnedAtMs) / 1000));
      spawnedAtMs = null;
      dependencies.telemetry?.capture('session_ended', {
        adapter: adapterBucket(session.agentId),
        exit_kind: exitKind,
        duration_seconds: durationSeconds,
      });
    };

    const persistWasWorking = () => {
      const hasBackgroundWork = session.hasBackgroundWork;
      if (isTurnWorking === null && !hasBackgroundWork) return;
      const wasWorking = isTurnWorking === true || hasBackgroundWork;
      if (wasWorking === lastPersistedWasWorking) return;
      const hasWorkStartedOrEnded = wasWorking || lastPersistedWasWorking === true;
      const hasNoLastWorkedAt = typeof dependencies.config.projects.find((project) => project.id === session.id)?.lastWorkedAt !== 'number';
      lastPersistedWasWorking = wasWorking;
      persistProjectField('wasWorking', wasWorking);
      if (hasWorkStartedOrEnded || hasNoLastWorkedAt) persistProjectField('lastWorkedAt', Date.now());
    };
    const markTurnWorking = () => {
      isTurnWorking = true;
      persistWasWorking();
    };
    session.on('hook-event', ({ event }: { event: string }) => {
      if (isTurnWorkHookEvent(event)) markTurnWorking();
    });

    let liveTranscriptPath: string | null = null;
    session.on('claude-session-id', ({ id, vendor, isResumeTarget, transcriptPath }: ClaudeSessionIdEvent) => {
      liveTranscriptPath = transcriptPath;
      if (isResumeTarget) persistProjectField('resumeSessionId', id);
      dependencies.recordLane(id, INTERACTIVE_LANE, vendor);
      dependencies.usage.refreshSessions();
    });
    session.on('resume-cleared', () => persistProjectField('resumeSessionId', null));
    session.on('task-title-state-change', (titleState: PersistedTaskTitle | undefined) => {
      if (session.ephemeral) return;
      persistProjectField('taskTitleState', titleState);
    });
    const savedTitleState = dependencies.config.projects.find((project) => project.id === session.id)?.taskTitleState;
    if (!session.ephemeral && JSON.stringify(savedTitleState) !== JSON.stringify(session.persistedTaskTitle)) {
      persistProjectField('taskTitleState', session.persistedTaskTitle);
    }
    session.on('error', (error: unknown) => {
      dependencies.logger.error(`[${session.name}] error: ${errorMessage(error)}`);
      dependencies.telemetry?.captureException(error, { handled: true });
    });
    session.on('exit', ({ exitCode, signal, reason, exitedOnItsOwn }: { exitCode: number | null; signal: unknown; reason?: string; exitedOnItsOwn?: boolean }) => {
      flushStatus();
      clearCompactionConfirm();
      const reasonText = reason ? `, reason=${reason}` : '';
      dependencies.logger.log(`[${session.name}] exited (code=${exitCode}, signal=${signal}${reasonText})`);
      captureSessionEnded(classifySessionExit({ exitCode, signal, reason }));
      closeSessionAfterExit(exitedOnItsOwn === true);
    });
    function closeSessionAfterExit(exitedOnItsOwn: boolean) {
      const project = dependencies.config.projects.find((candidate) => candidate.id === session.id);
      const exitClose = decideExitClose({
        exitedOnItsOwn,
        isConfiguredSession: project !== undefined,
        mergeStatus: session.mergeStatus,
        isWorkspace: session.isWorkspace,
        hasRemoteEnvironment: Boolean(project?.environment),
      });
      if (exitClose === 'remove') {
        dependencies.logger.log(`[${session.name}] agent quit on its own, removing the session`);
        dependencies.removeExitedSession?.(session.id);
        return;
      }
      if (exitClose === 'confirm') dependencies.broadcastControl({ type: 'session-close-confirm', id: session.id, mergeStatus: session.mergeStatus });
    }
    session.on('teardown', ({ cause }: { id: string; cause: SessionEndCause }) => {
      clearCompactionConfirm();
      isAcknowledgeDeferredForCompaction = false;
      captureSessionEnded(cause);
    });

    session.on('post-turn-check', () => dependencies.usage.nudgeSession(liveTranscriptPath));

    session.on('state-change', ({ from, to, event, detail }: {
      from: SessionState;
      to: SessionState;
      event: string;
      detail: { signal?: string | null; isIdleCompactionActivity?: boolean } | null;
    }) => {
      if (to === STATES.IDLE || to === STATES.COMPLETE) {
        dependencies.taskTitleRefiner?.onTurnEnd(session);
        void session.refreshCoherenceHooks()
          .catch((error: unknown) => dependencies.logger.warn(`[${session.name}] Coherence hooks refresh failed: ${errorMessage(error)}`))
          .finally(() => dependencies.coherenceFeed?.onTurnEnd(session));
      }
      if (event === 'spawn_success') {
        spawnedAtMs = Date.now();
        dependencies.telemetry?.capture('session_started', { adapter: adapterBucket(session.agentId) });
      }
      dependencies.telegramChannel.noteStateChange(session.id);
      noteStatus({
        transition: { from: pendingStatus?.transition?.from ?? from, to, event },
        skipPerms: session.dangerouslySkipPermissions,
        saneYolo: session.saneYolo,
        ...(session.failureReason === null ? {} : { failureReason: session.failureReason }),
      });

      const nextWasActive = decideWasActiveFlip(to, event, session.pendingRestart);
      if (nextWasActive !== null && nextWasActive !== lastPersistedWasActive) {
        lastPersistedWasActive = nextWasActive;
        persistProjectField('wasActive', nextWasActive);
      }
      const nextIsTurnWorking = decideWasWorkingFlip(to, event, detail?.isIdleCompactionActivity === true);
      if (nextIsTurnWorking !== null) isTurnWorking = nextIsTurnWorking;
      persistWasWorking();
      const acknowledgeDecision = decideAcknowledge(isAcknowledgeDeferredForCompaction, from, event, detail?.isIdleCompactionActivity === true);
      isAcknowledgeDeferredForCompaction = acknowledgeDecision.isAcknowledgeDeferred;
      clearCompactionConfirm();
      if (isAcknowledgeDeferredForCompaction) armCompactionConfirm();
      if (acknowledgeDecision.shouldAcknowledge) dependencies.notificationManager.acknowledge(session.id);

      const { category, reason } = explainNotification(
        to,
        notifyGate,
        event,
        { signal: detail?.signal ?? undefined, hookSeen: session.hookSeen, isOwnedByParentSession: session.ownerId !== null, isMachineShell: session.agentId === SHELL_AGENT_ID },
      );
      session.recordNotifyDecision({
        ts: Date.now(),
        kind: 'notify',
        to,
        event: event || null,
        signal: detail?.signal || null,
        hookSeen: session.hookSeen,
        category,
        reason,
      });
      if (!category) return;
      const message = NOTIFY_MESSAGES[category];
      if (!message) return;
      const planTitleForCopy = pendingPromptKind === 'plan'
        ? (dependencies.planReview?.latestPlanTitle(session.id) ?? null)
        : null;
      const agentNoteForCopy = pendingPromptKind === 'agent' ? pendingAgentNote : null;
      dependencies.notificationManager.trigger(
        session.id,
        category,
        message(session.name, { planTitle: planTitleForCopy, agentNote: agentNoteForCopy }),
        planTitleForCopy === null ? null : 'plan',
      );
      if (agentNoteForCopy !== null) pendingAgentNote = null;
    });

    session.on('agent-attention', ({ note }: { note: string }) => {
      pendingAgentNote = pendingAgentNote === null ? note : `${pendingAgentNote}${AGENT_ATTENTION_NOTE_SEPARATOR}${note}`;
    });
    session.on('user-prompt', ({ isSelfWake }: { isSelfWake: boolean }) => {
      markTurnWorking();
      pendingAgentNote = null;
      if (!isSelfWake) notifyGate.reset();
      releaseDeferredAcknowledge();
    });
    session.on('waiting-input-acknowledged', () => dependencies.notificationManager.acknowledge(session.id));
    session.on('operator-input', () => dependencies.notificationManager.noteOperatorActivity());
    session.on('prompt-kind-change', ({ pendingPromptKind: nextKind, isCompacting: isNowCompacting }: { pendingPromptKind: string | null; isCompacting: boolean }) => {
      pendingPromptKind = nextKind;
      isCompacting = isNowCompacting;
    });
    session.on('agents-change', (payload: { activeAgents: number; awaitingBackgroundTasks: boolean }) => {
      persistWasWorking();
      dependencies.telegramChannel.recheck(session.id);
      noteStatus({ activeAgents: payload.activeAgents, awaitingBackgroundTasks: payload.awaitingBackgroundTasks });
    });
    session.on('wakeup-change', persistWasWorking);
    session.on('prompt-kind-change', ({ pendingPromptKind: nextKind }: { pendingPromptKind: string | null }) => noteStatus({ pendingPromptKind: nextKind }));
    session.on('unseen-outcome-change', ({ unseenOutcome }: { unseenOutcome: UnseenOutcome | null }) => noteStatus({ unseenOutcome }));

    session.on('merge-status', ({ mergeStatus, reason, parked }: {
      mergeStatus: string;
      reason?: string | null;
      parked?: boolean;
    }) => {
      dependencies.broadcastControl({
        type: 'session-merge-status',
        id: session.id,
        session: session.name,
        mergeStatus,
        reason: reason || null,
        parked: !!parked,
        timestamp: Date.now(),
      });
      dependencies.broadcastControl({ type: 'session-git', id: session.id, worktree: !!session.isWorktree });
    });
    session.on('coherence-hooks-change', (coherenceHooks: CoherenceHooksState | null) => {
      dependencies.broadcastControl({ type: 'session-coherence-hooks', id: session.id, coherenceHooks });
    });
    session.on('task-title-change', ({ taskTitle, isCustom }: { taskTitle: string | null; isCustom: boolean }) => {
      dependencies.broadcastControl({ type: 'session-title', id: session.id, taskTitle, isCustom });
    });
    session.on('pr-links-change', (prLinks: SessionPrLinks) => {
      if (!session.ephemeral) persistProjectField('prLinks', prLinks);
      dependencies.broadcastControl({ type: 'session-prs', id: session.id, linkedPrs: prLinks.links });
    });
    session.on('worktree-changed', ({ sig, headSha, baseRef }: { sig: string; headSha?: string; baseRef?: string | null }) => {
      dependencies.broadcastControl({ type: 'session-changed', id: session.id, sig });
      const worktreeDir = session.worktreeDir;
      if (!headSha || !worktreeDir || !session.hasOwnWorktree) return;
      void dependencies.commitSessions?.noteHeadChange({
        sessionId: session.id,
        sessionName: session.name,
        agent: session.agentId,
        taskTitle: session.taskTitle,
        worktreeDir,
        headSha,
        baseRef: baseRef ?? null,
      });
    });
    session.on('commits-landed', ({ repoDir, fromSha, toSha }: { repoDir: string; fromSha: string; toSha: string }) => {
      void dependencies.commitSessions?.noteHeadChange({
        sessionId: session.id,
        sessionName: session.name,
        agent: session.agentId,
        taskTitle: session.taskTitle,
        worktreeDir: repoDir,
        headSha: toSha,
        baseRef: fromSha,
      });
    });
    session.on('worktree-blocked', ({ branch, notice }: { branch: string | null; notice: unknown }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-blocked',
        id: session.id,
        session: session.name,
        branch,
        notice,
        timestamp: Date.now(),
      });
    });
    session.on('worktree-warning', ({ branch, notice }: { branch: string | null; notice: string }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-warning',
        id: session.id,
        session: session.name,
        branch,
        notice,
        timestamp: Date.now(),
      });
    });
    session.on('worktree-ready', ({ branch, base }: { branch: string | null; base?: string | null }) => {
      dependencies.broadcastControl({
        type: 'session-worktree-ready',
        id: session.id,
        session: session.name,
        branch,
        base,
        timestamp: Date.now(),
      });
      dependencies.broadcastControl({ type: 'session-git', id: session.id, worktree: !!session.isWorktree });
    });
    session.on('rebaseline', () => dependencies.closeSessionDataClients(session.id));
    dependencies.attachSessionPrLink(session);
  };
}

export { createSessionEventWiring, persistSessionField };
