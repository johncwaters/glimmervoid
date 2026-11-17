import type { AgentPreviewReply, AgentPreviewRequest } from '../../shared/contracts/session-previews.ts';
import { previewBasePath } from '../core/preview-proxy-core.ts';

interface SessionPreviewsDependencies {
  broadcastControl: (message: Record<string, unknown>) => void;
  isSessionLive: (sessionId: string) => boolean;
}

export function createSessionPreviews({ broadcastControl, isSessionLive }: SessionPreviewsDependencies) {
  const portBySessionId = new Map<string, number>();

  function announce(sessionId: string, port: number | null): void {
    broadcastControl({ type: 'session-preview-changed', id: sessionId, port });
  }

  function handle(sessionId: string, { port }: AgentPreviewRequest): AgentPreviewReply {
    if (port === null) {
      portBySessionId.delete(sessionId);
      announce(sessionId, null);
      return { ok: true, path: null, note: 'the preview is closed on the dashboard' };
    }
    if (!isSessionLive(sessionId)) return { ok: true, path: null, note: 'this session was removed, so no preview is shown' };
    portBySessionId.set(sessionId, port);
    announce(sessionId, port);
    const basePath = previewBasePath(sessionId);
    return { ok: true, path: basePath, note: `the operator sees http://127.0.0.1:${port} in this session's Preview page; Glimmervoid forwards ${basePath} unchanged, so serve the app under that base path (for example vite --base ${basePath}), and only plain HTTP is forwarded, not WebSockets` };
  }

  function forget(sessionId: string): void {
    if (!portBySessionId.delete(sessionId)) return;
    announce(sessionId, null);
  }

  return {
    handle,
    forget,
    portOf: (sessionId: string) => portBySessionId.get(sessionId) ?? null,
    snapshotMessage: () => ({ type: 'session-previews-snapshot', ports: Object.fromEntries(portBySessionId) }),
  };
}

export type SessionPreviews = ReturnType<typeof createSessionPreviews>;
