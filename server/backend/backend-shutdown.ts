import { createStopperCollector } from '../core/shutdown-core.ts';
import type { StopperEntry } from '../core/shutdown-core.ts';
import type { SessionEndCause } from '../../shared/contracts/telemetry.ts';

interface ShutdownSession {
  destroy(cause: SessionEndCause): void;
  _killReap?: Promise<unknown> | null;
}

interface Stoppable {
  stop: () => unknown;
}

interface BackendShutdownDependencies {
  cancelAutoResume: () => void;
  cancelPostTurnLeftoverCleanup?: () => void;
  healthInterval: NodeJS.Timeout;
  getStopConfigWatch: () => (() => void) | null;
  remoteAuth: { stop: () => unknown } | null;
  stopUpdateCheck: () => void;
  stopUpdateApply?: () => unknown;
  notificationManager: { destroy: () => void };
  telegramChannel: { destroy: () => void };
  sessions: Map<string, ShutdownSession>;
  agentSessions: Map<string, ShutdownSession>;
  reviewSessions: Map<string, ShutdownSession>;
  investigationSessions: Map<string, ShutdownSession>;
  taskTitleSessions?: Map<string, ShutdownSession>;
  directorSessions?: Map<string, ShutdownSession>;
  questionManagerSessions?: Map<string, ShutdownSession>;
  taskTitleRefiner?: Stoppable | null;
  director?: Stoppable | null;
  raceSessions?: Map<string, ShutdownSession>;
  branchGc: Stoppable;
  posthog: { stopPoller: () => unknown };
  teamReview?: { stopPoller: () => unknown } | null;
  myPrs?: { stopPoller: () => unknown } | null;
  packStore?: { stop: () => unknown } | null;
  packSources?: { stop: () => unknown } | null;
  packLaunchers?: { stop: () => unknown } | null;
  community?: { stopPoller: () => unknown } | null;
  workflows?: { stopPoller: () => unknown } | null;
  races?: { stopWatching: () => unknown } | null;
  wargames?: { dispose: () => unknown } | null;
  usage: Stoppable;
  verification?: Stoppable | null;
  starHint?: Stoppable | null;
  traceWiring?: Stoppable | null;
  uploadsWiring?: Stoppable | null;
  whiteboards?: { stopFollowingLinkedFolders: () => void; close: () => Promise<void> } | null;
  traceChangeBroadcast?: Stoppable | null;
  telegramOutbox: { idle: () => unknown };
  configStore?: { idle: () => unknown };
  bootWork: Promise<unknown>[];
  ownedPaths: { idle: () => unknown };
  heartbeat: { stop: () => void };
  outcomes?: Stoppable | null;
  telemetry?: Stoppable | null;
  watcherLink?: Stoppable | null;
  idleStop?: Stoppable | null;
  awakeUsageAlerts?: Stoppable | null;
  githubConnectionAlerts?: Stoppable | null;
  diskAlerts?: Stoppable | null;
  telegramInbound?: Stoppable | null;
  remoteListenerPortFile?: Stoppable | null;
  controlWss: CloseableWebSocketServer;
  dataWss: CloseableWebSocketServer;
}

interface CloseableWebSocketServer {
  clients?: Iterable<{ terminate: () => void }>;
  close: () => void;
}

function closeWebSocketServer(wss: CloseableWebSocketServer): void {
  for (const client of wss.clients ?? []) client.terminate();
  wss.close();
}

interface ShutdownOutcome {
  reaps: Promise<unknown>[];
  stoppers: StopperEntry[];
}

