import type { ControlSocket } from '../backend/backend-websockets.ts';
import { stampSerializedControlFrame } from '../core/control-replay-core.ts';
import type { ReplayLog } from '../core/control-replay-core.ts';

const rawSendBySocket = new WeakMap<ControlSocket, ControlSocket['send']>();

function attachControlSeq(socket: ControlSocket, replayLog: ReplayLog): void {
  if (rawSendBySocket.has(socket)) return;
  const rawSend = socket.send.bind(socket);
  rawSendBySocket.set(socket, rawSend);
  socket.send = ((outgoingFrame: unknown, callback?: (error?: Error) => void) => {
    if (typeof outgoingFrame !== 'string') {
      rawSend(outgoingFrame as Parameters<ControlSocket['send']>[0], callback);
      return;
    }
    rawSend(stampSerializedControlFrame(outgoingFrame, replayLog), callback);
  }) as ControlSocket['send'];
}

function sendStampedControlFrame(socket: ControlSocket, payload: string, callback?: (error?: Error) => void): void {
  const rawSend = rawSendBySocket.get(socket) ?? socket.send.bind(socket);
  rawSend(payload, callback);
}

export { attachControlSeq, sendStampedControlFrame };
