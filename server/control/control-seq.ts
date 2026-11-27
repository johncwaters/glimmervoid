import type { ControlSocket } from '../backend/backend-websockets.ts';
import { stampSerializedControlFrameWithSeq } from '../core/control-replay-core.ts';
import type { ReplayLog } from '../core/control-replay-core.ts';

interface SocketSeqState {
  rawSend: ControlSocket['send'];
  lastSentSeq: number;
}

const socketSeqStateBySocket = new WeakMap<ControlSocket, SocketSeqState>();

function attachControlSeq(socket: ControlSocket, replayLog: ReplayLog): void {
  if (socketSeqStateBySocket.has(socket)) return;
  const state: SocketSeqState = { rawSend: socket.send.bind(socket), lastSentSeq: 0 };
  socketSeqStateBySocket.set(socket, state);
  socket.send = ((outgoingFrame: unknown, callback?: (error?: Error) => void) => {
    if (typeof outgoingFrame !== 'string') {
      state.rawSend(outgoingFrame as Parameters<ControlSocket['send']>[0], callback);
      return;
    }
    const { frame, seq } = stampSerializedControlFrameWithSeq(outgoingFrame, replayLog);
    if (seq !== null) state.lastSentSeq = seq;
    state.rawSend(frame, callback);
  }) as ControlSocket['send'];
}

function sendStampedControlFrame(socket: ControlSocket, payload: string, seq: number, callback?: (error?: Error) => void): void {
  const state = socketSeqStateBySocket.get(socket);
  if (state) {
    state.lastSentSeq = seq;
    state.rawSend(payload, callback);
    return;
  }
  socket.send(payload, callback);
}

function lastSentSeqOf(socket: ControlSocket): number {
  return socketSeqStateBySocket.get(socket)?.lastSentSeq ?? 0;
}

export { attachControlSeq, lastSentSeqOf, sendStampedControlFrame };
