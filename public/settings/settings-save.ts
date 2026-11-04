import { playAlertSound } from '../alert-sound.ts';
import { sendControlRequest } from '../control-ws.ts';
import { ensureNotificationPermission } from '../notifications.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { isSkillChoicePending } from './team-review-settings-core.ts';
import type { SettingsSetting } from '#shared/settings/registry.ts';
import { settingSavePayload } from './settings-view-core.ts';
import { applyNextAttentionKeyCode } from '../shortcuts.ts';
import { applyFlyingAnimals } from '../flying-animals.ts';
import { applyPhoneArrowPad, applySessionUsageChips, applyTheme } from '../theme.ts';
import { reportTerminalColors } from '../terminal-color-report.ts';
import { isFlyingAnimalsEnabled, setFlyingAnimalsOnPhone, setFlyingAnimalsMinGapSeconds, setFlyingAnimalsMaxGapSeconds, setFlyingAnimalsMinDurationSeconds, setFlyingAnimalsMaxDurationSeconds, setFlyingAnimalsScale, setPhoneArrowPad, setSessionUsageChips, setFlyingAnimalsEnabled, setNotificationsEnabled, setNextAttentionKeyCode, setSoundId, setThemeId, getNextAttentionKeyCode } from '../ui-prefs.ts';
import { applySettingsBroadcast } from './settings-store.ts';
import { applySoundEnabled } from '../mute-button.ts';
import { fieldErrorById, panelRefresher, pendingSaveById, saveStatusById, settingsPayload, storedValue, storedValues, viewMap } from './settings-panel-state.ts';
import type { SaveStatus } from './settings-panel-state.ts';
import { SAVED_STATUS_MS } from './settings-readouts.ts';

const TEAM_REVIEW_ENABLED_ID = 'team-review-enabled';
const savedStatusTimerById = new Map<string, number>();
let saveQueue = Promise.resolve();

const FLYING_ANIMALS_PREFERENCE_WRITERS: Record<string, (value: unknown) => void> = {
  'pref:flyingAnimalsMinGapSeconds': (value) => setFlyingAnimalsMinGapSeconds(Number(value)),
  'pref:flyingAnimalsMaxGapSeconds': (value) => setFlyingAnimalsMaxGapSeconds(Number(value)),
  'pref:flyingAnimalsMinDurationSeconds': (value) => setFlyingAnimalsMinDurationSeconds(Number(value)),
  'pref:flyingAnimalsMaxDurationSeconds': (value) => setFlyingAnimalsMaxDurationSeconds(Number(value)),
  'pref:flyingAnimalsScale': (value) => setFlyingAnimalsScale(Number(value)),
  'pref:flyingAnimalsOnPhone': (value) => setFlyingAnimalsOnPhone(value === true),
};

function applyBrowserPreference(setting: SettingsSetting, value: unknown) {
  if (setting.path === 'pref:sessionUsageChips') {
    setSessionUsageChips(value === true);
    applySessionUsageChips(value === true);
    return;
  }
  if (setting.path === 'pref:phoneArrowPad') {
    setPhoneArrowPad(value === true);
    applyPhoneArrowPad(value === true);
    return;
  }
  if (setting.path === 'pref:nextAttentionKeyCode') {
    setNextAttentionKeyCode(String(value));
    applyNextAttentionKeyCode(getNextAttentionKeyCode());
    panelRefresher().refreshShortcutGroups();
    return;
  }
  if (setting.path === 'pref:themeId') {
    setThemeId(String(value));
    applyTheme(String(value));
    reportTerminalColors();
    return;
  }
  if (setting.path === 'pref:flyingAnimalsEnabled') {
    setFlyingAnimalsEnabled(value === true);
    applyFlyingAnimals(value === true);
    return;
  }
  const writeFlyingAnimalsPreference = FLYING_ANIMALS_PREFERENCE_WRITERS[setting.path];
  if (writeFlyingAnimalsPreference) {
    writeFlyingAnimalsPreference(value);
    applyFlyingAnimals(isFlyingAnimalsEnabled());
    return;
  }
  if (setting.path === 'pref:soundEnabled') {
    applySoundEnabled(value === true);
    return;
  }
  if (setting.path === 'pref:soundId') {
    setSoundId(String(value));
    playAlertSound(String(value));
    return;
  }
  if (setting.path !== 'pref:notificationsEnabled') return;
  setNotificationsEnabled(value === true);
  if (value === true) ensureNotificationPermission().then(() => panelRefresher().refreshRow(setting, { force: true }));
}

