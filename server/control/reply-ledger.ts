import type { ControlSocket } from '../backend/backend-websockets.ts';

type LedgerEntry =
  | { state: 'in-flight'; answeringSocket: ControlSocket; askedOnSocket: ControlSocket; storedAtMs: number }
  | { state: 'settled'; frame: string; storedAtMs: number };

type Admission = 'run' | 'replayed' | 'rerouted';

interface ReplyLedgerOptions {
  nowMs: () => number;
  keepMs: number;
  maxEntries: number;
}

const OPEN_READY_STATE = 1;

function requestIdNeedleOf(requestId: string): string {
  return `"requestId":${JSON.stringify(requestId)}`;
}

function createReplyLedger({ nowMs, keepMs, maxEntries }: ReplyLedgerOptions) {
  const entryByRequestId = new Map<string, LedgerEntry>();
  const inFlightRequestIdsBySocket = new Map<ControlSocket, Set<string>>();
  const realSendBySocket = new WeakMap<ControlSocket, ControlSocket['send']>();

  function forgetInFlight(requestId: string, askedOnSocket: ControlSocket): void {
    const inFlightRequestIds = inFlightRequestIdsBySocket.get(askedOnSocket);
    if (!inFlightRequestIds) return;
    inFlightRequestIds.delete(requestId);
    if (inFlightRequestIds.size === 0) inFlightRequestIdsBySocket.delete(askedOnSocket);
  }

  function dropEntry(requestId: string): void {
    const entry = entryByRequestId.get(requestId);
    if (entry?.state === 'in-flight') forgetInFlight(requestId, entry.askedOnSocket);
    entryByRequestId.delete(requestId);
  }

  function sweepExpired(): void {
    const oldestKeptAtMs = nowMs() - keepMs;
    for (const [requestId, entry] of entryByRequestId) {
      if (entry.storedAtMs > oldestKeptAtMs) return;
      dropEntry(requestId);
    }
  }

  function trimToCapacity(): void {
    for (const requestId of entryByRequestId.keys()) {
      if (entryByRequestId.size < maxEntries) return;
      dropEntry(requestId);
    }
  }

  function sendThroughRealSend(socket: ControlSocket, frame: string | Buffer, callback?: (error?: Error) => void): void {
    const realSend = realSendBySocket.get(socket) ?? socket.send.bind(socket);
    realSend(frame, callback);
  }

  function settledRequestIdOf(socket: ControlSocket, frame: string): string | null {
    const inFlightRequestIds = inFlightRequestIdsBySocket.get(socket);
    if (!inFlightRequestIds) return null;
    for (const requestId of inFlightRequestIds) {
      if (frame.includes(requestIdNeedleOf(requestId))) return requestId;
    }
    return null;
  }

  function deliverAnswer(askedOnSocket: ControlSocket, frame: string, callback?: (error?: Error) => void): void {
    const requestId = settledRequestIdOf(askedOnSocket, frame);
    const entry = requestId === null ? undefined : entryByRequestId.get(requestId);
    if (requestId === null || entry?.state !== 'in-flight') {
      sendThroughRealSend(askedOnSocket, frame, callback);
      return;
    }
    forgetInFlight(requestId, askedOnSocket);
    entryByRequestId.delete(requestId);
    entryByRequestId.set(requestId, { state: 'settled', frame, storedAtMs: nowMs() });
    const answeringSocket = entry.answeringSocket.readyState === OPEN_READY_STATE ? entry.answeringSocket : askedOnSocket;
    sendThroughRealSend(answeringSocket, frame, callback);
  }

  function watch(socket: ControlSocket): void {
    if (realSendBySocket.has(socket)) return;
    realSendBySocket.set(socket, socket.send.bind(socket));
    socket.send = (outgoingFrame, callback) => {
      if (typeof outgoingFrame !== 'string' || !inFlightRequestIdsBySocket.has(socket)) {
        sendThroughRealSend(socket, outgoingFrame, callback);
        return;
      }
      deliverAnswer(socket, outgoingFrame, callback);
    };
  }

  function admit(requestId: string, socket: ControlSocket, isResent: boolean): Admission {
    sweepExpired();
    if (!isResent) dropEntry(requestId);
    const entry = entryByRequestId.get(requestId);
    if (entry?.state === 'settled') {
      sendThroughRealSend(socket, entry.frame);
      return 'replayed';
    }
    if (entry?.state === 'in-flight') {
      entry.answeringSocket = socket;
      return 'rerouted';
    }
    trimToCapacity();
    entryByRequestId.set(requestId, { state: 'in-flight', answeringSocket: socket, askedOnSocket: socket, storedAtMs: nowMs() });
    const inFlightRequestIds = inFlightRequestIdsBySocket.get(socket) ?? new Set<string>();
    inFlightRequestIds.add(requestId);
    inFlightRequestIdsBySocket.set(socket, inFlightRequestIds);
    return 'run';
  }

  function release(requestId: string): void {
    if (entryByRequestId.get(requestId)?.state === 'in-flight') dropEntry(requestId);
  }

  return { watch, admit, release };
}

type ReplyLedger = ReturnType<typeof createReplyLedger>;

export { createReplyLedger };
export type { ReplyLedger };
