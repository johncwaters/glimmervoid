import type { BrowserConfig } from '#shared/contracts/browser-config.ts';
import type { FeatureSurfaceSettings } from '../feature-surfaces-core.ts';
import { applyTerminalSettings } from '../session-card/lifecycle.ts';
import { applySettingsBroadcast } from '../settings/settings-store.ts';
import { setStreamerMode } from '../streamer-mode.ts';
import { applyPhoneArrowPad } from '../theme.ts';
import { isPhoneArrowPad } from '../ui-prefs.ts';
import { syncTelemetryBanner } from './banners.ts';
import { applySurfaceSettings, applyTabOrder } from './view-tabs.ts';

type DashboardSettings = FeatureSurfaceSettings & Pick<BrowserConfig, 'coherence' | 'viewTabOrder'> & { streamerMode?: boolean; isExperimentalBuild?: boolean };

function applyDashboardSettings(settings: DashboardSettings) {
  applyPhoneArrowPad(settings.isExperimentalBuild === true && isPhoneArrowPad());
  applyTerminalSettings(settings);
  applySettingsBroadcast(settings);
  applySurfaceSettings(settings);
  syncTelemetryBanner(settings);
  applyTabOrder(settings.viewTabOrder);
  setStreamerMode(settings.streamerMode === true);
}

export { applyDashboardSettings };
