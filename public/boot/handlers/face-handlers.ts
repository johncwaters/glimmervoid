import { noteBoardSessionTraceChanged } from '../../board-session/board-session-signals.ts';
import { applyChatTraceChanged } from '../../chat/chat-page.ts';
import { applySessionDocsChanged, applySessionDocsSnapshot } from '../../doc-editor/doc-editor.ts';
import { applySessionPreviewChanged, applySessionPreviewsSnapshot } from '../../preview/preview-page.ts';
import { addManagerDecision } from '../../session-card/card-problems.ts';
import { applySecretApprovals } from '../../secrets/secrets-settings.ts';
import { applySecretRequest, applySecretRequestsSnapshot } from '../../session-card/secret-request-face.ts';
import { applyTraceChanged, applyTraceResponse } from '../../trace-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { refreshRosterAndAttentionSurfaces } from '../session-frames.ts';

const messageHandlers = {
  'session-trace-response': (msg) => applyTraceResponse(msg),
  'session-trace-changed': (msg) => { applyTraceChanged(msg); applyChatTraceChanged(msg.id); noteBoardSessionTraceChanged(msg.id); },
  'session-docs-changed': (msg) => applySessionDocsChanged(msg),
  'session-docs-snapshot': (msg) => applySessionDocsSnapshot(msg),
  'session-preview-changed': (msg) => applySessionPreviewChanged(msg),
  'session-previews-snapshot': (msg) => applySessionPreviewsSnapshot(msg),
  'session-secret-request': (msg) => applySecretRequest(msg),
  'secret-requests-snapshot': (msg) => applySecretRequestsSnapshot(msg),
  'secret-approvals': (msg) => applySecretApprovals(msg),
  'session-manager-decision': (msg) => { addManagerDecision(msg.id, msg.decision); refreshRosterAndAttentionSurfaces(); },
} satisfies DashboardHandlerTable;

export { messageHandlers as faceHandlers };
