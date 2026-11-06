import { applyCoherenceJournalResponse, applySessionCoherence, applySessionCoherenceSnapshot, setSessionCoherenceHooks } from '../../coherence/journal-drawer.ts';
import { applySessionDocsChanged, applySessionDocsSnapshot } from '../../doc-editor/doc-editor.ts';
import { applySessionPlanChanged, applySessionPlanDraft, applySessionPlanResponse } from '../../session-card/card-faces.ts';
import { addManagerDecision } from '../../session-card/card-problems.ts';
import { applyTraceChanged, applyTraceResponse } from '../../trace-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { refreshAttentionSurfaces, refreshRosterAndAttentionSurfaces } from '../session-frames.ts';

const messageHandlers = {
  'session-trace-response': (msg) => applyTraceResponse(msg),
  'session-trace-changed': (msg) => applyTraceChanged(msg),
  'session-plan-changed': (msg) => { applySessionPlanChanged(msg); refreshAttentionSurfaces(); },
  'session-plan-draft': (msg) => { applySessionPlanDraft(msg); },
  'session-plan-response': (msg) => { applySessionPlanResponse(msg); },
  'session-docs-changed': (msg) => applySessionDocsChanged(msg),
  'session-docs-snapshot': (msg) => applySessionDocsSnapshot(msg),
  'session-manager-decision': (msg) => { addManagerDecision(msg.id, msg.decision); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-hooks': (msg) => { setSessionCoherenceHooks(msg.id, msg.coherenceHooks); refreshRosterAndAttentionSurfaces(); },
  'session-coherence': (msg) => { applySessionCoherence(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-snapshot': (msg) => { applySessionCoherenceSnapshot(msg); refreshRosterAndAttentionSurfaces(); },
  'session-coherence-journal-response': (msg) => applyCoherenceJournalResponse(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as faceHandlers };
