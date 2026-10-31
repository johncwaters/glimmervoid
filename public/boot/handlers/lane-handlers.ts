import { applyBenchmarkActionResult, applyBenchmarkStatus } from '../../benchmark-store.ts';
import { applyCommunityStatus } from '../../community/community-store.ts';
import { showDesktopNotification } from '../../notifications.ts';
import { applyInvestigationActivity, applyInvestigationFinished, applyRadarStatus } from '../../radar/radar-store.ts';
import { refreshSettingsStatus } from '../../settings/settings-store.ts';
import { applyPlanLimits, applyUsageReport, applyUsageSessions } from '../../usage/usage-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';
import { applyUsageSessionChips } from '../session-frames.ts';

const messageHandlers = {
  'radar-status':     (msg) => applyRadarStatus(msg),
  'radar-investigation-activity': (msg) => applyInvestigationActivity(msg),
  'radar-investigation-finished': (msg) => applyInvestigationFinished(msg),
  'community-status': (msg) => applyCommunityStatus(msg),
  'benchmark-status': (msg) => applyBenchmarkStatus(msg),
  'benchmark-action-result': (msg) => applyBenchmarkActionResult(msg),
  'usage-sessions':     (msg) => { applyUsageSessionChips(msg.sessions); applyUsageSessions(msg); },
  'usage-report':       (msg) => { applyUsageReport(msg); refreshSettingsStatus(); },

  'plan-limits':        (msg) => applyPlanLimits(msg),

  'usage-budget-alert': (msg) => showDesktopNotification({
    session: `budget-${msg.scope}-${msg.periodKey}`,
    category: `threshold-${msg.threshold}`,
    message: msg.text,
    ignoreFocus: true,
  }),
} satisfies DashboardHandlerTable;

export { messageHandlers as laneHandlers };
