import './settings-panel.css';
import { renderFlyingAnimalsGallery } from '../flying-animals-gallery.ts';
import { isPhoneLayout, onLayoutChange } from '../form-factor.ts';
import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { CustomAgentSummaryRow } from '#shared/contracts/control-messages.ts';
import { TelegramDeliveryStatus } from '#shared/contracts/control-messages.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText, requestWithStatus } from '../action-status.ts';
import { REPO_SLUG } from '#shared/repo.ts';
import { loadCustomSounds, playAlertSound, resolveSoundId, soundOptions } from '../alert-sound.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';
import { BACK_ICON_PATH, createLineIcon } from '../svg-dom.ts';

const MOVE_UP_ICON_PATH = 'M4 10L8 6L12 10';
const MOVE_DOWN_ICON_PATH = 'M4 6L8 10L12 6';
const GRIP_ICON_PATH = 'M6 4h0.01M10 4h0.01M6 8h0.01M10 8h0.01M6 12h0.01M10 12h0.01';
import { createNotificationPermissionControl, ensureNotificationPermission, notificationsSupported } from '../notifications.ts';
import { formatAgo } from '../poll-ago.ts';
import { UPDATES_SECTION_ID } from '../radar/radar-core.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { isSkillChoicePending, readTeamReviewEnvironment, teamReviewSuggestions } from './team-review-settings-core.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import {
  isExperimentalSection, isExperimentalSetting, SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES, settingsSectionsAvailableOn,
} from '#shared/settings/registry.ts';
import type { SettingsSearchMatch, SettingsSearchResult } from '#shared/settings/registry-core.ts';
import { parseSettingsHash, scoreSettingsSearch } from '#shared/settings/registry-core.ts';
import {
  SCOPE_LABELS,
  childSectionsOf,
  choicePresentation,
  displayRange,
  draftCommitOf,
  fileOnlySearchCard,
  hasUnsavedEdit,
  hydrateFromSettings,
  isAtDefault,
  listValue,
  needsDangerConfirmation,
  numberDraftOf,
  pageScopeOf,
  pageSectionOf,
  phoneSettingsScreenOf,
  resetConfirmationOf,
  resetValueOf,
  rowChipsOf,
  secretEnvironmentSource,
  settingSavePayload,
  settingsNavigationGroupsOf,
  settingsSearchBreadcrumb,
  shouldShowDangerWarning,
  topLevelSectionsOf,
  workflowRuleSummaryLines,
  workflowRuleToggleRows,
} from './settings-view-core.ts';
import type { ControlDraft, SettingsPayload, SettingsValues, WorkflowRuleToggleRow } from './settings-view-core.ts';
import { createSettingsLink, parseSettingsSearchHash, settingsHash, settingsSearchHash } from './settings-link.ts';
import { FEATURE_SURFACE_RULES, OPTIONAL_FEATURE_SURFACES } from '../feature-surfaces-core.ts';
import type { FeatureSurfaceRule } from '../feature-surfaces-core.ts';
import { moveViewId, orderViewIds } from '../view-registry-core.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { appendShortcutChord, applyNextAttentionKeyCode, buildShortcutKeys, currentNextAttentionKeyCode, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { isStreamerMode, onStreamerModeChanged, saveStreamerMode } from '../streamer-mode.ts';
import { recordNextAttentionKey, shortcutChord, shortcutGroupsFor } from '../shortcuts-core.ts';
import { renderPrStatusLegend, renderStatusLegend } from '../status-legend.ts';
import { applyFlyingAnimals } from '../flying-animals.ts';
import { applyPhoneArrowPad, applySessionUsageChips, applyTheme, getThemeList } from '../theme.ts';
import {
  isFlyingAnimalsEnabled,
  getFlyingAnimalsEnteredValues,
  resetFlyingAnimalsAdvanced,
  setFlyingAnimalsOnPhone,
  setFlyingAnimalsMinGapSeconds,
  setFlyingAnimalsMaxGapSeconds,
  setFlyingAnimalsMinDurationSeconds,
  setFlyingAnimalsMaxDurationSeconds,
  setFlyingAnimalsScale,
  getSoundId,
  getThemeId,
  isNotificationsEnabled,
  isSessionUsageChips,
  isPhoneArrowPad,
  setPhoneArrowPad,
  isSoundEnabled,
  setSessionUsageChips,
  setFlyingAnimalsEnabled,
  setNotificationsEnabled,
  setNextAttentionKeyCode,
  setSoundId,
  setThemeId,
  getNextAttentionKeyCode,
} from '../ui-prefs.ts';
import { usageStatusLines } from '../usage/usage-store.ts';
import {
  applySettingsBroadcast, mergeSettingsPayload, notifyPhoneSettingsScreenChanged, requestUpdateApply, requestUpdateCheck, restartServer, setPhoneSettingsScreenProbe,
  settingsFeatureTabViews, settingsPayloadSnapshot, settingsUpdateState, subscribeSettings, takePendingSettingsActivation, returnToSettingsList, requestTeamReviewEnvironmentOnce,
} from './settings-store.ts';
import type { SettingsChange } from './settings-store.ts';
import { applySoundEnabled, onSoundEnabledChange } from '../mute-button.ts';
import {
  installedUpdateText,
  lastUpdateCheckText,
  latestUpdateDetails,
  projectUpdateProgress,
  shouldAutoCheckUpdates,
  shouldShowLatestUpdate,
  updateControls,
  updateSummary,
} from '../updates-view-core.ts';
import { agentLoginOf, agentLoginSummary, onAgentLoginsChanged, openAgentConnectDialog, openRemoteSetupDialog } from '../dialogs.ts';
import type { UpdateActionId } from '../updates-view-core.ts';

type SectionSearchResult = SettingsSearchResult & { section: SettingsSection };

type SaveTone = 'saving' | 'saved' | 'error';

interface SaveStatus {
  tone: SaveTone;
  text: string;
}

const SAVED_STATUS_MS = 2200;
const COPY_STATUS_MS = 1600;
const TELEMETRY_DELETION_TIMEOUT_MS = 15000;
const WEBSITE_ORIGIN = 'https://glimmervoid.dev';
const APPEARANCE_PAGE_ID = 'browser-appearance';
const FLYING_ANIMALS_SETTING_ID = 'flying-animals';
const SEGMENT_STEP_BY_KEY: Readonly<Record<string, number>> = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

const FEATURES_PAGE_ID = 'lanes-features';
const FEATURES_SECTION: SettingsSection = Object.freeze({
  id: FEATURES_PAGE_ID,
  level: 'lanes',
  title: 'Features',
  description: 'Optional tabs, each hidden until its own toggle is on.',
  settings: [],
});
const SHORTCUTS_PAGE_ID = 'browser-shortcuts';
const STATUS_KEY_PAGE_ID = 'browser-status-key';
const STATUS_KEY_SECTION: SettingsSection = Object.freeze({
  id: STATUS_KEY_PAGE_ID,
  level: 'browser',
  title: 'Status key',
  description: 'What each session status and pull request icon means.',
  settings: [],
});
const ABOUT_PAGE_ID = 'browser-about';
const ABOUT_SECTION: SettingsSection = Object.freeze({
  id: ABOUT_PAGE_ID,
  level: 'browser',
  title: 'About',
  description: 'The running build and where the project lives.',
  settings: [],
});
const TEAM_REVIEW_ENABLED_ID = 'team-review-enabled';
const OPTION_CATALOGS: Readonly<Record<string, () => { id: string; label: string }[]>> = Object.freeze({
  sounds: () => soundOptions(),
  themes: getThemeList,
});

function resolveSettingOptions(setting: SettingsSetting): SettingsSetting {
  if (!setting.optionsFrom) return setting;
  const catalog = OPTION_CATALOGS[setting.optionsFrom]?.() ?? [];
  return {
    ...setting,
    options: catalog.map((option) => ({ value: option.id, label: option.label })),
  };
}

function isExperimentalBuildPayload(payload: SettingsPayload): boolean {
  return payload.isExperimentalBuild === true;
}

function availableSettingsSections(): readonly SettingsSection[] {
  return settingsSectionsAvailableOn(SETTINGS_REGISTRY.sections, isExperimentalBuildPayload(settingsPayloadSnapshot()));
}

function buildSettingsViewMap(): readonly SettingsSection[] {
  const sections = availableSettingsSections().map((section) => ({
    ...section,
    settings: section.settings.map(resolveSettingOptions),
  }));
  const statusKeyIndex = sections.findIndex((section) => section.id === SHORTCUTS_PAGE_ID) + 1;
  const withStatusKey = [...sections.slice(0, statusKeyIndex), STATUS_KEY_SECTION, ...sections.slice(statusKeyIndex)];
  const firstLaneIndex = withStatusKey.findIndex((section) => section.level === 'lanes');
  return Object.freeze([...withStatusKey.slice(0, firstLaneIndex), FEATURES_SECTION, ...withStatusKey.slice(firstLaneIndex), ABOUT_SECTION]);
}

let SETTINGS_VIEW_MAP = buildSettingsViewMap();
let isSettingsViewMapExperimental = isExperimentalBuildPayload(settingsPayloadSnapshot());

let isAdvancedSettingsExpanded = false;
let isAnimalGalleryExpanded = false;

let rootEl: HTMLElement | null = null;
let settingsViewVisibilityObserver: IntersectionObserver | null = null;
let shellEl: HTMLDivElement | null = null;
let navigationEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let phoneSectionId: string | null = null;
let backButtonEl: HTMLButtonElement | null = null;
let contentEl: HTMLDivElement | null = null;
let selectedPage: SettingsSection = SETTINGS_VIEW_MAP[0];
let settingsPayload: SettingsPayload = settingsPayloadSnapshot();
let storedValues: SettingsValues = {};
const saveStatusById = new Map<string, SaveStatus>();
const savedStatusTimerById = new Map<string, number>();
const pendingSaveById = new Map<string, unknown>();
const draftByControl = new WeakMap<Element, ControlDraft>();
let saveQueue = Promise.resolve();
const fieldErrorById = new Map<string, string>();
let searchQuery = '';
let isAutoUpdateCheckAwaitingStatus = false;
const pendingWorkflowRuleIds = new Set<string>();
type WorkflowRuleFeedback = { tone: 'ok' | 'error'; text: string };

