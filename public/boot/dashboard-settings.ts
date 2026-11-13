import { systemTimezone } from '#shared/clock.ts';
import type { BrowserConfig } from '#shared/contracts/browser-config.ts';
import { sendControlRequest } from '../control-ws.ts';
import type { FeatureSurfaceSettings } from '../feature-surfaces-core.ts';
import { applyTerminalSettings } from '../session-card/lifecycle.ts';
import { applySettingsBroadcast } from '../settings/settings-store.ts';
import { setStreamerMode } from '../streamer-mode.ts';
import { applyPhoneArrowPad } from '../theme.ts';
import { isPhoneArrowPad } from '../ui-prefs.ts';
import { syncTelemetryBanner } from './banners.ts';
import { applySurfaceSettings, applyTabOrder } from './view-tabs.ts';

type DashboardSettings = FeatureSurfaceSettings & Pick<BrowserConfig, 'coherence' | 'viewTabOrder' | 'operatorTimezone'> & { streamerMode?: boolean };

function applyDashboardSettings(settings: DashboardSettings) {
  applyPhoneArrowPad(isPhoneArrowPad());
  applyTerminalSettings(settings);
  applySettingsBroadcast(settings);
  applySurfaceSettings(settings);
  syncTelemetryBanner(settings);
  applyTabOrder(settings.viewTabOrder);
  setStreamerMode(settings.streamerMode === true);
}

function reportOperatorTimezone(settings: Pick<DashboardSettings, 'operatorTimezone'>) {
  const browserTimezone = systemTimezone();
  if (settings.operatorTimezone === browserTimezone) return;
  sendControlRequest('update-settings', { settings: { operatorTimezone: browserTimezone } }).catch(() => {});
}

export { applyDashboardSettings, reportOperatorTimezone };
