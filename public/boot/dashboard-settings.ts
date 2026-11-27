import { systemTimezone } from '#shared/clock.ts';
import type { BrowserConfig } from '#shared/contracts/browser-config.ts';
import type { FeatureSurfaceSettings } from '../feature-surfaces-core.ts';
import { refreshFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { applyTerminalSettings } from '../session-card/lifecycle.ts';
import updateSettingsAction from '../state/actions/update-settings.ts';
import {
  onSettingsPayloadChanged,
  onSettingsServerMessage,
  seedSettingsPayload,
  settingsPayloadSnapshot,
} from '../state/collections/settings.ts';
import { applyPhoneArrowPad } from '../theme.ts';
import { isPhoneArrowPad } from '../ui-prefs.ts';
import { syncTelemetryBanner } from './banners.ts';
import { applySurfaceSettings, applyTabOrder } from './view-tabs.ts';

type DashboardSettings = FeatureSurfaceSettings & Pick<BrowserConfig, 'viewTabOrder' | 'operatorTimezone'>;

let isSettingsCollectionWired = false;

function applyDashboardSettingsEffects(settings: DashboardSettings) {
  applyPhoneArrowPad(isPhoneArrowPad());
  applyTerminalSettings(settings);
  applySurfaceSettings(settings);
  syncTelemetryBanner(settings);
  applyTabOrder(settings.viewTabOrder);
}

function wireSettingsCollection() {
  if (isSettingsCollectionWired) return;
  isSettingsCollectionWired = true;
  onSettingsPayloadChanged(() => {
    applyDashboardSettingsEffects(settingsPayloadSnapshot() as DashboardSettings);
  });
  onSettingsServerMessage((message) => {
    if (message.type !== 'settings-updated') return;
    refreshFirstRunChecklist();
  });
}

function applyDashboardSettings(settings: DashboardSettings) {
  seedSettingsPayload(settings);
}

function reportOperatorTimezone(settings: Pick<DashboardSettings, 'operatorTimezone'>) {
  const browserTimezone = systemTimezone();
  if (settings.operatorTimezone === browserTimezone) return;
  void updateSettingsAction({ settings: { operatorTimezone: browserTimezone } });
}

export { applyDashboardSettings, reportOperatorTimezone, wireSettingsCollection };