const workflowRuleFeedbackById = new Map<string, WorkflowRuleFeedback>();

function browserPreferences() {
  return {
    themeId: getThemeId(),
    flyingAnimalsEnabled: isFlyingAnimalsEnabled(),
    ...getFlyingAnimalsEnteredValues(),
    soundEnabled: isSoundEnabled(),
    soundId: resolveSoundId(getSoundId()),
    notificationsEnabled: isNotificationsEnabled(),
    sessionUsageChips: isSessionUsageChips(),
    phoneArrowPad: isPhoneArrowPad(),
    nextAttentionKeyCode: getNextAttentionKeyCode(),
  };
}

function hydrate(payload: SettingsPayload) {
  storedValues = hydrateFromSettings(SETTINGS_VIEW_MAP, { ...payload, prefs: browserPreferences() });
}

function storedValue(setting: SettingsSetting): unknown {
  if (pendingSaveById.has(setting.id)) return pendingSaveById.get(setting.id);
  return storedValues[setting.path];
}

function pageParts(page: SettingsSection): SettingsSection[] {
  return [page, ...childSectionsOf(SETTINGS_VIEW_MAP, page.id)];
}

function pageSettings(page: SettingsSection): SettingsSetting[] {
  return pageParts(page).flatMap((part) => part.settings);
}

function sectionOfSetting(setting: SettingsSetting): SettingsSection {
  return SETTINGS_VIEW_MAP.find((section) => section.settings.some((entry) => entry.id === setting.id)) ?? selectedPage;
}

function replaceSettingsHash(sectionId: string, settingId: string | null = null) {
  history.replaceState(history.state, '', settingsHash(sectionId, settingId));
}

function flashSetting(settingId: string) {
  requestAnimationFrame(() => {
    const heading = document.getElementById(settingId);
    const panel = heading?.closest<HTMLElement>('.settings-view-advanced-panel');
    if (panel) {
      isAdvancedSettingsExpanded = true;
      panel.hidden = false;
      contentEl?.querySelector('.settings-view-advanced-toggle')?.setAttribute('aria-expanded', 'true');
    }
    const row = heading?.closest('.settings-view-setting');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('settings-view-setting-flash');
    requestAnimationFrame(() => row.classList.add('settings-view-setting-flash'));
  });
}

function renderShortcutGroups(container: HTMLElement) {
  container.replaceChildren();
  for (const group of shortcutGroupsFor(SHORTCUT_PLATFORM, currentNextAttentionKeyCode())) {
    const groupEl = el('div', 'shortcut-group');
    groupEl.appendChild(el('h2', 'settings-view-subsection-title', group.title));
    const rows = el('dl', 'shortcut-rows');
    for (const item of group.items) {
      const keys = el('dd', 'shortcut-keys');
      item.combos.forEach((chord, chordIndex) => {
        if (chordIndex > 0) keys.appendChild(el('span', 'shortcut-sep', '/'));
        appendShortcutChord(keys, chord);
      });
      rows.append(el('dt', 'shortcut-label', item.label), keys);
    }
    groupEl.appendChild(rows);
    container.appendChild(groupEl);
  }
}

function featureTabLabel(rule: FeatureSurfaceRule) {
  return settingsFeatureTabViews().find((view) => view.gate !== undefined && 'fromSettings' in view.gate && view.gate.fromSettings === rule)?.label;
}

function renderFeatureList(container: HTMLElement) {
  const list = el('ul', 'settings-view-stack settings-features');
  for (const surface of OPTIONAL_FEATURE_SURFACES) {
    const section = SETTINGS_VIEW_MAP.find((entry) => entry.id === surface.sectionId);
    const enableSetting = settingById(surface.settingId);
    const tabLabel = featureTabLabel(FEATURE_SURFACE_RULES[surface.rule]);
    if (!section || !enableSetting || !tabLabel) continue;
    const isOn = storedValue(enableSetting) === true;
    const item = el('li', 'settings-feature');
    const head = el('div', 'settings-feature-head');
    head.append(el('span', 'settings-feature-name', tabLabel), buildChip('feature', isOn ? 'On' : 'Off'));
    item.append(head, el('p', 'settings-view-section-description', section.description), createSettingsLink(surface.sectionId, surface.settingId, enableSetting.title));
    list.appendChild(item);
  }
  container.appendChild(list);
}

function websiteUrl(pathname: string): string {
  const url = new URL(pathname, WEBSITE_ORIGIN);
  const { telemetryInstallId } = settingsPayload;
  if (typeof telemetryInstallId === 'string' && telemetryInstallId) url.searchParams.set('gv', telemetryInstallId);
  return url.href;
}

function externalLink(label: string, href: string) {
  const link = el('a', 'settings-about-link', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function renderAbout(container: HTMLElement) {
  const about = el('div', 'settings-about');
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `v${__APP_VERSION__}` : 'version unknown';
  const versionEl = el('span', 'settings-about-version', 'GLIMMERVOID ');
  versionEl.appendChild(el('span', 'settings-about-v', version));
  const links = el('span', 'settings-about-links');
  links.append(
    externalLink('GitHub', `https://github.com/${REPO_SLUG}`),
    externalLink('Changelog', `https://github.com/${REPO_SLUG}/blob/main/CHANGELOG.md`),
    externalLink('Website', websiteUrl('/')),
  );
  about.append(versionEl, links);
  container.appendChild(about);
}

function settingById(settingId: string): SettingsSetting | null {
  return SETTINGS_VIEW_MAP.flatMap((section) => section.settings).find((setting) => setting.id === settingId) ?? null;
}

function syncSoundEnabledValue(enabled: boolean) {
  if (storedValues['pref:soundEnabled'] === enabled) return;
  storedValues['pref:soundEnabled'] = enabled;
  const setting = settingById('alert-sounds-enabled');
  if (setting) refreshRow(setting);
}

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
    const shortcutGroups = contentEl?.querySelector<HTMLElement>('.settings-view-shortcuts');
    if (shortcutGroups) renderShortcutGroups(shortcutGroups);
    return;
  }
  if (setting.path === 'pref:themeId') {
    setThemeId(String(value));
    applyTheme(String(value));
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
  if (value === true) ensureNotificationPermission().then(() => refreshRow(setting, { force: true }));
}

function setSaveStatus(setting: SettingsSetting, status: SaveStatus | null) {
  const timer = savedStatusTimerById.get(setting.id);
  if (timer !== undefined) clearTimeout(timer);
  savedStatusTimerById.delete(setting.id);
  if (status) saveStatusById.set(setting.id, status);
  if (!status) saveStatusById.delete(setting.id);
  refreshRowFoot(setting);
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
    refreshRow(setting, { force: true });
    confirmTeamReviewWithoutSkill(setting);
    return;
  }
  if (setting.path.startsWith('pref:')) {
    storedValues[setting.path] = value;
    applyBrowserPreference(setting, value);
    refreshRow(setting);
    markSaved(setting);
    return;
  }
  if (pendingSaveById.has(setting.id) && JSON.stringify(pendingSaveById.get(setting.id)) === JSON.stringify(value)) return;
  pendingSaveById.set(setting.id, value);
  setSaveStatus(setting, { tone: 'saving', text: 'Saving' });
  saveQueue = saveQueue.then(() => saveMachineSetting(setting, value));
}

async function saveMachineSetting(setting: SettingsSetting, value: unknown) {
  const settings = settingSavePayload(SETTINGS_VIEW_MAP, storedValues, setting, value);
  if (Object.keys(settings).length === 0) {
    pendingSaveById.delete(setting.id);
    setSaveStatus(setting, null);
    refreshRow(setting);
    return;
  }
  setSaveStatus(setting, { tone: 'saving', text: 'Saving' });
  try {
    const message = await sendControlRequest('update-settings', { settings });
    if (pendingSaveById.get(setting.id) === value) pendingSaveById.delete(setting.id);
    if (message.type === 'settings-error') {
      setSaveStatus(setting, { tone: 'error', text: String(message.message) });
      refreshRow(setting, { force: true });
      return;
    }
    if (message.type !== 'settings-updated') {
      setSaveStatus(setting, { tone: 'error', text: 'The server did not confirm the save.' });
      refreshRow(setting, { force: true });
      return;
    }
    applySettingsBroadcast(message.settings);
    markSaved(setting);
  } catch (error) {
    if (pendingSaveById.get(setting.id) === value) pendingSaveById.delete(setting.id);
    setSaveStatus(setting, { tone: 'error', text: (error as Error)?.message || 'Failed to save the setting.' });
    refreshRow(setting, { force: true });
  }
}

function setFieldError(setting: SettingsSetting, error: string | null) {
  if (error) fieldErrorById.set(setting.id, error);
  if (!error) fieldErrorById.delete(setting.id);
  refreshRowFoot(setting);
}

function inputMinimum(setting: SettingsSetting, range: SettingsRange) {
  if (!range.exclusiveMin) return range.min;
  if (setting.integer === false) return undefined;
  return range.min + 1;
}

function toggleStateText(isOn: boolean) {
  return isOn ? 'On' : 'Off';
}

