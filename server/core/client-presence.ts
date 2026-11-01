interface ClientPresence {
  connect: (key: unknown) => void;
  disconnect: (key: unknown) => void;
  setViewedSessions: (key: unknown, viewedSessionIds: readonly string[]) => void;
  connectionCount: () => number;
  isSessionInView: (sessionId: string) => boolean;
}

function decideOffDashboardDelivery(connectionCount: number): boolean {
  return connectionCount === 0;
}

function createClientPresence(): ClientPresence {
  const viewedSessionIdsByConnection = new Map<unknown, ReadonlySet<string>>();

  function connect(key: unknown): void {
    if (viewedSessionIdsByConnection.has(key)) return;
    viewedSessionIdsByConnection.set(key, new Set());
  }

  function disconnect(key: unknown): void {
    viewedSessionIdsByConnection.delete(key);
  }

  function setViewedSessions(key: unknown, viewedSessionIds: readonly string[]): void {
    viewedSessionIdsByConnection.set(key, new Set(viewedSessionIds));
  }

  function isSessionInView(sessionId: string): boolean {
    for (const viewedSessionIds of viewedSessionIdsByConnection.values()) {
      if (viewedSessionIds.has(sessionId)) return true;
    }
    return false;
  }

  return {
    connect,
    disconnect,
    setViewedSessions,
    connectionCount: () => viewedSessionIdsByConnection.size,
    isSessionInView,
  };
}

export { createClientPresence, decideOffDashboardDelivery };
