import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { reportHeaderError } from '../../action-status.ts';
import { applyAgentLogins } from '../../agent-logins.ts';
import type { HealthSnapshot } from '../../health-monitor.ts';
import { applyHealthSnapshot } from '../../health-monitor.ts';
import { applyHooksReport, applyLateHookResult } from '../../hooks-store.ts';
import { refreshFirstRunChecklist } from '../../onboarding/first-run-loader.ts';
import { applySessionPlanError, reportSessionProblem } from '../../session-card/lifecycle.ts';
import { applySettingsUpdateError, applySettingsUpdateProgress, applySettingsUpdateStatus } from '../../settings/settings-store.ts';
import { applyTraceError } from '../../trace-store.ts';
import { showFeatureHintCard, showPostTurnLeftoversBanner, showUpdateBanner } from '../banners.ts';
import { SERVER_ERROR_SOURCE, showServerGoingDown } from '../connection-screen.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { applyDashboardSettings } from '../dashboard-settings.ts';
import { applyClientTrust } from '../power-menu.ts';
import { handleSnapshot, noteServerBuild } from '../session-frames.ts';

const messageHandlers = {
  'snapshot':           (msg) => { noteServerBuild(msg.serverBuild); handleSnapshot(msg.sessions); },

  'hooks-report':       (msg) => applyHooksReport(msg),
  'save-hook-result':   () => applyLateHookResult(),
  'delete-hook-result': () => applyLateHookResult(),

  'update-status':      (msg) => { showUpdateBanner(msg); applySettingsUpdateStatus(msg); },
  'update-progress':    (msg) => applySettingsUpdateProgress(msg.journal),
  'post-turn-leftovers': (msg) => showPostTurnLeftoversBanner(msg),
  'feature-hint':       (msg) => showFeatureHintCard(msg.hint),
  'error':              (msg) => {
    const isUpdateErrorShownInline = applySettingsUpdateError(msg);
    const isTraceErrorShownInline = applyTraceError(msg);
    const isPlanErrorShownInline = applySessionPlanError(msg);
    if (isUpdateErrorShownInline || isTraceErrorShownInline || isPlanErrorShownInline) return;
    if (msg.id) { reportSessionProblem(msg.id, msg.message); return; }
    reportHeaderError({ source: SERVER_ERROR_SOURCE, message: msg.message });
  },
  'settings-updated':   (msg) => {
    if (msg.settings) applyDashboardSettings(msg.settings);
    refreshFirstRunChecklist();
  },
  'agent-logins':       (msg) => applyAgentLogins(msg.logins),
  'health-snapshot':    (msg) => { if (msg.stats) applyHealthSnapshot(msg.stats as HealthSnapshot & ServerMessageOf<'health-snapshot'>['stats']); },

  'client-trust':       (msg) => applyClientTrust(msg.trust),
  'shutting-down':      () => showServerGoingDown('Shutting down...', 'Shutting down sessions...'),
  'restarting':         () => showServerGoingDown('Restarting...', 'Restarting server...'),
} satisfies DashboardHandlerTable;

export { messageHandlers as serverHandlers };