function renderToggle(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-toggle-wrap');
  const input = el('input', 'settings-view-switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = storedValue(setting) === true;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    input.checked = false;
    input.disabled = true;
  }
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('change', () => {
    const next = input.checked;
    if (needsDangerConfirmation(setting, next)) {
      input.checked = false;
      openConfirmDialog({
        title: setting.title,
        message: setting.warning ?? '',
        confirmLabel: 'Turn on',
        danger: true,
        onConfirm: () => commitSetting(setting, true),
      });
      return;
    }
    commitSetting(setting, next);
  });
  wrapper.appendChild(input);
  return wrapper;
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

function attachSuggestions(setting: SettingsSetting, input: HTMLInputElement) {
  if (!setting.suggestionsFrom) return;
  const environment = readTeamReviewEnvironment(settingsPayload.teamReviewEnvironment);
  if (environment?.agents.length === 0) requestTeamReviewEnvironmentOnce();
  const suggestions = teamReviewSuggestions(setting.suggestionsFrom, environment, storedValues);
  const listId = `${setting.id}-suggestions`;
  document.getElementById(listId)?.remove();
  const datalist = el('datalist');
  datalist.id = listId;
  for (const suggestion of suggestions) {
    const option = el('option');
    option.value = suggestion.value;
    option.label = suggestion.label;
    datalist.appendChild(option);
  }
  document.body.appendChild(datalist);
  input.setAttribute('list', listId);
  input.placeholder = 'Agent default';
  if (setting.suggestionsFrom === 'review-skills') input.placeholder = 'No skill';
}

function renderShortcutKey(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-shortcut-key');
  const chord = buildShortcutKeys(shortcutChord('next-attention', SHORTCUT_PLATFORM, String(storedValue(setting))));
  const record = el('button', 'btn-dialog btn-dialog-cancel', 'Record');
  record.type = 'button';
  const prompt = el('span', 'settings-view-shortcut-key-prompt');
  prompt.setAttribute('role', 'status');
  record.addEventListener('click', () => recordShortcutKey(setting, wrapper, record, prompt));
  wrapper.append(chord, record, prompt);
  return wrapper;
}

function recordShortcutKey(setting: SettingsSetting, row: HTMLElement, record: HTMLButtonElement, prompt: HTMLElement) {
  const stopRecording = () => {
    window.removeEventListener('keydown', onRecordingKeydown, true);
    window.removeEventListener('pointerdown', onLeavingRow, true);
    window.removeEventListener('focusin', onLeavingRow, true);
    record.disabled = false;
    prompt.textContent = '';
  };
  const onLeavingRow = (event: Event) => {
    if (event.target instanceof Node && row.contains(event.target)) return;
    stopRecording();
  };
  const onRecordingKeydown = (event: KeyboardEvent) => {
    if (!record.isConnected || !record.checkVisibility()) {
      stopRecording();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const outcome = recordNextAttentionKey(event, SHORTCUT_PLATFORM);
    if (outcome.kind === 'ignored') return;
    if (outcome.kind === 'refused') {
      setFieldError(setting, outcome.reason);
      return;
    }
    stopRecording();
    setFieldError(setting, null);
    record.focus();
    if (outcome.kind === 'recorded') commitSetting(setting, outcome.keyCode);
  };
  setFieldError(setting, null);
  record.disabled = true;
  prompt.textContent = 'Press the new shortcut, or Esc to cancel.';
  window.addEventListener('keydown', onRecordingKeydown, true);
  window.addEventListener('pointerdown', onLeavingRow, true);
  window.addEventListener('focusin', onLeavingRow, true);
}

function bindDraftCommit(input: HTMLInputElement, commitDraft: () => void, restoreDraft: () => void) {
  input.addEventListener('blur', commitDraft);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    restoreDraft();
  });
}

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && ['text', 'number', 'password'].includes(element.type);
}

function trackDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement) {
  draftByControl.set(field, { base: storedValue(setting), isDirty: false });
  field.addEventListener('input', () => {
    const draft = draftByControl.get(field);
    if (draft) draft.isDirty = true;
  });
}

function restoreFieldDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement, storedText: string) {
  if (field.value !== storedText) field.value = storedText;
  draftByControl.set(field, { base: storedValue(setting), isDirty: false });
  setFieldError(setting, null);
}

function commitFieldDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement, storedText: string, isUnparsable = false) {
  const draft = draftByControl.get(field);
  if (!draft) return;
  const decision = draftCommitOf(SETTINGS_VIEW_MAP, setting, draft, field.value, storedValues, isUnparsable);
  if (decision.kind === 'invalid') {
    setFieldError(setting, decision.error);
    return;
  }
  if (decision.kind === 'unchanged') {
    restoreFieldDraft(setting, field, storedText);
    return;
  }
  if (needsDangerConfirmation(setting, decision.value)) {
    restoreFieldDraft(setting, field, storedText);
    openConfirmDialog({
      title: setting.title,
      message: setting.warning ?? '',
      confirmLabel: 'Save',
      danger: true,
      onConfirm: () => commitSetting(setting, decision.value),
    });
    return;
  }
  draftByControl.set(field, { base: decision.value, isDirty: false });
  commitSetting(setting, decision.value);
}

function renderInput(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  input.type = setting.control === 'password' ? 'password' : 'text';
  const stored = () => String(storedValue(setting) ?? '');
  input.value = stored();
  if (setting.control === 'password') {
    input.value = '';
    input.placeholder = stored() ? 'Configured' : 'Not configured';
  }
  const environmentSource = secretEnvironmentSource(setting, settingsPayload);
  if (environmentSource) {
    input.disabled = true;
    input.setAttribute('aria-description', `Supplied by ${environmentSource}`);
  }
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-labelledby', setting.id);
  attachSuggestions(setting, input);
  trackDraft(setting, input);
  const commitInputDraft = () => {
    if (setting.control === 'password') {
      const secret = input.value;
      if (secret === '') return;
      restoreFieldDraft(setting, input, '');
      commitSetting(setting, secret);
      return;
    }
    commitFieldDraft(setting, input, stored());
  };
  bindDraftCommit(input, commitInputDraft, () => restoreFieldDraft(setting, input, setting.control === 'password' ? '' : stored()));
  return input;
}

function renderNumber(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  const range = displayRange(setting);
  input.type = 'number';
  const stored = () => numberDraftOf(storedValue(setting));
  input.value = stored();
  input.step = setting.integer === false ? String(setting.step ?? 'any') : '1';
  const minimum = range ? inputMinimum(setting, range) : undefined;
  if (minimum != null) input.min = String(minimum);
  if (range?.max != null) input.max = String(range.max);
  input.autocomplete = 'off';
  input.setAttribute('aria-labelledby', setting.id);
  trackDraft(setting, input);
  bindDraftCommit(input, () => commitFieldDraft(setting, input, stored(), input.validity.badInput), () => restoreFieldDraft(setting, input, stored()));
  const unitLabel = setting.unit?.label;
  if (!unitLabel) return input;
  const field = el('div', 'settings-view-number');
  const unit = el('span', 'settings-view-unit', unitLabel);
  unit.setAttribute('aria-hidden', 'true');
  input.setAttribute('aria-description', unitLabel);
  field.append(input, unit);
  return field;
}

function selectSegment(group: HTMLElement, selectedValue: string) {
  const segments = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const hasSelection = segments.some((segment) => segment.dataset.value === selectedValue);
  for (const [index, segment] of segments.entries()) {
    const isSelected = segment.dataset.value === selectedValue;
    segment.setAttribute('aria-checked', String(isSelected));
    segment.tabIndex = isSelected || (!hasSelection && index === 0) ? 0 : -1;
  }
}

function chooseSegment(setting: SettingsSetting, group: HTMLElement, value: string) {
  if (value === String(storedValue(setting))) return;
  selectSegment(group, value);
  commitSetting(setting, value);
  selectSegment(group, String(storedValue(setting)));
}

function renderSegmented(setting: SettingsSetting) {
  const group = el('div', 'settings-view-segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', setting.id);
  const choices = setting.options ?? [];
  for (const choice of choices) {
    const button = el('button', 'settings-view-segment', choice.label);
    button.type = 'button';
    button.dataset.value = choice.value;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => chooseSegment(setting, group, choice.value));
    group.appendChild(button);
  }
  group.addEventListener('keydown', (event) => {
    const step = SEGMENT_STEP_BY_KEY[event.key];
    if (!step || choices.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, choices.findIndex((choice) => choice.value === String(storedValue(setting))));
    const next = choices[(currentIndex + step + choices.length) % choices.length];
    chooseSegment(setting, group, next.value);
    group.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  });
  selectSegment(group, String(storedValue(setting)));
  return group;
}

function renderSelect(setting: SettingsSetting) {
  const select = el('select', 'settings-view-input');
  select.setAttribute('aria-labelledby', setting.id);
  for (const choice of setting.options ?? []) {
    const option = el('option', null, choice.label);
    option.value = choice.value;
    select.appendChild(option);
  }
  select.value = String(storedValue(setting));
  select.addEventListener('change', () => commitSetting(setting, select.value));
  return select;
}

function listHintText(setting: SettingsSetting, entries: readonly string[]) {
  const format = setting.valueKind === 'posthog-projects'
    ? 'One project id per line, or none. Shift+Enter for a new line.'
    : 'One per line. Shift+Enter for a new line.';
  if (entries.length > 0 || !setting.listEmptyText) return format;
  return `${setting.listEmptyText} ${format}`;
}

function renderList(setting: SettingsSetting) {
  const input = el('textarea', 'settings-view-input settings-view-list-input');
  const storedEntries = () => listValue(storedValue(setting));
  const storedText = () => storedEntries().join('\n');
  input.rows = 3;
  input.value = storedText();
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = setting.listPlaceholder ?? '';
  input.setAttribute('aria-labelledby', setting.id);
  trackDraft(setting, input);
  input.addEventListener('blur', () => commitFieldDraft(setting, input, storedText()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      restoreFieldDraft(setting, input, storedText());
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    commitFieldDraft(setting, input, storedText());
  });
  const wrapper = el('div', 'settings-view-list');
  wrapper.append(input, el('span', 'settings-view-list-hint', listHintText(setting, storedEntries())));
  return wrapper;
}

