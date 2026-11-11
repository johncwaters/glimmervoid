import { applyCoherenceJournalResponse, applySessionCoherence, applySessionCoherenceSnapshot, setSessionCoherenceHooks } from '../../coherence/journal-drawer.ts';
import { applySessionDocsChanged, applySessionDocsSnapshot } from '../../doc-editor/doc-editor.ts';
import { addManagerDecision } from '../../session-card/card-problems.ts';
import { applySecretApprovals } from '../../secrets/secrets-settings.ts';
import { applySecretRequest, applySecretRequestsSnapshot } from '../../session-card/secret-request-face.ts';
import { applyTraceChanged, applyTraceResponse } from '../../trace-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { refreshRosterAndAttentionSurfaces } from '../session-frames.ts';

const messageHandlers = {
  'session-trace-response': (msg) => applyTraceResponse(msg),
  'session-trace-changed': (msg) => applyTraceChanged(msg),
  'session-docs-changed': (msg) => applySessionDocsChanged(msg),
  'session-docs-snapshot': (msg) => applySessionDocsSnapshot(msg),
  'session-secret-request': (msg) => applySecretRequest(msg),
  'secret-requests-snapshot': (msg) => applySecretRequestsSnapshot(msg),
  'secret-approvals': (msg) => applySecretApprovals(msg),
  'session-manager-decision': (msg) => { addManagerDecision(msg.id, msg.decision); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-hooks': (msg) => { setSessionCoherenceHooks(msg.id, msg.coherenceHooks); refreshRosterAndAttentionSurfaces(); },
  'session-coherence': (msg) => { applySessionCoherence(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-snapshot': (msg) => { applySessionCoherenceSnapshot(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-journal-response': (msg) => applyCoherenceJournalResponse(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as faceHandlers };
