import type { WebSocket } from 'ws';
import type { Session } from '../../session/sessions.ts';
import type { MemoryReading } from '../core/memory-admission-core.ts';
import type { MemoryGateStatus } from '../spawn-gate.ts';
import { STATES } from '../../shared/states.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { clock } from '../../shared/clock.ts';

const HEALTH_SNAPSHOT_INTERVAL_MS = 10000;

interface HealthSession {
  readonly id: string;
  readonly state: Session['state'];
  readonly stateSince: number;
  readonly hasLivePty: boolean;
  readonly resumeSessionId: string | null;
  readonly ephemeral?: boolean;
  readonly hasBackgroundWork: boolean;
  readonly hasLiveChildren: boolean;
  snooze(): { ok: boolean; reason?: string };
  getHealthStats(): ReturnType<Session['getHealthStats']>;
  getDetectionStats(): ReturnType<Session['getDetectionStats']>;
}

interface IdleHibernationOptions {
  idleHibernateMs: number | null;
  headroomFloorBytes: number;
  readHeadroom: () => Promise<MemoryReading>;
}

interface BackendHealthDependencies {
  sessions: Map<string, HealthSession>;
  getAllSessions: () => HealthSession[];
  sessionDataClients: Map<string, Map<WebSocket, unknown>>;
  getMemoryGateStatus: () => MemoryGateStatus;
  idleHibernation?: IdleHibernationOptions;
  controlWss: { clients: Set<WebSocket> };
  viewerControlClientCount: () => number;
  dataWss: { clients: Set<WebSocket> };
  broadcastControl: ControlBroadcast;
}

interface BackendHealth {
  buildHealthSnapshot(): Record<string, unknown>;
  runIdleHibernationSweep(): Promise<string[]>;
  healthInterval: NodeJS.Timeout;
}

function createBackendHealth(dependencies: BackendHealthDependencies): BackendHealth {
  function buildHealthSnapshot(): Record<string, unknown> {
    const memory = process.memoryUsage();
    const sessionStats: Record<string, unknown>[] = [];
    let alivePtyCount = 0;
    let totalDataListeners = 0;
    let totalOutputBufferBytes = 0;
    let listenerMismatch = false;
    let orphanPty = false;
    let destroyedReachable = false;
    for (const session of dependencies.getAllSessions()) {
      const stats = {
        ...session.getHealthStats(),
        detection: session.getDetectionStats(),
        ephemeral: !!session.ephemeral,
      };
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount += 1;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      if (!session.ephemeral) {
        const clientCount = dependencies.sessionDataClients.get(stats.id)?.size || 0;
        if (stats.dataListenerCount !== clientCount) listenerMismatch = true;
        if (stats.hasPty && (stats.state === STATES.DONE || stats.state === STATES.FAILED || stats.state === STATES.DORMANT)) {
          orphanPty = true;
        }
      }
      if (stats.destroyed) destroyedReachable = true;
    }
    let dataClientTotal = 0;
    for (const clients of dependencies.sessionDataClients.values()) {
      dataClientTotal += clients.size;
    }
    let activeResources = 0;
    try {
      activeResources = process.getActiveResourcesInfo().length;
    } catch {}
    return {
      timestamp: clock.nowMs(),
      uptimeSeconds: Math.round(process.uptime()),
      process: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        activeResources,
      },
      sessions: {
        total: dependencies.sessions.size,
        alivePty: alivePtyCount,
        totalDataListeners,
        totalOutputBufferBytes,
        list: sessionStats,
      },
      memoryGate: dependencies.getMemoryGateStatus(),
      websockets: {
        control: dependencies.controlWss.clients.size,
        data: dependencies.dataWss.clients.size,
        dataPerSessionTotal: dataClientTotal,
      },
      anomalies: { listenerMismatch, orphanPty, destroyedReachable },
    };
  }

  let hibernationSweepInFlight: Promise<string[]> | null = null;

  function hasActiveTerminalViewer(id: string): boolean {
    const clients = dependencies.sessionDataClients.get(id);
    if (!clients) return false;
    for (const viewer of clients.values()) {
      if (viewer !== null) return true;
    }
    return false;
  }

  function isEligibleForHibernation(id: string, session: HealthSession): boolean {
    if (session.ephemeral || !session.hasLivePty || !session.resumeSessionId) return false;
    if (session.state !== STATES.IDLE && session.state !== STATES.COMPLETE) return false;
    if (hasActiveTerminalViewer(id)) return false;
    if (session.hasBackgroundWork) return false;
    if (session.hasLiveChildren) return false;
    return true;
  }

  async function runIdleHibernationSweep(): Promise<string[]> {
    const config = dependencies.idleHibernation;
    if (!config) return [];
    const { idleHibernateMs, headroomFloorBytes, readHeadroom } = config;
    if (idleHibernateMs === null && headroomFloorBytes <= 0) return [];
    const reading = headroomFloorBytes > 0 ? await readHeadroom() : { ok: false as const, reason: 'disabled' };
    const isUnderMemoryPressure = reading.ok && reading.headroomBytes < headroomFloorBytes;
    const nowMs = clock.nowMs();
    const snoozedIds: string[] = [];
    let oldestVictim: { id: string; session: HealthSession; stateSince: number } | null = null;

    for (const [id, session] of dependencies.sessions) {
      if (!isEligibleForHibernation(id, session)) continue;
      if (idleHibernateMs !== null && nowMs - session.stateSince >= idleHibernateMs) {
        if (session.snooze().ok) snoozedIds.push(id);
        continue;
      }
      if (!isUnderMemoryPressure) continue;
      if (oldestVictim === null || session.stateSince < oldestVictim.stateSince) {
        oldestVictim = { id, session, stateSince: session.stateSince };
      }
    }

    if (isUnderMemoryPressure && snoozedIds.length === 0 && oldestVictim !== null) {
      if (oldestVictim.session.snooze().ok) snoozedIds.push(oldestVictim.id);
    }
    return snoozedIds;
  }

  const healthInterval = setInterval(() => {
    if (dependencies.idleHibernation && hibernationSweepInFlight === null) {
      hibernationSweepInFlight = runIdleHibernationSweep()
        .catch(() => [])
        .finally(() => { hibernationSweepInFlight = null; });
    }
    if (dependencies.viewerControlClientCount() === 0) return;
    dependencies.broadcastControl({ type: 'health-snapshot', stats: buildHealthSnapshot() });
  }, HEALTH_SNAPSHOT_INTERVAL_MS);
  healthInterval.unref();

  return { buildHealthSnapshot, runIdleHibernationSweep, healthInterval };
}

export { createBackendHealth };
