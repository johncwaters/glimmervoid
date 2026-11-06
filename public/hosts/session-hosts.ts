import { hostStatuses } from './host-status.ts';

const hostIdBySessionId = new Map<string, string>();

export function hostOfSession(sessionId: string): string | null {
  return hostIdBySessionId.get(sessionId) ?? null;
}

export function rememberSessionHost(sessionId: string, hostId: string) {
  hostIdBySessionId.set(sessionId, hostId);
}

export function forgetSessionHost(sessionId: string) {
  hostIdBySessionId.delete(sessionId);
}

export function sessionsOfHost(hostId: string): string[] {
  return [...hostIdBySessionId].flatMap(([sessionId, sessionHostId]) => (sessionHostId === hostId ? [sessionId] : []));
}

export function dataAttachPrefix(sessionId: string): string {
  const hostId = hostOfSession(sessionId);
  return hostId ? `/hosts/${encodeURIComponent(hostId)}` : '';
}

export function hostGroupOf(sessionId: string): { id: string; name: string; rank: number } | null {
  const hostId = hostOfSession(sessionId);
  if (!hostId) return null;
  const statuses = hostStatuses();
  const rank = statuses.findIndex((status) => status.id === hostId);
  return { id: hostId, name: statuses[rank]?.name ?? hostId, rank: rank === -1 ? statuses.length : rank };
}
