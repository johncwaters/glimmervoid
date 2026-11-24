import type { DashboardReconnectedProperties, ReconnectTrigger } from '#shared/contracts/control/control-fields.ts';
import type { ConnectionAction, ConnectionEvent } from './connection-supervisor-core.ts';
import type { OfflinePageKind } from './offline-page-kind-core.ts';

export interface Outage {
  trigger: ReconnectTrigger;
  startedAtMs: number;
  hiddenMs: number | null;
  wasTenantWaking: boolean;
}

export interface AdoptedHandshake {
  handshakeMs: number;
  attempts: number;
}

const SOCKET_DROPPING_ACTIONS: ReadonlySet<ConnectionAction['kind']> = new Set(['replace-control', 'race-control', 'close-sockets']);

const TRIGGER_BY_EVENT: Partial<Record<ConnectionEvent['kind'], ReconnectTrigger>> = {
  shown: 'long-hide',
  resumed: 'resumed',
  frozen: 'frozen',
  'heartbeat-due': 'late-heartbeat',
  'pong-missed': 'pong-missed',
  'handshake-overdue': 'handshake-overdue',
  'tenant-wake-status': 'tenant-woke',
};

function triggerOf(event: ConnectionEvent, actions: readonly ConnectionAction[]): ReconnectTrigger | null {
  if (event.kind === 'control-closed') return 'control-closed';
  if (!actions.some((action) => SOCKET_DROPPING_ACTIONS.has(action.kind))) return null;
  return TRIGGER_BY_EVENT[event.kind] ?? null;
}

export function noteOutageStart(current: Outage | null, event: ConnectionEvent, actions: readonly ConnectionAction[], nowMs: number): Outage | null {
  const isTenantWaking = actions.some((action) => action.kind === 'show-tenant-waking' && action.isWaking);
  if (current) return isTenantWaking ? { ...current, wasTenantWaking: true } : current;
  const trigger = triggerOf(event, actions);
  if (trigger === null) return null;
  const hiddenMs = event.kind === 'shown' ? Math.round(event.hiddenForMs) : null;
  return { trigger, startedAtMs: nowMs, hiddenMs, wasTenantWaking: isTenantWaking };
}

export function reportRecovery(outage: Outage, adopted: AdoptedHandshake, nowMs: number, originKind: OfflinePageKind): DashboardReconnectedProperties {
  return {
    trigger: outage.trigger,
    ms_to_connected: Math.max(0, Math.round(nowMs - outage.startedAtMs)),
    handshake_ms: Math.max(0, Math.round(adopted.handshakeMs)),
    handshake_attempts: Math.max(1, adopted.attempts),
    origin_kind: originKind,
    ...(outage.hiddenMs === null ? {} : { hidden_ms: outage.hiddenMs }),
    was_tenant_waking: outage.wasTenantWaking,
  };
}
