const traceChangedListeners: ((sessionId: string) => void)[] = [];

export function onBoardSessionTraceChanged(listener: (sessionId: string) => void): void {
  traceChangedListeners.push(listener);
}

export function noteBoardSessionTraceChanged(sessionId: string): void {
  for (const listener of traceChangedListeners) listener(sessionId);
}

const statusChangedListeners: ((sessionId: string) => void)[] = [];

export function onBoardSessionStatusChanged(listener: (sessionId: string) => void): void {
  statusChangedListeners.push(listener);
}

export function noteBoardSessionStatusChanged(sessionId: string): void {
  for (const listener of statusChangedListeners) listener(sessionId);
}