let lastTabOrderMoveKey: string | null = null;
let draggedTabOrderViewId: string | null = null;

function renderTabOrder(setting: SettingsSetting) {
  const featureTabViews = settingsFeatureTabViews();
  const labelByViewId = new Map(featureTabViews.map((view) => [view.view, view.label]));
  const orderedViewIds = orderViewIds(featureTabViews.map((view) => view.view), listValue(storedValue(setting)));
  const list = el('ol', 'settings-view-tab-order');
  list.setAttribute('aria-labelledby', setting.id);
  for (const [index, viewId] of orderedViewIds.entries()) {
    const label = labelByViewId.get(viewId) ?? viewId;
    const item = el('li', 'settings-view-tab-order-item');
    const grip = el('span', 'settings-view-tab-order-grip');
    grip.setAttribute('aria-hidden', 'true');
    grip.appendChild(createLineIcon(GRIP_ICON_PATH, '2.4'));
    item.append(
      grip,
      el('span', 'settings-view-tab-order-label', label),
      buildTabOrderMove(setting, orderedViewIds, viewId, index - 1, 'up', `Move ${label} up`),
      buildTabOrderMove(setting, orderedViewIds, viewId, index + 1, 'down', `Move ${label} down`),
    );
    makeTabOrderItemDraggable(setting, item, orderedViewIds, viewId, index);
    list.append(item);
  }
  return list;
}

function makeTabOrderItemDraggable(setting: SettingsSetting, item: HTMLElement, orderedViewIds: readonly string[], viewId: string, index: number) {
  item.draggable = true;
  item.addEventListener('dragstart', (event) => {
    draggedTabOrderViewId = viewId;
    event.dataTransfer?.setData('text/plain', viewId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => { draggedTabOrderViewId = null; });
  item.addEventListener('dragover', (event) => {
    if (!draggedTabOrderViewId || draggedTabOrderViewId === viewId) return;
    event.preventDefault();
    item.dataset.dropTarget = orderedViewIds.indexOf(draggedTabOrderViewId) < index ? 'after' : 'before';
  });
  item.addEventListener('dragleave', () => delete item.dataset.dropTarget);
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    delete item.dataset.dropTarget;
    const movedViewId = draggedTabOrderViewId;
    draggedTabOrderViewId = null;
    if (!movedViewId || movedViewId === viewId) return;
    commitSetting(setting, moveViewId(orderedViewIds, movedViewId, index));
  });
}

function buildTabOrderMove(
  setting: SettingsSetting, orderedViewIds: readonly string[], viewId: string, targetIndex: number, direction: 'up' | 'down', accessibleName: string,
) {
  const moveKey = `${viewId}:${direction}`;
  const button = el('button', 'settings-view-tab-order-move');
  button.appendChild(createLineIcon(direction === 'up' ? MOVE_UP_ICON_PATH : MOVE_DOWN_ICON_PATH));
  button.type = 'button';
  button.title = accessibleName;
  button.setAttribute('aria-label', accessibleName);
  button.disabled = targetIndex < 0 || targetIndex >= orderedViewIds.length;
  if (moveKey === lastTabOrderMoveKey) button.dataset.restoresFocus = 'true';
  button.addEventListener('click', () => {
    lastTabOrderMoveKey = moveKey;
    commitSetting(setting, moveViewId(orderedViewIds, viewId, targetIndex));
  });
  return button;
}

function buildUpdateButton(label: string, onClick: () => void, { isPrimary = false, isEnabled = true } = {}) {
  const tone = isPrimary ? 'btn-dialog-confirm' : 'btn-dialog-cancel';
  const button = el('button', `btn-dialog ${tone} settings-update-button`, label);
  button.type = 'button';
  button.disabled = !isEnabled;
  button.addEventListener('click', onClick);
  return button;
}

function buildUpdateActionStatus(reason: string | null) {
  const status = el('span', 'settings-update-action-status', reason ?? '');
  status.setAttribute('role', 'status');
  return status;
}

function updateCheckStatusText(): string | null {
  const { isCheckInFlight, checkSendFailure } = settingsUpdateState();
  if (isCheckInFlight) return 'Checking for updates.';
  return checkSendFailure;
}

function checkUpdatesIfStale() {
  const { status: updateStatus, lastAutoCheckAt } = settingsUpdateState();
  if (!updateStatus) {
    isAutoUpdateCheckAwaitingStatus = true;
    return;
  }
  isAutoUpdateCheckAwaitingStatus = false;
  const isStale = shouldAutoCheckUpdates({
    status: updateStatus,
    checkForUpdates: settingsPayload.checkForUpdates,
    now: Date.now(),
    lastAutoCheckAt,
  });
  if (isStale) requestUpdateCheck();
}

function buildUpdateAction(action: UpdateActionId) {
  if (action === 'update') return buildUpdateButton('Update', requestUpdateApply, { isPrimary: true });
  if (action === 'restart') return buildUpdateButton('Restart', restartServer, { isPrimary: true });
  return buildUpdateButton('Check for updates', requestUpdateCheck, { isEnabled: !settingsUpdateState().isCheckInFlight });
}

function buildUpdateActions() {
  const { status, journal, request } = settingsUpdateState();
  const decided = updateControls({ status, journal, request });
  const actions = el('div', 'settings-update-actions');
  if (decided.actions.length > 0) {
    const buttons = el('div', 'settings-update-buttons');
    buttons.append(...decided.actions.map(buildUpdateAction));
    actions.appendChild(buttons);
  }
  const checkStatusText = updateCheckStatusText();
  if (checkStatusText) actions.appendChild(buildUpdateActionStatus(checkStatusText));
  if (decided.note) actions.appendChild(buildUpdateActionStatus(decided.note));
  if (decided.command) actions.appendChild(el('code', 'settings-update-command', decided.command));
  return actions;
}

function buildUpdateFact(label: string, ...content: (string | HTMLElement)[]) {
  const row = el('div', 'settings-update-fact');
  row.append(el('span', 'settings-update-fact-label', label), ...content);
  return row;
}

function buildUpdateProgress() {
  const projection = projectUpdateProgress(settingsUpdateState().journal);
  if (!projection) return null;
  const panel = el('div', 'settings-update-progress');
  panel.dataset.state = projection.state;
  panel.setAttribute('role', 'status');
  const isFailed = projection.state === 'failed';
  if (projection.terminalLine) panel.appendChild(el('div', isFailed ? 'dialog-error' : 'settings-update-terminal', projection.terminalLine));
  const record = isFailed ? buildUpdateFailureDetails(panel, projection.failureDetail) : panel;
  const list = el('ol', 'settings-update-steps');
  for (const step of projection.steps) {
    const item = el('li', 'settings-update-step');
    item.dataset.status = step.status;
    item.append(
      el('span', 'settings-update-step-state', step.status),
      el('span', 'settings-update-step-label', step.label),
    );
    list.appendChild(item);
  }
  record.appendChild(list);
  if (projection.outputTail.length === 0) return panel;
  const output = el('pre', 'settings-update-output', projection.outputTail.join('\n'));
  if (projection.outputStepId) output.dataset.step = projection.outputStepId;
  if (!projection.outputStepLabel) {
    record.appendChild(output);
    return panel;
  }
  const caption = `Output from ${projection.outputStepLabel}`;
  output.setAttribute('aria-label', caption);
  record.append(el('div', 'settings-update-output-label', caption), output);
  return panel;
}

function buildUpdateFailureDetails(panel: HTMLElement, failureDetail: string | null) {
  const details = el('details', 'settings-update-details');
  details.appendChild(el('summary', 'settings-update-details-summary', 'Show details'));
  if (failureDetail) details.appendChild(el('div', 'settings-update-failure-detail', failureDetail));
  panel.appendChild(details);
  return details;
}

function buildLatestUpdateFact() {
  const latest = latestUpdateDetails(settingsUpdateState().status);
  const latestParts: (string | HTMLElement)[] = [latest.label];
  if (latest.releaseUrl) {
    const release = el('a', 'settings-link', 'View release');
    release.href = latest.releaseUrl;
    release.target = '_blank';
    release.rel = 'noopener noreferrer';
    latestParts.push(release);
  }
  return buildUpdateFact('Latest', ...latestParts);
}

function buildUpdateStatusBlock() {
  const block = el('div', 'settings-view-status-block settings-update-status');
  const { status: updateStatus, journal: updateJournal } = settingsUpdateState();
  const summary = updateSummary(updateStatus, updateJournal);
  const headline = el('div', 'settings-update-summary', summary.headline);
  headline.dataset.tone = summary.tone;
  block.appendChild(headline);
  block.appendChild(buildUpdateFact('Running', installedUpdateText(updateStatus)));
  if (shouldShowLatestUpdate(updateStatus)) block.appendChild(buildLatestUpdateFact());
  const lastCheckedAt = typeof updateStatus?.lastCheckAt === 'number' ? updateStatus.lastCheckAt : null;
  const lastChecked = buildUpdateFact('Last checked', lastUpdateCheckText({
    status: updateStatus,
    checkForUpdates: settingsPayload.checkForUpdates,
    relativeTime: formatAgo(lastCheckedAt),
  }));
  if (lastCheckedAt) lastChecked.title = new Date(lastCheckedAt).toLocaleString();
  block.appendChild(lastChecked);
  block.appendChild(buildUpdateActions());
  const progress = buildUpdateProgress();
  if (progress) block.appendChild(progress);
  return block;
}

function resolvabilityLabel(resolvable: boolean | null): string {
  if (resolvable === null) return 'not probed yet';
  if (resolvable) return 'resolved';
  return 'not found on PATH';
}

function customAgentLines(): string[] {
  const rows: CustomAgentSummaryRow[] = Array.isArray(settingsPayload.customAgents) ? settingsPayload.customAgents : [];
  if (rows.length === 0) return ['None declared. Add customAgents to config.json.'];
  return rows.map((row) => {
    const invocation = row.args.length > 0 ? `${row.command} ${row.args.join(' ')}` : row.command;
    return `${row.id}  ${row.label}  ${invocation}  ${resolvabilityLabel(row.resolvable)}`;
  });
}

function buildCustomAgentsStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Declared agents'));
  for (const line of customAgentLines()) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function showWorkflowRuleSaved(ruleId: string) {
  workflowRuleFeedbackById.set(ruleId, { tone: 'ok', text: 'Saved' });
  window.setTimeout(() => {
    if (workflowRuleFeedbackById.get(ruleId)?.tone !== 'ok') return;
    workflowRuleFeedbackById.delete(ruleId);
    refreshSettingsStatus();
  }, SAVED_STATUS_MS);
}

async function saveWorkflowRuleToggle(rule: WorkflowRuleToggleRow, isTurningOn: boolean) {
  pendingWorkflowRuleIds.add(rule.id);
  workflowRuleFeedbackById.delete(rule.id);
  refreshSettingsStatus();
  try {
    const message = await sendControlRequest('update-settings', { settings: { workflows: { rules: [{ id: rule.id, enabled: isTurningOn }] } } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    pendingWorkflowRuleIds.delete(rule.id);
    if (message.type === 'settings-error') workflowRuleFeedbackById.set(rule.id, { tone: 'error', text: String(message.message) });
    if (message.type === 'settings-updated') {
      showWorkflowRuleSaved(rule.id);
      applySettingsBroadcast(message.settings);
      return;
    }
  } catch (error) {
    workflowRuleFeedbackById.set(rule.id, { tone: 'error', text: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) });
  }
  pendingWorkflowRuleIds.delete(rule.id);
  refreshSettingsStatus();
}

function buildWorkflowRuleStatus(rule: WorkflowRuleToggleRow) {
  const status = createActionStatus('settings-workflow-rule-status');
  if (pendingWorkflowRuleIds.has(rule.id)) {
    status.show('busy', 'Saving');
    return status.element;
  }
  const feedback = workflowRuleFeedbackById.get(rule.id);
  if (feedback) status.show(feedback.tone, feedback.text);
  return status.element;
}

function buildWorkflowRuleToggle(rule: WorkflowRuleToggleRow) {
  const row = el('div', 'settings-view-toggle-wrap');
  const label = el('label', 'settings-view-toggle');
  const input = el('input', 'settings-view-checkbox');
  input.type = 'checkbox';
  input.checked = rule.isEnabled;
  input.disabled = pendingWorkflowRuleIds.has(rule.id);
  input.setAttribute('aria-label', `Run rule ${rule.name}`);
  input.addEventListener('change', () => { void saveWorkflowRuleToggle(rule, input.checked); });
  label.append(input, el('span', 'settings-view-toggle-state', toggleStateText(rule.isEnabled)), el('span', 'settings-readonly', `${rule.name}  ${rule.summary}`));
  row.append(label, buildWorkflowRuleStatus(rule));
  return row;
}

function buildWorkflowsStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Rules'));
  const rules = workflowRuleToggleRows(settingsPayload.workflows);
  if (rules.length > 0) {
    for (const rule of rules) block.appendChild(buildWorkflowRuleToggle(rule));
    return block;
  }
  for (const line of workflowRuleSummaryLines(settingsPayload.workflows)) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function buildUsageStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Last report'));
  for (const line of usageStatusLines()) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function buildAgentLoginsStatus() {
  const block = el('div', 'settings-view-status-block');
  if ((pendingSaveById.get('remote-sessions') ?? storedValues.remoteSessions) !== true) {
    block.appendChild(el('div', 'settings-readonly', 'Turn on Remote Coder sessions to connect agent logins for them.'));
    return block;
  }
  for (const agent of ['claude-code', 'codex'] as const) {
    const row = el('div', 'settings-telegram-test');
    const connectButton = el('button', 'btn-dialog btn-dialog-cancel', 'Connect');
    connectButton.type = 'button';
    connectButton.addEventListener('click', () => openAgentConnectDialog(agent));
    row.append(el('div', 'settings-readonly', agentLoginSummary(agentLoginOf(agent), agent)), connectButton);
    block.appendChild(row);
  }
  return block;
}

function buildRemoteSetupStatus() {
  const block = el('div', 'settings-view-status-block');
  const setupButton = el('button', 'btn-dialog btn-dialog-cancel', 'Set up remote host');
  setupButton.type = 'button';
  setupButton.addEventListener('click', openRemoteSetupDialog);
  block.appendChild(setupButton);
  return block;
}

function renderReadout(setting: SettingsSetting) {
  if (setting.status === 'agent-logins') return buildAgentLoginsStatus();
  if (setting.status === 'remote-setup') return buildRemoteSetupStatus();
  if (setting.status === 'update-actions') return buildUpdateStatusBlock();
  if (setting.status === 'custom-agents') return buildCustomAgentsStatus();
  if (setting.status === 'workflows') return buildWorkflowsStatus();
  return el('div', 'settings-readonly', 'Not available');
}

function renderControl(setting: SettingsSetting) {
  if (setting.control === 'readonly') return renderReadout(setting);
  if (setting.control === 'toggle') return renderToggle(setting);
  if (setting.control === 'number') return renderNumber(setting);
  if (setting.control === 'select') return choicePresentation(setting) === 'segmented' ? renderSegmented(setting) : renderSelect(setting);
  if (setting.control === 'list') return renderList(setting);
  if (setting.control === 'shortcut-key') return renderShortcutKey(setting);
  if (setting.control === 'tab-order') return renderTabOrder(setting);
  return renderInput(setting);
}

function statusText(setting: SettingsSetting) {
  const environmentSource = secretEnvironmentSource(setting, settingsPayload);
  if (environmentSource) return `Supplied by ${environmentSource}. Change the server environment and restart to replace this credential.`;
  return '';
}

function buildStatusSlot(setting: SettingsSetting) {
  if (setting.control === 'readonly') return null;
  if (setting.status === 'usage-last-report') {
    const block = buildUsageStatus();
    block.classList.add('settings-view-status-slot');
    return block;
  }
  if (setting.id === 'desktop-notifications') return buildNotificationPermissionSlot(setting);
  if (setting.id === 'telemetry-enabled') return buildTelemetryDataSlot();
  if (setting.status === 'telegram-delivery') return buildTelegramDeliverySlot();
  const status = statusText(setting);
  if (!status) return null;
  return el('div', 'settings-view-warning settings-view-status-slot', status);
}

function telegramDeliveryLines(): string[] {
  const parsedDelivery = TelegramDeliveryStatus.safeParse(settingsPayload.telegramDelivery);
  if (!parsedDelivery.success) return [];
  const { setupWarning, lastFailure } = parsedDelivery.data;
  const lines = setupWarning ? [setupWarning] : [];
  if (lastFailure) lines.push(`The last Telegram send failed at ${new Date(lastFailure.failedAt).toLocaleString()}: ${lastFailure.message}`);
  return lines;
}

function renderTelegramDeliveryLines(container: HTMLElement) {
  container.replaceChildren(...telegramDeliveryLines().map((line) => el('p', 'settings-view-warning', line)));
}

function buildTelegramDeliverySlot() {
  const slot = el('div', 'settings-view-status-slot settings-telegram-delivery');
  const deliveryLines = el('div', 'settings-telegram-delivery-lines');
  renderTelegramDeliveryLines(deliveryLines);
  const testButton = el('button', 'btn-dialog btn-dialog-cancel', 'Send test message');
  testButton.type = 'button';
  const testStatus = createActionStatus('settings-telegram-test-status');
  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    const reply = await requestWithStatus('telegram-test', {}, testStatus, { busyText: 'Sending a test message to Telegram.' });
    testButton.disabled = false;
    if (reply?.type !== 'telegram-test-result') return;
    settingsPayload = mergeSettingsPayload({ telegramDelivery: reply.telegramDelivery });
    renderTelegramDeliveryLines(deliveryLines);
    if (reply.ok) {
      testStatus.show('ok', 'Sent. Check the Telegram chat for the test message.');
      return;
    }
    testStatus.show('error', `Not sent: ${reply.error ?? 'Telegram refused the message.'}`);
  });
  const testRow = el('div', 'settings-telegram-test');
  testRow.append(testButton, testStatus.element);
  slot.append(deliveryLines, testRow);
  return slot;
}

async function requestTelemetryDeletion() {
  telemetryDeletionButton.disabled = true;
  const reply = await requestWithStatus('request-telemetry-deletion', {}, telemetryDeletionStatus, {
    busyText: 'Sending the deletion request.', timeoutMs: TELEMETRY_DELETION_TIMEOUT_MS,
  });
  telemetryDeletionButton.disabled = false;
  if (reply?.type !== 'telemetry-deletion-result') return;
  if (reply.ok) {
    telemetryDeletionStatus.show('ok', 'Deletion requested. New usage starts under a new id.');
    return;
  }
  telemetryDeletionStatus.show('error', 'Not sent: PostHog did not take the request. Try again later.');
}

const telemetryDeletionButton = el('button', 'btn-dialog btn-dialog-cancel', 'Delete my data');
telemetryDeletionButton.type = 'button';
telemetryDeletionButton.addEventListener('click', () => {
  openConfirmDialog({
    title: 'Delete your usage data?',
    message: 'We delete everything collected under this install. New usage starts under a new id.',
    confirmLabel: 'Delete my data',
    danger: true,
    onConfirm: () => { void requestTelemetryDeletion(); },
  });
});
const telemetryDeletionStatus = createActionStatus('settings-telemetry-deletion-status');

function buildTelemetryDataSlot() {
  const slot = el('div', 'settings-view-status-slot settings-telemetry-data');
  slot.append(externalLink('Privacy details', websiteUrl('/privacy')), telemetryDeletionButton, telemetryDeletionStatus.element);
  return slot;
}