function destroySessions(sessionMaps: Map<string, ShutdownSession>[], pendingReaps: Promise<unknown>[]): void {
  for (const sessions of sessionMaps) {
    for (const session of sessions.values()) {
      session.destroy('server_stopped');
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
    dependencies.cancelPostTurnLeftoverCleanup?.();
    clearInterval(dependencies.healthInterval);
    const stopConfigWatch = dependencies.getStopConfigWatch();
    if (stopConfigWatch) stopConfigWatch();
    const remoteAuth = dependencies.remoteAuth;
    if (remoteAuth) stoppers.add('remote-auth', () => remoteAuth.stop());
    dependencies.stopUpdateCheck();
    if (dependencies.stopUpdateApply) stoppers.add('update-apply', () => dependencies.stopUpdateApply?.());

    dependencies.notificationManager.destroy();
    dependencies.telegramChannel.destroy();
    if (dependencies.races) stoppers.add('races', () => dependencies.races?.stopWatching());
    if (dependencies.wargames) stoppers.add('wargames', () => dependencies.wargames?.dispose());
    const pendingReaps: Promise<unknown>[] = [];
    destroySessions([dependencies.sessions], pendingReaps);
    if (dependencies.taskTitleRefiner) stoppers.add('task-title', () => dependencies.taskTitleRefiner?.stop());
    if (dependencies.director) stoppers.add('director', () => dependencies.director?.stop());
    const watcherLink = dependencies.watcherLink;
    if (watcherLink) stoppers.add('watcher-link', () => watcherLink.stop());
    const idleStop = dependencies.idleStop;
    if (idleStop) stoppers.add('idle-stop', () => idleStop.stop());
    const awakeUsageAlerts = dependencies.awakeUsageAlerts;
    if (awakeUsageAlerts) stoppers.add('awake-usage-alerts', () => awakeUsageAlerts.stop());
    const githubConnectionAlerts = dependencies.githubConnectionAlerts;
    if (githubConnectionAlerts) stoppers.add('github-connection-alerts', () => githubConnectionAlerts.stop());
    const diskAlerts = dependencies.diskAlerts;
    if (diskAlerts) stoppers.add('disk-alerts', () => diskAlerts.stop());
    const telegramInbound = dependencies.telegramInbound;
    if (telegramInbound) stoppers.add('telegram-inbound', () => telegramInbound.stop());
    const remoteListenerPortFile = dependencies.remoteListenerPortFile;
    if (remoteListenerPortFile) stoppers.add('remote-listener-port-file', () => remoteListenerPortFile.stop());
    stoppers.add('branch-gc', () => dependencies.branchGc.stop());
    destroySessions([dependencies.agentSessions, dependencies.reviewSessions], pendingReaps);
    stoppers.add('posthog', () => dependencies.posthog.stopPoller());
    const teamReview = dependencies.teamReview;
    if (teamReview) stoppers.add('team-review', () => teamReview.stopPoller());
    if (dependencies.myPrs) stoppers.add('my-prs', () => dependencies.myPrs?.stopPoller());
    if (dependencies.packStore) stoppers.add('packs', () => dependencies.packStore?.stop());
    if (dependencies.packSources) stoppers.add('pack-sources', () => dependencies.packSources?.stop());
    if (dependencies.packLaunchers) stoppers.add('pack-launchers', () => dependencies.packLaunchers?.stop());
    if (dependencies.community) stoppers.add('community', () => dependencies.community?.stopPoller());
    const workflows = dependencies.workflows;
    if (workflows) stoppers.add('workflows', () => workflows.stopPoller());
    stoppers.add('usage', () => dependencies.usage.stop());
    const verification = dependencies.verification;
    if (verification) stoppers.add('verification', () => verification.stop());
    const starHint = dependencies.starHint;
    if (starHint) stoppers.add('star-hint', () => starHint.stop());
    destroySessions([dependencies.investigationSessions], pendingReaps);
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
    const whiteboards = dependencies.whiteboards;
    if (whiteboards) {
      whiteboards.stopFollowingLinkedFolders();
      stoppers.add('whiteboards', async () => {
        await Promise.allSettled([...pendingReaps]);
        return whiteboards.close();
      });
    }

    stoppers.add('telegram-outbox', () => dependencies.telegramOutbox.idle());
    destroySessions([dependencies.taskTitleSessions ?? new Map(), dependencies.directorSessions ?? new Map(), dependencies.questionManagerSessions ?? new Map(), dependencies.raceSessions ?? new Map()], pendingReaps);
    const outcomes = dependencies.outcomes;
    if (outcomes) stoppers.add('outcomes', () => outcomes.stop());
    const telemetry = dependencies.telemetry;
    if (telemetry) stoppers.add('telemetry', () => telemetry.stop());
    dependencies.heartbeat.stop();
    closeWebSocketServer(dependencies.controlWss);
    closeWebSocketServer(dependencies.dataWss);
    stoppers.add('boot-work', async () => {
      await Promise.allSettled(dependencies.bootWork);
      return dependencies.ownedPaths.idle();
    });
    if (dependencies.configStore) stoppers.add('config-store', () => dependencies.configStore?.idle());
    return { reaps: pendingReaps, stoppers: stoppers.entries() };
  };
}

export { createBackendShutdown };
