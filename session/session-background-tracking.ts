import { isRecord } from "../shared/coerce.ts";
import * as agentTracker from "./core/agent-tracker.ts";
import { decideGateRelease } from "./core/gate-release.ts";
import type { WorkExpiredWhileHeld } from "./core/gate-release.ts";
import { mapSignalToEvent } from "./core/status-mapper.ts";
import { extractNotifiedTaskIds } from "./core/task-title-core.ts";
import * as wakeupTracker from "./core/wakeup-tracker.ts";
import type { WakeupMap } from "./core/wakeup-tracker.ts";
import type { ExpiredOpenWork, TaskRegistryBreakdown } from "./core/agent-tracker.ts";
import { STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import type { ResolvedStatusSignal } from "../detection/status-source.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { clock } from '../shared/clock.ts';
import { BACKGROUND_TASK_SIGNAL_EVENT, type BackgroundTaskSignal } from "../shared/contracts/trace.ts";

interface SessionPort {
  state: () => SessionState;
  isDestroyed: () => boolean;
  emit: (event: string, detail: Record<string, unknown>) => void;
  recordDecision: (entry: DecisionEntry) => void;
  transition: (event: string, detail: Record<string, unknown>) => unknown;
  resyncWorkingLatch: () => void;
  enterCheckTerminal: () => void;
}

interface BackgroundTrackingOptions {
  detectBackgroundAgents: boolean;
  agentTtlMs: number;
  shellTaskTtlMs: number;
  teammateTaskTtlMs: number;
  gateReleaseSettleMs: number;
  announcesFinishedBackgroundWork: boolean;
  detectScheduledWakeups: boolean;
  port: SessionPort;
}

interface GateHeldReady {
  source: string | null | undefined;
  signal: string;
  confidence: string;
  state: SessionState;
  ts: number;
  seq: number;
  agentWorkExpiriesAtHold: number;
  shellWorkExpiriesAtHold: number;
  hadWorkAtHold: boolean;
}

const SCHEDULED_WAKEUP_KEY = "scheduled-wakeup";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type PendingWakeup = {
  at: number | null;
  kind: string;
  reason: string | null;
};

interface SessionBackgroundTracking {
  applyBackgroundTasks(payload: unknown): void;
  clearBgDeclared(): void;
  trackTaskLifecycle(raw: HookSignal): void;
  noteTaskNotificationsDelivered(prompt: unknown): void;
  trackSubagent(raw: HookSignal): void;
  activeAgentCount(): number;
  awaitingBackgroundTasks(): boolean;
  hasBackgroundWork(): boolean;
  expiredOpenWork(): ExpiredOpenWork;
  emitAgentsChange(): void;
  clearAgents(): void;
  stopAnnouncedBackgroundTasks(): void;
  stashGateHeldReady(signal: ResolvedStatusSignal): void;
  clearGateHeldReady(): void;
  trackWakeup(raw: HookSignal): void;
  pendingWakeup(): PendingWakeup | null;
  clearWakeups(): void;
  noteStatus(signal: string): number;
  hasOrphanStopEvidence(): boolean;
  resetTurnEvidence(): void;
  agentBreakdown(): TaskRegistryBreakdown;
  heldReady(): GateHeldReady | null;
  lastActivitySeq(): number;
  wakeups(): WakeupMap;
  isBackgroundAgentDetectionEnabled(): boolean;
}

function launchedBackgroundTask(payload: HookPayload): { taskId: string; isService: boolean } | null {
  const toolResponse = payload.tool_response;
  if (!isRecord(toolResponse)) return null;
  const backgroundTaskId = toolResponse.backgroundTaskId;
  if (typeof backgroundTaskId !== "string" || !backgroundTaskId) return null;
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : null;
  const isService = agentTracker.isServiceShellLaunch({
    command: toolInput?.command,
    description: toolInput?.description,
  });
  return { taskId: backgroundTaskId, isService };
}

function createSessionBackgroundTracking({
  detectBackgroundAgents,
  agentTtlMs,
  shellTaskTtlMs,
  teammateTaskTtlMs,
  gateReleaseSettleMs,
  announcesFinishedBackgroundWork,
  detectScheduledWakeups,
  port,
}: BackgroundTrackingOptions): SessionBackgroundTracking {
  const tasks = agentTracker.createTaskRegistry({ agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs });

  const announcedBackgroundTaskTypes = new Map<string, string | null>();
  let gateHeldReady: GateHeldReady | null = null;
  let gateHeldReadyTimer: NodeJS.Timeout | null = null;

  let gateQuietSince: number | null = null;

  let signalSeq = 0;
  let lastActivitySeq = 0;

  let agentBreakdown: TaskRegistryBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
  let publishedActiveAgents = 0;
  let publishedAwaitingBackgroundTasks = false;
  let publishedHasBackgroundWork = false;

  const wakeups: WakeupMap = new Map();
  let wakeupSeq = 0;
  let wakeupExpiryTimer: NodeJS.Timeout | null = null;

  function activeAgentCount(): number {
    if (!detectBackgroundAgents) {
      agentBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
      return 0;
    }
    const active = tasks.activeCount();
    agentBreakdown = tasks.getBreakdown();
    return active;
  }

  function clearGateTimer(): void {
    if (!gateHeldReadyTimer) return;
    clearTimeout(gateHeldReadyTimer);
    gateHeldReadyTimer = null;
  }

  function clearGateHeldReady(): void {
    gateHeldReady = null;
    gateQuietSince = null;
    clearGateTimer();
    publishAgentsChange();
  }

  function awaitingBackgroundTasks(): boolean {
    return detectBackgroundAgents && gateHeldReady !== null && port.state() === "RUNNING"
      && tasks.isOnlyBackgroundTasks();
  }

  function hasBackgroundWork(): boolean {
    if (activeAgentCount() > 0) return true;
    if (detectBackgroundAgents && tasks.hasLiveMonitor()) return true;
    return pendingWakeup() !== null;
  }

  function publishAgentsChange(): void {
    if (port.isDestroyed()) return;
    const activeAgents = activeAgentCount();
    const awaiting = awaitingBackgroundTasks();
    const backgroundWork = hasBackgroundWork();
    if (activeAgents === publishedActiveAgents && awaiting === publishedAwaitingBackgroundTasks
      && backgroundWork === publishedHasBackgroundWork) return;
    publishedActiveAgents = activeAgents;
    publishedAwaitingBackgroundTasks = awaiting;
    publishedHasBackgroundWork = backgroundWork;
    port.emit("agents-change", { activeAgents, awaitingBackgroundTasks: awaiting });
  }

  function armGateTimer(ms: number): void {
    clearGateTimer();
    gateHeldReadyTimer = setTimeout(() => {
      gateHeldReadyTimer = null;
      evaluateGateHeldReady();
    }, ms);
    gateHeldReadyTimer.unref();
  }

  function gateRecheckMs(now: number): number {
    const fullInterval = Math.min(agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs) + 50;
    const remaining = tasks.msUntilNextDrain(now);
    if (remaining === null) return fullInterval;
    return Math.min(remaining + 50, fullInterval);
  }

  function evaluateGateHeldReady(): void {
    const held = gateHeldReady;
    if (!held || port.isDestroyed()) return;
    const now = clock.nowMs();
    const activeAgents = activeAgentCount();
    publishAgentsChange();

    if (activeAgents === 0 && gateQuietSince === null) gateQuietSince = now;
    const { decision, waitMs } = decideGateRelease({
      heldState: held.state,
      currentState: port.state(),
      activeAgents,
      stashSeq: held.seq,
      lastActivitySeq,
      stashTs: held.ts,
      quietSince: gateQuietSince || 0,
      now,
      settleMs: gateReleaseSettleMs,
      hadWorkAtHold: held.hadWorkAtHold,
      announcesFinishedWork: announcesFinishedBackgroundWork,
      workExpiredWhileHeld: workExpiredWhileHeld(held),
    });

    port.recordDecision({
      ts: now,
      kind: "gate",
      decision,
      waitMs,
      active: activeAgents,
      heldSeq: held.seq,
      lastActivitySeq,
      quietMs: now - held.ts,
    });
    if (decision === "cancel") {
      clearGateHeldReady();
      return;
    }
    if (decision === "gated") {
      gateQuietSince = null;
      armGateTimer(gateRecheckMs(now));
      return;
    }
    if (decision === "wait") {
      armGateTimer(waitMs);
      return;
    }
    if (decision === "await-turn-start") {
      clearGateTimer();
      return;
    }
    clearGateHeldReady();
    if (decision === "check-terminal") {
      port.enterCheckTerminal();
      return;
    }
    const event = mapSignalToEvent(held.signal, port.state(), held.confidence, 0);
    if (event) port.transition(event, { source: held.source, signal: held.signal, deferred: true });
  }

  function workExpiredWhileHeld(held: GateHeldReady): WorkExpiredWhileHeld {
    if (tasks.agentWorkExpiryCount() > held.agentWorkExpiriesAtHold) return "subagent";
    if (tasks.shellWorkExpiryCount() > held.shellWorkExpiriesAtHold) return "shell";
    return "none";
  }

  function emitAgentsChange(): void {
    publishAgentsChange();
    evaluateGateHeldReady();
  }

  function withAgentCount(mutate: () => void): void {
    mutate();
    emitLateFinishes();
    emitAgentsChange();
  }

  function emitLateFinishes(): void {
    for (const lateFinish of tasks.drainLateFinishes()) port.emit("background-work-outlived-limit", lateFinish);
  }

  function expiredOpenWork(): ExpiredOpenWork {
    if (!detectBackgroundAgents) return { subagent: 0, shell: 0 };
    return tasks.expiredOpenWork();
  }

  function emitBackgroundTaskSignal(phase: BackgroundTaskSignal["phase"], taskId: string): void {
    if (port.isDestroyed()) return;
    const signal: BackgroundTaskSignal = { phase, taskId, taskType: announcedBackgroundTaskTypes.get(taskId) ?? null, ts: clock.nowMs() };
    port.emit(BACKGROUND_TASK_SIGNAL_EVENT, signal);
  }

  function announceBackgroundTasksRunning(entries: readonly agentTracker.DeclaredEntry[]): void {
    const { started, stoppedIds } = agentTracker.backgroundTaskChanges(new Set(announcedBackgroundTaskTypes.keys()), entries);
    announceBackgroundTasksStopped(stoppedIds);
    for (const task of started) {
      announcedBackgroundTaskTypes.set(task.id, task.type);
      emitBackgroundTaskSignal("start", task.id);
    }
  }

  function announceBackgroundTasksStopped(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      if (!announcedBackgroundTaskTypes.has(taskId)) continue;
      emitBackgroundTaskSignal("stop", taskId);
      announcedBackgroundTaskTypes.delete(taskId);
    }
  }

  function applyBackgroundTasks(payload: unknown): void {
    if (!detectBackgroundAgents) return;
    const entries = agentTracker.extractBackgroundTasks(payload);
    if (entries === null) return;
    const isBetweenTurns = gateHeldReady !== null || port.state() !== STATES.RUNNING;
    withAgentCount(() => tasks.reconcileDeclared(entries, isBetweenTurns));
    announceBackgroundTasksRunning(entries);
  }

  function clearBgDeclared(): void {
    if (!tasks.hasDeclared()) return;
    withAgentCount(() => tasks.clearDeclared());
  }

  function trackTaskLifecycle(raw: HookSignal): void {
    if (!detectBackgroundAgents) return;
    withAgentCount(() => applyTaskLifecycle(raw));
  }

  function applyTaskLifecycle(raw: HookSignal): void {
    const payload: HookPayload = raw.payload || {};
    const taskId = typeof payload.task_id === "string" && payload.task_id ? payload.task_id : null;
    const name = typeof payload.teammate_name === "string" ? payload.teammate_name : "";
    if (raw.signal === "background-task-launched") {
      const launchedTask = launchedBackgroundTask(payload);
      if (launchedTask) tasks.noteBackgroundTaskLaunched(launchedTask.taskId, launchedTask.isService);
      return;
    }
    if (raw.signal === "task-created") {
      clearGateHeldReady();
      tasks.noteTaskCreated({ taskId, name });
      return;
    }
    if (raw.signal === "task-completed") {
      tasks.noteTaskCompleted({ taskId, name });
      return;
    }

    if (!name) return;
    tasks.noteTeammateIdle(name, clock.nowMs());
  }

  function noteTaskNotificationsDelivered(prompt: unknown): void {
    if (!detectBackgroundAgents) return;
    const deliveredTaskIds = extractNotifiedTaskIds(prompt);
    if (deliveredTaskIds.length === 0) return;
    withAgentCount(() => tasks.noteTaskNotificationsDelivered(deliveredTaskIds));
    announceBackgroundTasksStopped(deliveredTaskIds);
  }

  function trackSubagent(raw: HookSignal): void {
    if (!detectBackgroundAgents) return;
    const declaredAgentId = raw.payload?.agent_id;
    const agentId = typeof declaredAgentId === "string" ? declaredAgentId : null;
    if (raw.signal === "subagent-start") {
      clearGateHeldReady();

      if (typeof agentId === "string") {
        withAgentCount(() => tasks.regateByAgentId(agentId));
      }
    }
    if (agentId && raw.signal === "subagent-start") {
      const changed = tasks.noteAgentStart(agentId, raw.ts || clock.nowMs());
      if (changed) emitAgentsChange();
    }
    if (agentId && raw.signal === "subagent-stop") noteAgentStopped(agentId);

    if (raw.signal === "subagent-stop") applyBackgroundTasks(raw.payload);
  }

  function noteAgentStopped(agentId: string): void {
    const outcome = tasks.noteAgentStop(agentId);
    emitLateFinishes();
    if (outcome === "duplicate") return;
    if (gateHeldReady) {
      gateQuietSince = null;
      evaluateGateHeldReady();
    }
    if (outcome === "removed") emitAgentsChange();
  }

  function stashGateHeldReady(signal: ResolvedStatusSignal): void {
    const now = clock.nowMs();
    gateHeldReady = {
      source: signal.source,
      signal: signal.signal,
      confidence: signal.confidence,
      state: port.state(),
      ts: now,
      seq: signalSeq,
      agentWorkExpiriesAtHold: tasks.agentWorkExpiryCount(),
      shellWorkExpiriesAtHold: tasks.shellWorkExpiryCount(),
      hadWorkAtHold: activeAgentCount() > 0,
    };

    gateQuietSince = null;
    port.resyncWorkingLatch();
    evaluateGateHeldReady();
  }

  function clearAgents(): void {
    const had = activeAgentCount() > 0;
    tasks.clear();
    stopAnnouncedBackgroundTasks();
    if (had) emitAgentsChange();
  }

  function stopAnnouncedBackgroundTasks(): void {
    announceBackgroundTasksStopped([...announcedBackgroundTaskTypes.keys()]);
  }

  function trackWakeup(raw: HookSignal): void {
    if (!detectScheduledWakeups) return;
    const payload: HookPayload = raw.payload || {};
    const ts = raw.ts || clock.nowMs();
    if (raw.signal === "wakeup-scheduled") {
      const toolInput = payload.tool_input;
      const input: Record<string, unknown> = isRecord(toolInput)
        ? toolInput
        : {};
      if (input.stop === true) {
        if (wakeupTracker.removeWakeup(wakeups, SCHEDULED_WAKEUP_KEY)) emitWakeupChange();
        return;
      }
      const delaySec = Number(input.delaySeconds);
      if (!Number.isFinite(delaySec) || delaySec <= 0) return;
      const fireAt = ts + delaySec * 1000;
      if (!Number.isFinite(fireAt)) return;
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      wakeupTracker.addWakeup(wakeups, SCHEDULED_WAKEUP_KEY, { kind: "wakeup", fireAt, reason, ts });
      emitWakeupChange();
      return;
    }
    if (raw.signal === "cron-created") {
      const key = wakeupTracker.extractCronTaskId(payload) || `c${++wakeupSeq}`;
      if (wakeupTracker.addWakeup(wakeups, key, { kind: "cron", fireAt: null, reason: null, ts })) {
        emitWakeupChange();
      }
      return;
    }

    const key = wakeupTracker.extractCronTaskId(payload);
    if (!key) return;
    if (wakeupTracker.removeWakeup(wakeups, key)) emitWakeupChange();
  }

  function pendingWakeup(): PendingWakeup | null {
    if (!detectScheduledWakeups) return null;
    wakeupTracker.pruneWakeups(wakeups, clock.nowMs());
    const entry = wakeupTracker.earliestWakeup(wakeups);
    if (!entry) return null;
    return { at: entry.fireAt, kind: entry.kind, reason: entry.reason };
  }

  function clearWakeupExpiryTimer(): void {
    if (!wakeupExpiryTimer) return;
    clearTimeout(wakeupExpiryTimer);
    wakeupExpiryTimer = null;
  }

  function armWakeupExpiryTimer(): void {
    clearWakeupExpiryTimer();
    const expiresAt = wakeupTracker.nextWakeupExpiry(wakeups);
    if (expiresAt == null) return;
    const delayUntilExpiryMs = Math.max(0, expiresAt - clock.nowMs());
    wakeupExpiryTimer = setTimeout(() => {
      wakeupExpiryTimer = null;
      if (port.isDestroyed()) return;
      if (clock.nowMs() < expiresAt) {
        armWakeupExpiryTimer();
        return;
      }
      emitWakeupChange();
    }, Math.min(delayUntilExpiryMs, MAX_TIMER_DELAY_MS));
    wakeupExpiryTimer.unref();
  }

  function emitWakeupChange(): void {
    if (port.isDestroyed()) return;
    port.emit("wakeup-change", { pendingWakeup: pendingWakeup() });
    armWakeupExpiryTimer();
  }

  function clearWakeups(): void {
    clearWakeupExpiryTimer();
    if (wakeups.size === 0) return;
    wakeups.clear();
    emitWakeupChange();
  }

  function noteStatus(signal: string): number {
    signalSeq += 1;
    if (signal !== "ready") {
      lastActivitySeq = signalSeq;
      if (gateHeldReady) evaluateGateHeldReady();
    }
    return signalSeq;
  }

  return {
    applyBackgroundTasks,
    clearBgDeclared,
    trackTaskLifecycle,
    noteTaskNotificationsDelivered,
    trackSubagent,
    activeAgentCount,
    awaitingBackgroundTasks,
    hasBackgroundWork,
    expiredOpenWork,
    emitAgentsChange,
    clearAgents,
    stopAnnouncedBackgroundTasks,
    stashGateHeldReady,
    clearGateHeldReady,
    trackWakeup,
    pendingWakeup,
    clearWakeups,
    noteStatus,
    hasOrphanStopEvidence: () => tasks.hasOrphanStopEvidence(),
    resetTurnEvidence: () => tasks.resetTurnEvidence(),
    agentBreakdown: () => agentBreakdown,
    heldReady: () => gateHeldReady,
    lastActivitySeq: () => lastActivitySeq,
    wakeups: () => wakeups,
    isBackgroundAgentDetectionEnabled: () => detectBackgroundAgents,
  };
}

export { createSessionBackgroundTracking };