function setSaveStatus(setting: SettingsSetting, status: SaveStatus | null) {
  const timer = savedStatusTimerById.get(setting.id);
  if (timer !== undefined) clearTimeout(timer);
  savedStatusTimerById.delete(setting.id);
  if (status) saveStatusById.set(setting.id, status);
  if (!status) saveStatusById.delete(setting.id);
  panelRefresher().refreshRowFoot(setting);
}

function markSaved(setting: SettingsSetting) {
  setSaveStatus(setting, { tone: 'saved', text: 'Saved' });
  savedStatusTimerById.set(setting.id, window.setTimeout(() => setSaveStatus(setting, null), SAVED_STATUS_MS));
}

function isTeamReviewTurningOnWithoutSkill(setting: SettingsSetting, value: unknown): boolean {
  return setting.id === TEAM_REVIEW_ENABLED_ID && value === true && storedValue(setting) !== true && isSkillChoicePending(settingsPayload.teamReview);
}

function commitSetting(setting: SettingsSetting, value: unknown) {
  fieldErrorById.delete(setting.id);
  if (isTeamReviewTurningOnWithoutSkill(setting, value)) {
    panelRefresher().refreshRow(setting, { force: true });
    confirmTeamReviewWithoutSkill(setting);
    return;
  }
  if (setting.path.startsWith('pref:')) {
    storedValues[setting.path] = value;
    applyBrowserPreference(setting, value);
    panelRefresher().refreshRow(setting);
    markSaved(setting);
    return;
  }
  if (pendingSaveById.has(setting.id) && JSON.stringify(pendingSaveById.get(setting.id)) === JSON.stringify(value)) return;
  pendingSaveById.set(setting.id, value);
  setSaveStatus(setting, { tone: 'saving', text: 'Saving' });
  saveQueue = saveQueue.then(() => saveMachineSetting(setting, value));
}

async function saveMachineSetting(setting: SettingsSetting, value: unknown) {
  const settings = settingSavePayload(viewMap, storedValues, setting, value);
  if (Object.keys(settings).length === 0) {
    pendingSaveById.delete(setting.id);
    setSaveStatus(setting, null);
    panelRefresher().refreshRow(setting);
    return;
  }
  setSaveStatus(setting, { tone: 'saving', text: 'Saving' });
  try {
    const message = await sendControlRequest('update-settings', { settings });
    if (pendingSaveById.get(setting.id) === value) pendingSaveById.delete(setting.id);
    if (message.type === 'settings-error') {
      setSaveStatus(setting, { tone: 'error', text: String(message.message) });
      panelRefresher().refreshRow(setting, { force: true });
      return;
    }
    if (message.type !== 'settings-updated') {
      setSaveStatus(setting, { tone: 'error', text: 'The server did not confirm the save.' });
      panelRefresher().refreshRow(setting, { force: true });
      return;
    }
    applySettingsBroadcast(message.settings);
    markSaved(setting);
  } catch (error) {
    if (pendingSaveById.get(setting.id) === value) pendingSaveById.delete(setting.id);
    setSaveStatus(setting, { tone: 'error', text: (error as Error)?.message || 'Failed to save the setting.' });
    panelRefresher().refreshRow(setting, { force: true });
  }
}

function setFieldError(setting: SettingsSetting, error: string | null) {
  if (error) fieldErrorById.set(setting.id, error);
  if (!error) fieldErrorById.delete(setting.id);
  panelRefresher().refreshRowFoot(setting);
}

function confirmTeamReviewWithoutSkill(enabledSetting: SettingsSetting) {
  openConfirmDialog({
    title: enabledSetting.title,
    message: 'No review skill is chosen yet. Pick one in Review skill below and turn team review on again, or turn it on now to review with no skill, where the agent uses whatever skills it has.',
    confirmLabel: 'Turn on with no skill',
    onConfirm: () => { void saveTeamReviewEnabledWithoutSkill(enabledSetting); },
  });
}

async function saveTeamReviewEnabledWithoutSkill(enabledSetting: SettingsSetting) {
  const storedBlock = settingsPayload.teamReview;
  const teamReview = { ...(storedBlock && typeof storedBlock === 'object' ? storedBlock : {}), enabled: true, skill: '' };
  setSaveStatus(enabledSetting, { tone: 'saving', text: 'Saving' });
  try {
    const message = await sendControlRequest('update-settings', { settings: { teamReview } });
    if (message.type !== 'settings-updated') {
      setSaveStatus(enabledSetting, { tone: 'error', text: message.type === 'settings-error' ? String(message.message) : 'The server did not confirm the save.' });
      return;
    }
    applySettingsBroadcast(message.settings);
    markSaved(enabledSetting);
  } catch (error) {
    setSaveStatus(enabledSetting, { tone: 'error', text: (error as Error)?.message || 'Failed to save the setting.' });
  }
}

export { commitSetting, setFieldError };