function buildNotificationPermissionSlot(setting: SettingsSetting) {
  const permissionControl = createNotificationPermissionControl(() => refreshRow(setting, { force: true }));
  if (permissionControl.element.hidden) return null;
  permissionControl.element.classList.add('settings-view-status-slot');
  return permissionControl.element;
}

function buildExperimentalTag() {
  return el('span', 'settings-view-experimental-tag', 'Experimental');
}

function buildChip(kind: string, text: string) {
  const chip = el('span', 'settings-view-chip', text);
  chip.dataset.chip = kind;
  return chip;
}

function clipboardCopyStatus(text: string, copiedText: string): Promise<string> {
  const write = writeClipboardText(text);
  if (!write) return Promise.resolve('Copy failed');
  return write.then(() => copiedText, () => 'Copy failed');
}

function appendCopyControl(
  container: HTMLElement, button: HTMLButtonElement, { copiedText, textToCopy }: { copiedText: string; textToCopy: () => string },
) {
  const status = el('span', 'settings-view-copy-status');
  status.setAttribute('role', 'status');
  button.type = 'button';
  button.addEventListener('click', async () => {
    status.textContent = await clipboardCopyStatus(textToCopy(), copiedText);
    setTimeout(() => { status.textContent = ''; }, COPY_STATUS_MS);
  });
  container.append(button, status);
}

function renderSettingHeading(setting: SettingsSetting) {
  const row = el('div', 'settings-view-setting-heading');
  const section = sectionOfSetting(setting);
  const heading = el('h2', 'settings-view-setting-title', setting.title);
  heading.id = setting.id;
  if (isExperimentalSetting(setting) && !isExperimentalSection(pageSectionOf(SETTINGS_VIEW_MAP, section.id) ?? section)) heading.append(' ', buildExperimentalTag());
  heading.addEventListener('click', () => replaceSettingsHash(section.id, setting.id));
  const copy = el('button', 'settings-view-copy-link', '#');
  copy.setAttribute('aria-label', 'Copy link');
  row.appendChild(heading);
  appendCopyControl(row, copy, {
    copiedText: 'Link copied',
    textToCopy: () => new URL(settingsHash(section.id, setting.id), location.href).href,
  });
  return row;
}

function pageScopeOfSetting(setting: SettingsSetting) {
  const page = pageSectionOf(SETTINGS_VIEW_MAP, sectionOfSetting(setting).id);
  return page ? pageScopeOf(pageSettings(page)) : null;
}

function renderChips(setting: SettingsSetting, pageScope: SettingsSetting['scope'] | null) {
  const chips = el('div', 'settings-view-chips');
  for (const chip of rowChipsOf(setting, pageScope)) chips.appendChild(buildChip(chip.kind, chip.text));
  return chips;
}

function canReset(setting: SettingsSetting) {
  if (setting.control === 'readonly') return false;
  if (secretEnvironmentSource(setting, settingsPayload)) return false;
  return !isAtDefault(setting, storedValue(setting));
}

function renderControlFoot(setting: SettingsSetting) {
  const foot = el('div', 'settings-view-control-foot');
  const status = el('span', 'settings-view-save-status');
  status.setAttribute('role', 'status');
  const reset = el('button', 'settings-view-reset', 'Reset');
  reset.type = 'button';
  reset.title = 'Reset to the default value';
  reset.addEventListener('click', () => {
    const value = resetValueOf(setting);
    const confirmation = resetConfirmationOf(setting);
    if (confirmation !== null) {
      openConfirmDialog({ title: setting.title, message: confirmation, confirmLabel: 'Reset', danger: true, onConfirm: () => commitSetting(setting, value) });
      return;
    }
    commitSetting(setting, value);
  });
  foot.append(status, reset);
  return foot;
}

function applyFootState(row: Element, setting: SettingsSetting) {
  const status = row.querySelector<HTMLElement>('.settings-view-save-status');
  const saveStatus = saveStatusById.get(setting.id);
  if (status) {
    status.textContent = saveStatus?.text ?? '';
    if (saveStatus) status.dataset.tone = saveStatus.tone;
    if (!saveStatus) delete status.dataset.tone;
  }
  const reset = row.querySelector<HTMLButtonElement>('.settings-view-reset');
  if (reset) reset.hidden = !canReset(setting);
  const foot = row.querySelector<HTMLElement>('.settings-view-control-foot');
  if (foot) foot.hidden = !saveStatus && !canReset(setting);
  const existingError = row.querySelector<HTMLElement>('.settings-view-field-error');
  const error = fieldErrorById.get(setting.id);
  if (existingError && !error) existingError.remove();
  if (existingError && error) existingError.textContent = error;
  if (!existingError && error) row.querySelector('.settings-view-setting-control')?.appendChild(el('div', 'settings-view-field-error', error));
}

function renderRow(setting: SettingsSetting) {
  const article = el('article', 'settings-view-setting');
  article.dataset.settingId = setting.id;
  if (setting.control === 'readonly') article.dataset.readout = 'true';
  const text = el('div', 'settings-view-setting-text');
  text.append(renderSettingHeading(setting), el('p', 'settings-view-setting-description', setting.description));
  const chips = renderChips(setting, pageScopeOfSetting(setting));
  if (chips.childElementCount > 0) text.appendChild(chips);
  const control = el('div', 'settings-view-setting-control');
  control.appendChild(renderControl(setting));
  if (setting.control !== 'readonly') control.appendChild(renderControlFoot(setting));
  article.append(text, control);
  if (shouldShowDangerWarning(setting, storedValue(setting))) article.appendChild(el('div', 'settings-view-warning settings-warning', setting.warning));
  const statusSlot = buildStatusSlot(setting);
  if (statusSlot) article.appendChild(statusSlot);
  applyFootState(article, setting);
  return article;
}

function rowOf(setting: SettingsSetting): HTMLElement | null {
  return contentEl?.querySelector<HTMLElement>(`[data-setting-id="${setting.id}"]`) ?? null;
}

function focusControl(row: HTMLElement) {
  const control = row.querySelector<HTMLElement>('.settings-view-setting-control');
  if (!control) return;
  const target = control.querySelector<HTMLElement>('[data-restores-focus="true"]:not([disabled])')
    ?? control.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    ?? control.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
  target?.focus();
}

function refreshFocusedField(current: Element, fresh: Element) {
  if (!isTextField(current) || !isTextField(fresh)) return;
  current.disabled = fresh.disabled;
  current.placeholder = fresh.placeholder;
  const freshDraft = draftByControl.get(fresh);
  if (!freshDraft || hasUnsavedEdit(draftByControl.get(current))) return;
  draftByControl.set(current, { base: freshDraft.base, isDirty: false });
  if (current.value !== fresh.value) current.value = fresh.value;
}

function refreshAroundDraft(current: Element, fresh: Element, focused: Element) {
  if (current === focused) {
    refreshFocusedField(current, fresh);
    return;
  }
  const currentChildren = [...current.children];
  const freshChildren = [...fresh.children];
  for (const [index, child] of freshChildren.entries()) {
    const previous = currentChildren[index];
    if (!previous) {
      current.appendChild(child);
      continue;
    }
    if (previous.contains(focused)) {
      refreshAroundDraft(previous, child, focused);
      continue;
    }
    previous.replaceWith(child);
  }
  for (const child of currentChildren.slice(freshChildren.length)) child.remove();
}

function refreshRow(setting: SettingsSetting, { force = false }: { force?: boolean } = {}) {
  const row = rowOf(setting);
  if (!row) return;
  const focused = document.activeElement;
  const hadFocus = row.contains(focused);
  const focusedField = hadFocus && !force && isTextField(focused) ? focused : null;
  if (!focusedField || !hasUnsavedEdit(draftByControl.get(focusedField))) fieldErrorById.delete(setting.id);
  const next = renderRow(setting);
  if (focusedField) {
    refreshAroundDraft(row, next, focusedField);
    return;
  }
  row.replaceWith(next);
  if (hadFocus) focusControl(next);
}

function refreshRowFoot(setting: SettingsSetting) {
  const row = rowOf(setting);
  if (row) applyFootState(row, setting);
}

function refreshReadout(setting: SettingsSetting) {
  rowOf(setting)?.querySelector('.settings-view-setting-control')?.replaceChildren(renderReadout(setting));
}

function refreshVisibleRows() {
  for (const setting of pageSettings(selectedPage)) {
    if (setting.control === 'readonly') {
      refreshReadout(setting);
      continue;
    }
    refreshRow(setting);
  }
}

function renderFlyingAnimalsReset() {
  const reset = el('button', 'btn-dialog btn-dialog-cancel', 'Reset all to defaults');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    resetFlyingAnimalsAdvanced();
    hydrate(settingsPayload);
    applyFlyingAnimals(isFlyingAnimalsEnabled());
    renderContent();
  });
  return reset;
}

function renderAdvancedSettings(advancedSettings: SettingsSetting[]) {
  const advanced = el('div', 'settings-view-advanced');
  const toggle = el('button', 'dialog-advanced-toggle settings-view-advanced-toggle', 'Advanced');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(isAdvancedSettingsExpanded));
  toggle.setAttribute('aria-controls', 'settings-view-advanced-panel');
  const panel = el('div', 'dialog-advanced-panel settings-view-advanced-panel');
  panel.id = 'settings-view-advanced-panel';
  panel.hidden = !isAdvancedSettingsExpanded;
  toggle.addEventListener('click', () => {
    isAdvancedSettingsExpanded = !isAdvancedSettingsExpanded;
    panel.hidden = !isAdvancedSettingsExpanded;
    toggle.setAttribute('aria-expanded', String(isAdvancedSettingsExpanded));
  });
  for (const setting of advancedSettings) panel.append(renderRow(setting));
  if (selectedPage.id === APPEARANCE_PAGE_ID) panel.append(renderFlyingAnimalsReset());
  advanced.append(toggle, panel);
  return advanced;
}

