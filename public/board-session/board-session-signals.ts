const traceChangedListeners: ((sessionId: string) => void)[] = [];

export function onBoardSessionTraceChanged(listener: (sessionId: string) => void): void {
  traceChangedListeners.push(listener);
}

export function noteBoardSessionTraceChanged(sessionId: string): void {
  for (const listener of traceChangedListeners) listener(sessionId);
}
