const traceChangedListeners: ((sessionId: string) => void)[] = [];

export function onBoardSessionTraceChanged(listener: (sessionId: string) => void): void {
  traceChangedListeners.push(listener);
}

export function noteBoardSessionTraceChanged(sessionId: string): void {
  for (const listener of traceChangedListeners) listener(sessionId);
}

const digestKeptListeners: ((sessionId: string) => void)[] = [];

export function onDirectorDigestKept(listener: (sessionId: string) => void): void {
  digestKeptListeners.push(listener);
}

export function noteDirectorDigestKept(sessionId: string): void {
  for (const listener of digestKeptListeners) listener(sessionId);
}