function renderStreamerPlaceholder(container: HTMLElement) {
  const placeholder = el('div', 'settings-view-streamer-placeholder');
  const turnOff = el('button', 'btn-dialog btn-dialog-confirm', 'Turn off streamer mode');
  turnOff.type = 'button';
  const status = el('span', 'settings-view-copy-status', '');
  status.setAttribute('role', 'status');
  turnOff.addEventListener('click', async () => {
    turnOff.disabled = true;
    status.textContent = '';
    const saveError = await saveStreamerMode(false);
    turnOff.disabled = false;
    status.textContent = saveError;
  });
  placeholder.append(el('p', 'settings-view-section-description', 'Settings are hidden in streamer mode.'), turnOff, status);
  container.appendChild(placeholder);
}

onStreamerModeChanged(() => renderContent());

function renderAnimalGalleryToggle() {
  const disclosure = el('div', 'settings-view-advanced');
  const toggle = el('button', 'dialog-advanced-toggle', 'Animal gallery');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'settings-view-animal-gallery-panel');
  const panel = el('div', 'dialog-advanced-panel settings-view-advanced-panel');
  panel.id = 'settings-view-animal-gallery-panel';
  const showExpandedState = () => {
    toggle.setAttribute('aria-expanded', String(isAnimalGalleryExpanded));
    panel.hidden = !isAnimalGalleryExpanded;
    if (isAnimalGalleryExpanded && panel.childElementCount === 0) panel.append(renderFlyingAnimalsGallery());
  };
  toggle.addEventListener('click', () => {
    isAnimalGalleryExpanded = !isAnimalGalleryExpanded;
    showExpandedState();
  });
  showExpandedState();
  disclosure.append(toggle, panel);
  return disclosure;
}

function renderSubsectionHeader(section: SettingsSection) {
  const header = el('header', 'settings-view-subsection');
  const title = el('h2', 'settings-view-subsection-title', section.title);
  title.addEventListener('click', () => replaceSettingsHash(section.id));
  header.append(title, el('p', 'settings-view-section-description', section.description));
  return header;
}

function renderPart(stack: HTMLElement, part: SettingsSection) {
  for (const setting of part.settings.filter((entry) => entry.access !== 'advanced')) {
    stack.appendChild(renderRow(setting));
    if (setting.id === FLYING_ANIMALS_SETTING_ID) stack.appendChild(renderAnimalGalleryToggle());
  }
  const advancedSettings = part.settings.filter((entry) => entry.access === 'advanced');
  if (advancedSettings.length > 0) stack.append(renderAdvancedSettings(advancedSettings));
}

function renderContent() {
  syncPhoneSettingsScreen();
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  if (!contentEl) return;
  contentEl.textContent = '';
  if (isStreamerMode()) {
    renderStreamerPlaceholder(contentEl);
    return;
  }
  const header = el('header', 'settings-view-section-header');
  const title = el('h1', 'settings-view-section-title', selectedPage.title);
  title.tabIndex = -1;
  title.addEventListener('click', () => replaceSettingsHash(selectedPage.id));
  const titleRow = el('div', 'settings-view-section-title-row');
  titleRow.appendChild(title);
  const isExperimentalPage = isExperimentalSection(selectedPage);
  if (isExperimentalPage) title.append(' ', buildExperimentalTag());
  const pageScope = pageScopeOf(pageSettings(selectedPage));
  if (pageScope) titleRow.appendChild(buildChip('scope', SCOPE_LABELS[pageScope]));
  header.append(titleRow, el('p', 'settings-view-section-description', selectedPage.description));
  if (isExperimentalPage) header.appendChild(el('p', 'settings-view-warning settings-view-experimental-caution', 'Experimental: this may change or break between releases.'));
  contentEl.appendChild(header);

  if (selectedPage.id === SHORTCUTS_PAGE_ID) {
    const stack = el('div', 'settings-view-stack');
    renderPart(stack, selectedPage);
    contentEl.appendChild(stack);
    const groups = el('div', 'shortcut-groups settings-view-shortcuts');
    renderShortcutGroups(groups);
    contentEl.appendChild(groups);
    return;
  }

  if (selectedPage.id === ABOUT_PAGE_ID) {
    renderAbout(contentEl);
    return;
  }

  if (selectedPage.id === STATUS_KEY_PAGE_ID) {
    contentEl.appendChild(renderStatusLegend());
    contentEl.appendChild(renderPrStatusLegend());
    return;
  }

  if (selectedPage.id === FEATURES_PAGE_ID) {
    renderFeatureList(contentEl);
    return;
  }

  const stack = el('div', 'settings-view-stack');
  for (const part of pageParts(selectedPage)) {
    if (part.id !== selectedPage.id) stack.appendChild(renderSubsectionHeader(part));
    renderPart(stack, part);
  }
  contentEl.appendChild(stack);
}

function selectSection(
  sectionId: string,
  { focusContent = false, settingId = null, updateHash = true, openPhoneSection = true }: { focusContent?: boolean; settingId?: string | null; updateHash?: boolean; openPhoneSection?: boolean } = {}
) {
  if (updateHash && searchQuery) {
    searchQuery = '';
    if (searchEl) searchEl.value = '';
  }
  const page = pageSectionOf(SETTINGS_VIEW_MAP, sectionId) ?? selectedPage;
  if (selectedPage.id !== page.id) isAdvancedSettingsExpanded = false;
  selectedPage = page;
  const targetSection = SETTINGS_VIEW_MAP.find((section) => section.id === sectionId) ?? page;
  markCurrentSection(navigationEl);
  if (openPhoneSection && isPhoneLayout()) phoneSectionId = targetSection.id;
  renderContent();
  if (isAlertSoundPage(selectedPage)) reloadCustomSounds();
  if (selectedPage.id === UPDATES_SECTION_ID) checkUpdatesIfStale();
  if (updateHash) replaceSettingsHash(targetSection.id, settingId);
  if (settingId) flashSetting(settingId);
  if (focusContent) contentEl?.querySelector('h1')?.focus();
}

function markCurrentSection(container: Element | null) {
  for (const button of container?.querySelectorAll<HTMLElement>('[data-settings-section]') || []) {
    const selected = button.dataset.settingsSection === selectedPage.id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
}

function hasSection(result: SettingsSearchResult): result is SectionSearchResult {
  return result.section !== null;
}

function chooseSearchResult(searchResult: SectionSearchResult) {
  if (!searchEl) return;
  searchEl.value = '';
  searchQuery = '';
  renderNavigation();
  selectSection(searchResult.section.id, { settingId: searchResult.setting.id });
}

function searchSettings(query: string) {
  return scoreSettingsSearch(availableSettingsSections(), query, SETTINGS_REGISTRY.fileOnly);
}

function highlightedSearchText(
  tag: 'span' | 'p' | 'code', className: string, text: string, result: SettingsSearchResult, field: SettingsSearchMatch['field'],
) {
  const element = el(tag, className);
  const match = result.matches.find((entry) => entry.field === field);
  const offset = match ? text.indexOf(match.text) : -1;
  if (!match || offset < 0) {
    element.textContent = text;
    return element;
  }
  let cursor = 0;
  for (const span of match.spans) {
    element.append(text.slice(cursor, offset + span.start), el('mark', 'settings-view-search-highlight', text.slice(offset + span.start, offset + span.end)));
    cursor = offset + span.end;
  }
  element.append(text.slice(cursor));
  return element;
}

function appendFileOnlyDetails(row: HTMLElement, result: SettingsSearchResult) {
  const { currentText, defaultText, jsonFragment } = fileOnlySearchCard(result.setting, settingsPayload);
  if (currentText !== null) row.appendChild(el('span', 'settings-view-search-current', currentText));
  row.append(
    el('span', 'settings-view-search-default', defaultText),
    renderChips(result.setting, null),
    el('p', 'settings-view-list-hint', 'Edit in config.json or with glimmervoid settings set.'),
  );
  if (jsonFragment === null) return;
  const actions = el('div', 'settings-view-control-foot');
  appendCopyControl(actions, el('button', 'settings-view-copy-json', 'Copy as JSON'), { copiedText: 'JSON copied', textToCopy: () => jsonFragment });
  row.appendChild(actions);
}

function renderSearchContent() {
  if (!contentEl) return;
  contentEl.textContent = '';
  if (isStreamerMode()) {
    renderStreamerPlaceholder(contentEl);
    return;
  }
  const results = searchSettings(searchQuery);
  const header = el('div', 'settings-view-section-header');
  header.append(el('h1', 'settings-view-section-title', 'Settings search'), el('p', 'settings-view-section-description', `${results.length} ${results.length === 1 ? 'result' : 'results'} for "${searchQuery}"`));
  contentEl.appendChild(header);
  if (results.length === 0) {
    contentEl.appendChild(el('p', 'settings-empty settings-view-search-empty', 'No settings found.'));
    return;
  }
  const list = el('ol', 'settings-view-search-results');
  list.setAttribute('aria-label', 'Settings search results');
  for (const result of results) {
    const row = el('li', 'settings-view-search-result');
    row.tabIndex = -1;
    const breadcrumb = settingsSearchBreadcrumb(SETTINGS_VIEW_MAP, result.section, result.setting);
    row.appendChild(highlightedSearchText('p', 'settings-view-search-breadcrumb', breadcrumb, result, 'section'));
    const title = highlightedSearchText('span', 'settings-view-setting-title', result.setting.title, result, 'title');
    if (hasSection(result)) {
      const open = el('button', 'settings-view-search-open');
      open.type = 'button';
      open.appendChild(title);
      open.addEventListener('click', () => chooseSearchResult(result));
      row.appendChild(open);
    }
    if (!hasSection(result)) {
      row.classList.add('settings-view-search-file-only');
      row.appendChild(title);
    }
    row.append(
      highlightedSearchText('p', 'settings-view-setting-description', result.setting.description, result, 'description'),
      highlightedSearchText('code', 'settings-view-key-path', result.setting.path, result, 'path'),
    );
    const visibleFields = new Set(['title', 'description', 'path', 'section']);
    if (!result.matches.some((match) => visibleFields.has(match.field))) {
      const match = result.matches.find((entry) => entry.field === 'options') ?? result.matches.find((entry) => entry.field === 'keywords');
      if (match) row.appendChild(highlightedSearchText('p', 'settings-view-list-hint', match.text, result, match.field));
    }
    if (!hasSection(result)) appendFileOnlyDetails(row, result);
    list.appendChild(row);
  }
  contentEl.appendChild(list);
}

function currentPhoneSettingsScreen() {
  return phoneSettingsScreenOf(SETTINGS_VIEW_MAP, phoneSectionId, searchQuery, isStreamerMode());
}

function syncPhoneSettingsScreen() {
  if (!shellEl) return;
  const screen = currentPhoneSettingsScreen();
  const hasScreenChanged = shellEl.dataset.settingsScreen !== screen;
  shellEl.dataset.settingsScreen = screen;
  if (backButtonEl) backButtonEl.hidden = screen !== 'section';
  if (!hasScreenChanged) return;
  notifyPhoneSettingsScreenChanged();
}

function returnToList() {
  const previousPageId = selectedPage.id;
  setSearchQuery('');
  navigationEl?.querySelector<HTMLElement>(`[data-settings-section="${previousPageId}"]`)?.focus();
}

function renderNavigation() {
  if (!navigationEl || !shellEl) return;
  navigationEl.textContent = '';
  for (const navigationGroup of settingsNavigationGroupsOf(topLevelSectionsOf(SETTINGS_VIEW_MAP))) {
    const group = el('div', 'settings-view-nav-group');
    if (navigationGroup.heading) group.appendChild(el('div', 'settings-view-nav-heading', navigationGroup.heading));
    for (const section of navigationGroup.sections) {
      const button = el('button', 'settings-view-nav-item', section.title);
      button.type = 'button';
      if (isExperimentalSection(section)) button.append(' ', buildExperimentalTag());
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => selectSection(section.id, { focusContent: isPhoneLayout() }));
      group.appendChild(button);
    }
    navigationEl.appendChild(group);
  }
  if (searchQuery) {
    syncPhoneSettingsScreen();
    renderSearchContent();
    return;
  }
  selectSection(selectedPage.id, { updateHash: false, openPhoneSection: false });
}

