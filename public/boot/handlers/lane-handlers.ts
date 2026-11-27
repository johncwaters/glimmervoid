import { applyRaceHistory, applyRaceStatus } from '../../arena/race-store.ts';
import { applyWargamesEvents, applyWargamesHistory, applyWargamesStatus } from '../../wargames/wargames-store.ts';
import { applyCommunityStatus } from '../../community/community-store.ts';
import { showDesktopNotification } from '../../notifications.ts';
import { applyInvestigationActivity, applyInvestigationFinished, applyRadarStatus } from '../../radar/radar-store.ts';
import { refreshSettingsStatus } from '../../settings/settings-panel-bridge.ts';
import { applyAccountPlanLimits, applyPlanLimits, applySessionMeter, applyUsageReport, applyUsageSessions } from '../../usage/usage-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'radar-status':     (msg) => applyRadarStatus(msg),
  'radar-investigation-activity': (msg) => applyInvestigationActivity(msg),
  'radar-investigation-finished': (msg) => applyInvestigationFinished(msg),
  'community-status': (msg) => applyCommunityStatus(msg),
  'race-status': (msg) => applyRaceStatus(msg),
  'race-history': (msg) => applyRaceHistory(msg),
  'wargames-status': (msg) => applyWargamesStatus(msg),
  'wargames-history': (msg) => applyWargamesHistory(msg),
  'wargames-events': (msg) => applyWargamesEvents(msg),
  'usage-sessions':     (msg) => applyUsageSessions(msg),
  'usage-report':       (msg) => { applyUsageReport(msg); refreshSettingsStatus(); },

  'plan-limits':        (msg) => applyPlanLimits(msg),
  'account-plan-limits': (msg) => { applyAccountPlanLimits(msg); refreshSettingsStatus(); },
  'session-meter':      (msg) => applySessionMeter(msg),

  'usage-budget-alert': (msg) => showDesktopNotification({
    session: `budget-${msg.scope}-${msg.periodKey}`,
    category: `threshold-${msg.threshold}`,
    message: msg.text,
    ignoreFocus: true,
  }),
} satisfies DashboardHandlerTable;

export { messageHandlers as laneHandlers };
