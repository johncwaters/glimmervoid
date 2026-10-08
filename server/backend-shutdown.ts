import { createStopperCollector } from './core/shutdown-core.ts';
import type { StopperEntry } from './core/shutdown-core.ts';

interface ShutdownSession {
  destroy(): void;
  _killReap?: Promise<unknown> | null;
}

interface Stoppable {
  stop: () => unknown;
}

interface BackendShutdownDependencies {
  cancelAutoResume: () => void;
  healthInterval: NodeJS.Timeout;
  getStopConfigWatch: () => (() => void) | null;
  remoteAuth: { stop: () => void } | null;
  stopUpdateCheck: () => void;
  stopUpdateApply?: () => unknown;
  notificationManager: { destroy: () => void };
  telegramChannel: { destroy: () => void };
  sessions: Map<string, ShutdownSession>;
  agentSessions: Map<string, ShutdownSession>;
  reviewSessions: Map<string, ShutdownSession>;
  investigationSessions: Map<string, ShutdownSession>;
  visionsSessions: Map<string, ShutdownSession>;
  changeMapSessions: Map<string, ShutdownSession>;
  taskTitleSessions?: Map<string, ShutdownSession>;
  taskTitleRefiner?: Stoppable | null;
  benchmarkSessions?: Map<string, ShutdownSession>;
  branchGc: Stoppable;
  coderActivity: Stoppable;
  factory?: Stoppable;
  posthog: { stopPoller: () => unknown };
  teamReview?: { stopPoller: () => unknown } | null;
  myPrs?: { stopPoller: () => unknown } | null;
  workflows?: { stopPoller: () => unknown } | null;
  benchmarks?: Stoppable | null;
  usage: Stoppable;
  getIngestLane: () => Stoppable | null;
  getVisionsLane: () => Stoppable | null;
  traceWiring?: Stoppable | null;
  uploadsWiring?: Stoppable | null;
  traceChangeBroadcast?: Stoppable | null;
  planReview?: Stoppable | null;
  telegramOutbox: { idle: () => unknown };
  heartbeat: { stop: () => void };
  outcomes?: Stoppable | null;
  telemetry?: Stoppable | null;
  controlWss: { close: () => void };
  dataWss: { close: () => void };
}

interface ShutdownOutcome {
  reaps: Promise<unknown>[];
  stoppers: StopperEntry[];
}

function destroySessions(sessionMaps: Map<string, ShutdownSession>[], pendingReaps: Promise<unknown>[]): void {
  for (const sessions of sessionMaps) {
    for (const session of sessions.values()) {
      session.destroy();
      if (session._killReap) pendingReaps.push(session._killReap);
    }
  }
}

function createBackendShutdown(dependencies: BackendShutdownDependencies): () => ShutdownOutcome {
  let isShuttingDown = false;

  return function shutdown(): ShutdownOutcome {
    if (isShuttingDown) return { reaps: [], stoppers: [] };
    isShuttingDown = true;
    const stoppers = createStopperCollector();
    dependencies.cancelAutoResume();
    clearInterval(dependencies.healthInterval);
    const stopConfigWatch = dependencies.getStopConfigWatch();
    if (stopConfigWatch) stopConfigWatch();
    if (dependencies.remoteAuth) dependencies.remoteAuth.stop();
    dependencies.stopUpdateCheck();
    if (dependencies.stopUpdateApply) stoppers.add('update-apply', () => dependencies.stopUpdateApply?.());

    dependencies.notificationManager.destroy();
    dependencies.telegramChannel.destroy();
    const pendingReaps: Promise<unknown>[] = [];
    destroySessions([dependencies.sessions], pendingReaps);
    if (dependencies.taskTitleRefiner) stoppers.add('task-title', () => dependencies.taskTitleRefiner?.stop());
    stoppers.add('branch-gc', () => dependencies.branchGc.stop());
    stoppers.add('coder-activity', () => dependencies.coderActivity.stop());
    if (dependencies.factory) stoppers.add('factory', () => dependencies.factory?.stop());
    destroySessions([dependencies.agentSessions, dependencies.reviewSessions], pendingReaps);
    stoppers.add('posthog', () => dependencies.posthog.stopPoller());
    const teamReview = dependencies.teamReview;
    if (teamReview) stoppers.add('team-review', () => teamReview.stopPoller());
    if (dependencies.myPrs) stoppers.add('my-prs', () => dependencies.myPrs?.stopPoller());
    const workflows = dependencies.workflows;
    if (workflows) stoppers.add('workflows', () => workflows.stopPoller());
    const benchmarks = dependencies.benchmarks;
    if (benchmarks) stoppers.add('benchmarks', () => benchmarks.stop());
    stoppers.add('usage', () => dependencies.usage.stop());
    destroySessions([dependencies.investigationSessions], pendingReaps);
    stoppers.add('ingest', () => dependencies.getIngestLane()?.stop());
    stoppers.add('visions', () => dependencies.getVisionsLane()?.stop());
    const traceWiring = dependencies.traceWiring;
    if (dependencies.traceChangeBroadcast) dependencies.traceChangeBroadcast.stop();
    if (traceWiring) {
      stoppers.add('trace', async () => {
        await Promise.allSettled([...pendingReaps]);
        return traceWiring.stop();
      });
    }
    const uploadsWiring = dependencies.uploadsWiring;
    if (uploadsWiring) stoppers.add('uploads', () => uploadsWiring.stop());

    const planReview = dependencies.planReview;
    if (planReview) stoppers.add('plan-review', () => planReview.stop());

    stoppers.add('telegram-outbox', () => dependencies.telegramOutbox.idle());
    destroySessions([dependencies.visionsSessions, dependencies.changeMapSessions, dependencies.taskTitleSessions ?? new Map(), dependencies.benchmarkSessions ?? new Map()], pendingReaps);
    const outcomes = dependencies.outcomes;
    if (outcomes) stoppers.add('outcomes', () => outcomes.stop());
    const telemetry = dependencies.telemetry;
    if (telemetry) stoppers.add('telemetry', () => telemetry.stop());
    dependencies.heartbeat.stop();
    dependencies.controlWss.close();
    dependencies.dataWss.close();
    return { reaps: pendingReaps, stoppers: stoppers.entries() };
  };
}

export { createBackendShutdown };
export type { BackendShutdownDependencies, ShutdownOutcome, ShutdownSession };