function setSearchQuery(query: string, { updateHash = true } = {}) {
  searchQuery = query.trim();
  if (searchEl) searchEl.value = query;
  phoneSectionId = null;
  if (updateHash) history.replaceState(history.state, '', settingsSearchHash(searchQuery));
  renderNavigation();
}

function handleNavigationKeydown(event: KeyboardEvent) {
  if (searchQuery && event.key === 'Enter' && event.target === searchEl) {
    const first = searchSettings(searchQuery).find(hasSection);
    if (!first) return;
    event.preventDefault();
    chooseSearchResult(first);
    return;
  }
  if (event.key === 'Escape' && searchQuery) {
    if (!searchEl) return;
    event.preventDefault();
    setSearchQuery('');
    searchEl.focus();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (!navigationEl) return;
  const buttons = [...navigationEl.querySelectorAll('[data-settings-section]')]
    .filter((button): button is HTMLElement => button instanceof HTMLElement);
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  const currentIndex = buttons.indexOf(activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}

function mountSettingsView(container: HTMLElement) {
  onSoundEnabledChange(syncSoundEnabledValue);
  rootEl = container;
  rootEl.textContent = '';
  shellEl = el('div', 'settings-view-shell');
  const sidebar = el('div', 'settings-view-sidebar');
  searchEl = el('input', 'settings-view-search');
  searchEl.type = 'search';
  searchEl.placeholder = 'Search settings';
  searchEl.setAttribute('aria-label', 'Search settings');
  navigationEl = el('nav', 'settings-view-nav');
  navigationEl.setAttribute('role', 'navigation');
  navigationEl.setAttribute('aria-label', 'Settings sections');
  backButtonEl = el('button', 'settings-view-back', 'Settings');
  backButtonEl.prepend(createLineIcon(BACK_ICON_PATH));
  backButtonEl.type = 'button';
  backButtonEl.hidden = true;
  backButtonEl.setAttribute('aria-label', 'Back to settings sections');
  backButtonEl.addEventListener('click', returnToSettingsList);
  contentEl = el('div', 'settings-view-content');
  contentEl.setAttribute('aria-live', 'polite');
  searchEl.addEventListener('input', () => {
    const currentSearchEl = searchEl;
    if (!currentSearchEl) return;
    setSearchQuery(currentSearchEl.value);
  });
  searchEl.addEventListener('keydown', handleNavigationKeydown);
  navigationEl.addEventListener('keydown', handleNavigationKeydown);
  sidebar.append(searchEl, backButtonEl, navigationEl);
  shellEl.append(sidebar, contentEl);
  rootEl.appendChild(shellEl);
  settingsPayload = settingsPayloadSnapshot();
  syncSettingsViewMapToBuild();
  hydrate(settingsPayload);
  setPhoneSettingsScreenProbe(currentPhoneSettingsScreen);
  subscribeSettings(applySettingsChange);
  renderNavigation();
  reloadCustomSounds();
  settingsViewVisibilityObserver?.disconnect();
  settingsViewVisibilityObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) reloadCustomSounds();
  });
  settingsViewVisibilityObserver.observe(rootEl);
  activatePendingSection();
}

function reloadCustomSounds() {
  void loadCustomSounds().then(refreshSoundOptions);
}

function isAlertSoundPage(page: SettingsSection) {
  return pageSettings(page).some((setting) => setting.path === 'pref:soundId');
}

function rebuildSettingsViewMap() {
  SETTINGS_VIEW_MAP = buildSettingsViewMap();
  isSettingsViewMapExperimental = isExperimentalBuildPayload(settingsPayloadSnapshot());
  selectedPage = pageSectionOf(SETTINGS_VIEW_MAP, selectedPage.id) ?? SETTINGS_VIEW_MAP[0];
}

function syncSettingsViewMapToBuild(): boolean {
  if (isExperimentalBuildPayload(settingsPayload) === isSettingsViewMapExperimental) return false;
  rebuildSettingsViewMap();
  return true;
}

function refreshSoundOptions() {
  rebuildSettingsViewMap();
  storedValues['pref:soundId'] = resolveSoundId(getSoundId());
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  const setting = settingById('alert-sound');
  if (setting && isAlertSoundPage(selectedPage)) refreshRow(setting);
}

function activateSection(sectionId: string | null, settingId: string | null, hashAtRequest: string) {
  const search = parseSettingsSearchHash(sectionId ?? hashAtRequest);
  if (search) {
    setSearchQuery(search.query);
    return;
  }
  setSearchQuery('', { updateHash: false });
  if (isPhoneLayout() && !sectionId) {
    history.replaceState(history.state, '', settingsSearchHash(''));
    return;
  }
  selectSection(sectionId || selectedPage.id, { settingId });
}

function activateLinkedSection(linkHash: string) {
  const target = parseSettingsHash(linkHash, SETTINGS_VIEW_MAP, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS);
  activateSection(target?.sectionId ?? null, target?.settingId ?? null, linkHash);
}

function activatePendingSection() {
  const activation = takePendingSettingsActivation();
  if (!activation) return;
  if (activation.isLink) {
    activateLinkedSection(activation.hashAtRequest);
    return;
  }
  activateSection(activation.sectionId, activation.settingId, activation.hashAtRequest);
}

function showBroadcastSettings() {
  settingsPayload = settingsPayloadSnapshot();
  const isViewMapRebuilt = syncSettingsViewMapToBuild();
  hydrate(settingsPayload);
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  if (isViewMapRebuilt) {
    renderNavigation();
    renderContent();
    return;
  }
  refreshVisibleRows();
}

function refreshRowStatusSlot(setting: SettingsSetting, row: Element) {
  const currentStatus = row.querySelector('.settings-view-status-slot');
  const nextStatus = buildStatusSlot(setting);
  if (currentStatus && nextStatus) currentStatus.replaceWith(nextStatus);
  if (currentStatus && !nextStatus) currentStatus.remove();
  if (!currentStatus && nextStatus) row.appendChild(nextStatus);
}

function refreshSettingsStatus() {
  for (const setting of pageSettings(selectedPage)) {
    if (!setting.status) continue;
    const row = rowOf(setting);
    if (!row) continue;
    if (setting.control === 'readonly') {
      refreshReadout(setting);
      continue;
    }
    refreshRowStatusSlot(setting, row);
  }
}

function refreshUpdateRows() {
  if (selectedPage.id !== UPDATES_SECTION_ID) return;
  const setting = settingById('update-actions');
  if (setting) refreshReadout(setting);
}

function applySettingsChange(change: SettingsChange) {
  switch (change.kind) {
    case 'broadcast':
      showBroadcastSettings();
      return;
    case 'status':
      refreshSettingsStatus();
      return;
    case 'update':
      refreshUpdateRows();
      if (change.frame === 'status' && isAutoUpdateCheckAwaitingStatus && selectedPage.id === UPDATES_SECTION_ID) checkUpdatesIfStale();
      return;
    case 'activate':
      activatePendingSection();
      return;
    case 'return-to-list':
      returnToList();
  }
}

function refreshFlyingAnimalsAvailability() {
  if (selectedPage.id !== APPEARANCE_PAGE_ID) return;
  renderContent();
}

window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refreshFlyingAnimalsAvailability);
onLayoutChange(() => {
  phoneSectionId = null;
  syncPhoneSettingsScreen();
  refreshFlyingAnimalsAvailability();
});

onAgentLoginsChanged(refreshSettingsStatus);

export const view: ViewModule<HTMLElement> = { mount: mountSettingsView };
