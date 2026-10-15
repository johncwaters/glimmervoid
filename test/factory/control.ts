import WebSocket from 'ws';
import { ClientMessage } from '../../shared/contracts/control-messages.ts';
import { FactoryControlResult, FactoryQueueIntentResult, FactoryState } from '../../shared/contracts/factory.ts';
import { dashboardClient } from '../../tests/helpers/dashboard-ws.ts';
import type { Broadcast } from './verdict.ts';

export async function openControl(port: number, signal: AbortSignal, onState: (broadcast: Broadcast) => void, onReply: (reply: FactoryQueueIntentResult, arrivedAt: string) => void, onSession: (sessionId: string) => void, onFailure: (error: Error) => void, onRetryReply?: (reply: FactoryControlResult, arrivedAt: string) => void) {
  const client = await dashboardClient(port, signal);
  signal.throwIfAborted();
  const socket = new WebSocket(client.url('/control'), client.options);
  const terminate = () => socket.terminate();
  signal.addEventListener('abort', terminate, { once: true });
  socket.on('message', (raw: Buffer) => {
    try {
      const frame = JSON.parse(raw.toString());
      const arrivedAt = new Date().toISOString();
      if (frame.type === 'factory-state') { onState({ arrivedAt, state: FactoryState.parse(frame) }); return; }
      if (frame.type === 'factory-queue-intent-result' && frame.requestId === 'factory-harness') { onReply(FactoryQueueIntentResult.parse(frame), arrivedAt); return; }
      if (frame.type === 'factory-control-result' && frame.requestId === 'factory-harness-retry' && frame.action === 'retry-parked') { onRetryReply?.(FactoryControlResult.parse(frame), arrivedAt); return; }
      if (frame.type === 'snapshot' && Array.isArray(frame.sessions)) {
        for (const session of frame.sessions) if (typeof session.id === 'string') onSession(session.id);
      }
      if (frame.type === 'session-added' && typeof frame.id === 'string') onSession(frame.id);
      if (frame.type === 'error') onFailure(new Error(String(frame.message ?? frame.error ?? 'Control error')));
    } catch (error) { onFailure(error instanceof Error ? error : new Error(String(error))); }
  });
  socket.on('error', onFailure);
  socket.on('close', () => {
    signal.removeEventListener('abort', terminate);
    if (!signal.aborted) onFailure(new Error('Control socket closed unexpectedly'));
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Control socket did not open within 10 seconds')); }, 10_000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.once('close', () => { clearTimeout(timeout); reject(new Error('Control socket closed before open')); });
  });
  return { socket, client, queue: (request: unknown) => socket.send(JSON.stringify(ClientMessage.parse(request))) };
}

export async function saveScreen(client: Awaited<ReturnType<typeof dashboardClient>>, sessionId: string): Promise<string> {
  const socket = new WebSocket(client.url(`/terminals/${encodeURIComponent(sessionId)}`), client.options);
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const finish = () => { clearTimeout(timeout); socket.terminate(); resolve(chunks.join('')); };
    const timeout = setTimeout(finish, 2000);
    socket.on('message', (raw: Buffer, binary: boolean) => { if (!binary) chunks.push(raw.toString()); });
    socket.once('error', (error) => { clearTimeout(timeout); socket.terminate(); reject(error); });
    socket.once('close', finish);
  });
}
