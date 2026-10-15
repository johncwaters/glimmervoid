import { renderCompactStatusPreview } from '../compact-status-preview.ts';
import { renderFlyingAnimalsGallery } from '../flying-animals-gallery.ts';
import { onLayoutChange } from '../form-factor.ts';
import type { SettingsRange } from '#shared/settings-ranges.ts';
import type { CustomAgentSummaryRow } from '#shared/contracts/control-messages.ts';
import type { UpdateJournal } from '#shared/contracts/update-journal.ts';
import { REPO_SLUG } from '#shared/repo.ts';
import { loadCustomSounds, playAlertSound, resolveSoundId, soundOptions } from '../alert-sound.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { ensureNotificationPermission, notificationPermission, notificationsSupported } from '../notifications.ts';
import { formatAgo } from '../poll-ago.ts';
import { UPDATES_SECTION_ID } from '../radar/radar-core.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import { SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '#shared/settings/registry.ts';
import type { SettingsSearchResult } from '#shared/settings/registry-core.ts';
import { parseSettingsHash, scoreSettingsSearch } from '#shared/settings/registry-core.ts';
import {
  EFFECT_LABELS,
  SCOPE_LABELS,
  childSectionsOf,
  choicePresentation,
  displayRange,
  draftCommitOf,
  fileOnlyDefaultText,
  hasUnsavedEdit,
  hydrateFromSettings,
  isAtDefault,
  listValue,
  needsDangerConfirmation,
  numberDraftOf,
  pageSectionOf,
  resetConfirmationOf,
  resetValueOf,
  rtkInstallStatusText,
  secretEnvironmentSource,
  settingSavePayload,
  shouldShowDangerWarning,
  topLevelSectionsOf,
  workflowRuleSummaryLines,
  workflowRuleToggleRows,
} from './settings-view-core.ts';
import type { ControlDraft, SettingsPayload, SettingsValues, WorkflowRuleToggleRow } from './settings-view-core.ts';
import { settingsHash } from './settings-link.ts';
import { projectSelectionChoices } from './settings-projects-core.ts';
import { appendShortcutChord, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { isStreamerMode, onStreamerModeChanged, saveStreamerMode } from '../streamer-mode.ts';
import { shortcutGroupsFor } from '../shortcuts-core.ts';
import { renderPrStatusLegend, renderStatusLegend } from '../status-legend.ts';
import { applyFlyingAnimals } from '../flying-animals.ts';
import { applyCompactStatusLabels, applySessionUsageChips, applyTheme, getThemeList } from '../theme.ts';
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
  isCompactStatusLabels,
  isSessionUsageChips,
  isSoundEnabled,
  setCompactStatusLabels,
  setSessionUsageChips,
  setFlyingAnimalsEnabled,
  setNotificationsEnabled,
  setSoundId,
  setThemeId,
} from '../ui-prefs.ts';
import { usageStatusLines } from '../usage/usage-panel.ts';
import { applySoundEnabled, onSoundEnabledChange } from '../mute-button.ts';
import {
  IDLE_UPDATE_REQUEST,
  NOT_CONNECTED_TEXT,
  installedUpdateText,
  lastUpdateCheckText,
  latestUpdateDetails,
  projectUpdateProgress,
  reduceUpdateRequest,
  shouldAutoCheckUpdates,
  updateActionAvailability,
  updateSummary,
} from '../updates-view-core.ts';
import type { UpdateRequestEvent, UpdateRequestState, UpdateStatusView } from '../updates-view-core.ts';

type SectionSearchResult = SettingsSearchResult & { section: SettingsSection };

type SaveTone = 'saving' | 'saved' | 'error';

interface SaveStatus {
  tone: SaveTone;
  text: string;
}

const OPTION_CATALOGS: Readonly<Record<string, () => { id: string; label: string }[]>> = Object.freeze({
  sounds: () => soundOptions(),
  themes: getThemeList,
});

const SAVED_STATUS_MS = 2200;
const APPEARANCE_PAGE_ID = 'browser-appearance';
const SHORTCUTS_PAGE_ID = 'browser-shortcuts';
const FLYING_ANIMALS_SETTING_ID = 'flying-animals';
const FILE_ONLY_RESULT_GROUP = 'config.json';
const SEGMENT_STEP_BY_KEY: Readonly<Record<string, number>> = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

function resolveSettingOptions(setting: SettingsSetting): SettingsSetting {
  if (!setting.optionsFrom) return setting;
  const catalog = OPTION_CATALOGS[setting.optionsFrom]?.() ?? [];
  return {
    ...setting,
    options: catalog.map((option) => ({ value: option.id, label: option.label })),
  };
}

function buildSettingsViewMap(): readonly SettingsSection[] {
  return Object.freeze(SETTINGS_REGISTRY.sections.map((section) => ({
    ...section,
    settings: section.settings.map(resolveSettingOptions),
  })));
}

let SETTINGS_VIEW_MAP = buildSettingsViewMap();

let isAdvancedSettingsExpanded = false;

let rootEl: HTMLElement | null = null;
let settingsViewVisibilityObserver: IntersectionObserver | null = null;
let shellEl: HTMLDivElement | null = null;
let navigationEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let sectionButtonEl: HTMLButtonElement | null = null;
let sectionButtonTitleEl: HTMLSpanElement | null = null;
let sectionPickerEl: HTMLDivElement | null = null;
let phoneSearchResultsEl: HTMLElement | null = null;
let contentEl: HTMLDivElement | null = null;
let selectedPage: SettingsSection = SETTINGS_VIEW_MAP[0];
let settingsPayload: SettingsPayload = {};
let storedValues: SettingsValues = {};
const saveStatusById = new Map<string, SaveStatus>();
const savedStatusTimerById = new Map<string, number>();
const pendingSaveById = new Map<string, unknown>();
const draftByControl = new WeakMap<Element, ControlDraft>();
let saveQueue = Promise.resolve();
const fieldErrorById = new Map<string, string>();
let searchQuery = '';
let sectionPickerDocumentClickHandler: ((event: MouseEvent) => void) | null = null;
let sectionPickerDocumentKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
let updateStatus: UpdateStatusView | null = null;
let updateJournal: UpdateJournal | null = null;
let updateRequest: UpdateRequestState = IDLE_UPDATE_REQUEST;
let restartServer = () => {};
let confirmUpdateAndRestart = (proceed: (confirmedSessionIds: string[]) => void) => { proceed([]); };
let lastAutoUpdateCheckAt: number | null = null;
let isAutoUpdateCheckAwaitingStatus = false;
let isUpdateCheckInFlight = false;
let updateCheckSendFailure: string | null = null;
const pendingWorkflowRuleIds = new Set<string>();
const workflowRuleSaveErrorsById = new Map<string, string>();

function browserPreferences() {
  return {
    themeId: getThemeId(),
    flyingAnimalsEnabled: isFlyingAnimalsEnabled(),
    ...getFlyingAnimalsEnteredValues(),
    soundEnabled: isSoundEnabled(),
    soundId: resolveSoundId(getSoundId()),
    notificationsEnabled: isNotificationsEnabled(),
    compactStatusLabels: isCompactStatusLabels(),
    sessionUsageChips: isSessionUsageChips(),
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
  for (const group of shortcutGroupsFor(SHORTCUT_PLATFORM)) {
    const groupEl = el('div', 'shortcut-group');
    groupEl.appendChild(el('div', 'shortcut-group-title', group.title));
    const rows = el('dl', 'shortcut-rows');
    for (const item of group.items) {
      const keys = el('dt', 'shortcut-keys');
      item.combos.forEach((chord, chordIndex) => {
        if (chordIndex > 0) keys.appendChild(el('span', 'shortcut-sep', '/'));
        appendShortcutChord(keys, chord);
      });
      rows.append(keys, el('dd', 'shortcut-label', item.label));
    }
    groupEl.appendChild(rows);
    container.appendChild(groupEl);
  }
}

function renderAbout(container: HTMLElement) {
  const about = el('div', 'settings-about');
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `v${__APP_VERSION__}` : 'version unknown';
  const versionEl = el('span', 'settings-about-version', 'GLIMMERVOID ');
  versionEl.appendChild(el('span', 'settings-about-v', version));
  const links = el('span', 'settings-about-links');
  const repo = el('a', 'settings-about-link', 'GitHub');
  repo.href = `https://github.com/${REPO_SLUG}`;
  repo.target = '_blank';
  repo.rel = 'noopener';
  const changelog = el('a', 'settings-about-link', 'Changelog');
  changelog.href = `https://github.com/${REPO_SLUG}/blob/main/CHANGELOG.md`;
  changelog.target = '_blank';
  changelog.rel = 'noopener';
  links.append(repo, changelog);
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
  if (setting.path === 'pref:compactStatusLabels') {
    setCompactStatusLabels(value === true);
    applyCompactStatusLabels(value === true);
    return;
  }
  if (setting.path === 'pref:sessionUsageChips') {
    setSessionUsageChips(value === true);
    applySessionUsageChips(value === true);
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

function commitSetting(setting: SettingsSetting, value: unknown) {
  fieldErrorById.delete(setting.id);
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
  const label = el('label', 'settings-view-toggle');
  const input = el('input', 'settings-view-checkbox');
  input.type = 'checkbox';
  input.checked = storedValue(setting) === true;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    input.checked = false;
    input.disabled = true;
  }
  input.setAttribute('aria-labelledby', setting.id);
  const state = el('span', 'settings-view-toggle-state', toggleStateText(input.checked));
  input.addEventListener('change', () => {
    const next = input.checked;
    if (needsDangerConfirmation(setting, next)) {
      input.checked = false;
      state.textContent = toggleStateText(false);
      openConfirmDialog({
        title: setting.title,
        message: setting.warning ?? '',
        confirmLabel: 'Turn on',
        danger: true,
        onConfirm: () => commitSetting(setting, true),
      });
      return;
    }
    state.textContent = toggleStateText(next);
    commitSetting(setting, next);
  });
  label.append(input, state);
  wrapper.appendChild(label);
  return wrapper;
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
    ? 'One project id per line, or none for no project. Shift+Enter adds a line.'
    : 'One entry per line. Shift+Enter adds a line.';
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

function renderProjects(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-projects');
  const currentValue = storedValue(setting);
  const selected = new Set<string>(Array.isArray(currentValue) ? currentValue : []);
  const choices: { id: string; name: string }[] = Array.isArray(settingsPayload.projectChoices) ? settingsPayload.projectChoices : [];
  if (choices.length === 0) wrapper.appendChild(el('div', 'settings-empty', 'No configured projects are available.'));
  for (const project of projectSelectionChoices(choices, [...selected])) {
    const label = el('label', 'settings-view-project-choice');
    const input = el('input', 'settings-view-checkbox');
    input.type = 'checkbox';
    input.checked = selected.has(project.id);
    input.addEventListener('change', () => {
      const latestProjects = storedValue(setting);
      const next = new Set<string>(Array.isArray(latestProjects) ? latestProjects : []);
      if (input.checked) next.add(project.id);
      if (!input.checked) next.delete(project.id);
      commitSetting(setting, [...next]);
    });
    label.append(input, document.createTextNode(project.name));
    wrapper.appendChild(label);
  }
  return wrapper;
}

function buildUpdateButton(
  label: string,
  onClick: () => void,
  { decision = { enabled: true, reason: null }, isPrimary = false }: {
    decision?: { enabled: boolean; reason: string | null };
    isPrimary?: boolean;
  } = {},
) {
  const tone = isPrimary ? 'btn-dialog-confirm' : 'btn-dialog-cancel';
  const button = el('button', `btn-dialog ${tone} settings-update-button`, label);
  button.type = 'button';
  button.disabled = !decision.enabled;
  button.addEventListener('click', onClick);
  return button;
}

function buildUpdateActionStatus(reason: string | null) {
  const status = el('span', 'settings-update-action-status', reason ?? '');
  status.setAttribute('role', 'status');
  return status;
}

function dispatchUpdateRequest(event: UpdateRequestEvent) {
  const next = reduceUpdateRequest(updateRequest, event);
  if (next === updateRequest) return;
  updateRequest = next;
  refreshUpdateRows();
}

function requestUpdateApply({ restartWhenStaged, confirmedSessionIds }: { restartWhenStaged: boolean; confirmedSessionIds?: string[] }) {
  const isSent = sendControlMsg({ type: 'update-apply', restartWhenStaged, confirmedSessionIds });
  dispatchUpdateRequest(isSent ? 'request-sent' : 'request-unsent');
}

function requestUpdateCheck() {
  lastAutoUpdateCheckAt = Date.now();
  const isSent = sendControlMsg({ type: 'update-check' });
  isUpdateCheckInFlight = isSent;
  updateCheckSendFailure = isSent ? null : NOT_CONNECTED_TEXT;
  refreshUpdateRows();
}

function updateCheckStatusText(): string | null {
  if (isUpdateCheckInFlight) return 'Checking for updates.';
  return updateCheckSendFailure;
}

function checkUpdatesIfStale() {
  if (!updateStatus) {
    isAutoUpdateCheckAwaitingStatus = true;
    return;
  }
  isAutoUpdateCheckAwaitingStatus = false;
  const isStale = shouldAutoCheckUpdates({
    status: updateStatus,
    checkForUpdates: settingsPayload.checkForUpdates,
    now: Date.now(),
    lastAutoCheckAt: lastAutoUpdateCheckAt,
  });
  if (isStale) requestUpdateCheck();
}

function buildUpdateActions() {
  const decisions = updateActionAvailability({
    status: updateStatus,
    journal: updateJournal,
    request: updateRequest,
  });
  const actions = el('div', 'settings-update-actions');
  const buttons = el('div', 'settings-update-buttons');
  buttons.append(
    buildUpdateButton(
      'Update and restart',
      () => confirmUpdateAndRestart((confirmedSessionIds) => requestUpdateApply({ restartWhenStaged: true, confirmedSessionIds })),
      { decision: decisions.update, isPrimary: true },
    ),
    buildUpdateButton('Update without restart', () => requestUpdateApply({ restartWhenStaged: false }), { decision: decisions.update }),
    buildUpdateButton('Check for updates', requestUpdateCheck, { decision: { enabled: !isUpdateCheckInFlight, reason: null } }),
    buildUpdateButton('Restart', restartServer, { decision: decisions.restart }),
  );
  actions.append(buttons, buildUpdateActionStatus(decisions.update.reason));
  const checkStatusText = updateCheckStatusText();
  if (checkStatusText) actions.append(buildUpdateActionStatus(checkStatusText));
  return actions;
}

function buildUpdateFact(label: string, ...content: (string | HTMLElement)[]) {
  const row = el('div', 'settings-update-fact');
  row.append(el('span', 'settings-update-fact-label', label), ...content);
  return row;
}

function buildUpdateProgress() {
  const projection = projectUpdateProgress(updateJournal);
  if (!projection) return null;
  const panel = el('div', 'settings-update-progress');
  panel.dataset.state = projection.state;
  panel.setAttribute('role', 'status');
  if (projection.terminalLine) panel.appendChild(el('div', 'settings-update-terminal', projection.terminalLine));
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
  panel.appendChild(list);
  if (projection.outputTail.length === 0) return panel;
  const output = el('pre', 'settings-update-output', projection.outputTail.join('\n'));
  if (projection.outputStepId) output.dataset.step = projection.outputStepId;
  if (!projection.outputStepLabel) {
    panel.appendChild(output);
    return panel;
  }
  const caption = `Output from ${projection.outputStepLabel}`;
  output.setAttribute('aria-label', caption);
  panel.append(el('div', 'settings-update-output-label', caption), output);
  return panel;
}

function buildUpdateStatusBlock() {
  const block = el('div', 'settings-view-status-block settings-update-status');
  const summary = updateSummary(updateStatus, updateJournal);
  const headline = el('div', 'settings-update-summary', summary.headline);
  headline.dataset.tone = summary.tone;
  block.appendChild(headline);
  block.appendChild(buildUpdateFact('Running', installedUpdateText(updateStatus)));
  const latest = latestUpdateDetails(updateStatus);
  const latestParts: (string | HTMLElement)[] = [latest.label];
  if (latest.behind) latestParts.push(el('span', 'settings-update-behind', latest.behind));
  if (latest.releaseUrl) {
    const release = el('a', 'settings-link', 'View release');
    release.href = latest.releaseUrl;
    release.target = '_blank';
    release.rel = 'noopener noreferrer';
    latestParts.push(release);
  }
  block.appendChild(buildUpdateFact('Latest', ...latestParts));
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

async function saveWorkflowRuleToggle(rule: WorkflowRuleToggleRow, isTurningOn: boolean) {
  pendingWorkflowRuleIds.add(rule.id);
  workflowRuleSaveErrorsById.delete(rule.id);
  refreshSettingsStatus();
  try {
    const message = await sendControlRequest('update-settings', { settings: { workflows: { rules: [{ id: rule.id, enabled: isTurningOn }] } } });
    if (message.type === 'settings-error') workflowRuleSaveErrorsById.set(rule.id, String(message.message));
    pendingWorkflowRuleIds.delete(rule.id);
    if (message.type === 'settings-updated') {
      applySettingsBroadcast(message.settings);
      return;
    }
  } catch (error) {
    workflowRuleSaveErrorsById.set(rule.id, (error as Error)?.message || 'Failed to save the rule.');
  }
  pendingWorkflowRuleIds.delete(rule.id);
  refreshSettingsStatus();
}

function workflowRuleStatusText(rule: WorkflowRuleToggleRow): string {
  if (pendingWorkflowRuleIds.has(rule.id)) return 'Saving';
  return workflowRuleSaveErrorsById.get(rule.id) ?? '';
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
  const status = el('span', 'settings-view-copy-status', workflowRuleStatusText(rule));
  status.setAttribute('role', 'status');
  row.append(label, status);
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

function renderReadout(setting: SettingsSetting) {
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
  if (setting.control === 'projects') return renderProjects(setting);
  return renderInput(setting);
}

function statusText(setting: SettingsSetting) {
  const environmentSource = secretEnvironmentSource(setting, settingsPayload);
  if (environmentSource) return `Supplied by ${environmentSource}. Change the server environment and restart to replace this credential.`;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    return 'Desktop notifications are unavailable for this page.';
  }
  if (setting.id === 'desktop-notifications' && storedValue(setting) === true && notificationPermission() === 'denied') {
    return 'Blocked by the browser. Allow notifications for this site to enable them.';
  }
  if (setting.status !== 'rtk-install' || storedValue(setting) !== true || settingsPayload.rtkAvailable) return '';
  return rtkInstallStatusText(settingsPayload);
}

function buildStatusSlot(setting: SettingsSetting) {
  if (setting.control === 'readonly') return null;
  if (setting.status === 'usage-last-report') {
    const block = buildUsageStatus();
    block.classList.add('settings-view-status-slot');
    return block;
  }
  const status = statusText(setting);
  if (!status) return null;
  return el('div', 'settings-view-warning settings-view-status-slot', status);
}

function buildChip(kind: string, text: string) {
  const chip = el('span', 'settings-view-chip', text);
  chip.dataset.chip = kind;
  return chip;
}

function renderSettingHeading(setting: SettingsSetting) {
  const row = el('div', 'settings-view-setting-heading');
  const section = sectionOfSetting(setting);
  const heading = el('h2', 'settings-view-setting-title', setting.title);
  heading.id = setting.id;
  heading.addEventListener('click', () => replaceSettingsHash(section.id, setting.id));
  const copy = el('button', 'settings-view-copy-link', '#');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copy link');
  const copyStatus = el('span', 'settings-view-copy-status');
  copyStatus.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    const url = new URL(settingsHash(section.id, setting.id), location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      copyStatus.textContent = 'Link copied';
    } catch {
      copyStatus.textContent = 'Copy failed';
    }
    setTimeout(() => { copyStatus.textContent = ''; }, 1600);
  });
  row.append(heading, copy, copyStatus);
  return row;
}

function renderChips(setting: SettingsSetting) {
  const chips = el('div', 'settings-view-chips');
  chips.append(buildChip('scope', SCOPE_LABELS[setting.scope]), buildChip('effect', EFFECT_LABELS[setting.takesEffect]));
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
  if (reset) reset.disabled = !canReset(setting);
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
  text.append(renderSettingHeading(setting), el('p', 'settings-view-setting-description', setting.description), renderChips(setting));
  const control = el('div', 'settings-view-setting-control');
  control.appendChild(renderControl(setting));
  if (setting.control !== 'readonly') control.appendChild(renderControlFoot(setting));
  article.append(text, control);
  if (setting.id === 'compact-status') article.appendChild(renderCompactStatusPreview());
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
  const target = control.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
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
    if (setting.id === FLYING_ANIMALS_SETTING_ID) stack.appendChild(renderFlyingAnimalsGallery());
  }
  const advancedSettings = part.settings.filter((entry) => entry.access === 'advanced');
  if (advancedSettings.length > 0) stack.append(renderAdvancedSettings(advancedSettings));
}

function renderContent() {
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
  header.append(title, el('p', 'settings-view-section-description', selectedPage.description));
  contentEl.appendChild(header);

  if (selectedPage.id === SHORTCUTS_PAGE_ID) {
    const groups = el('div', 'shortcut-groups settings-view-shortcuts');
    renderShortcutGroups(groups);
    contentEl.appendChild(groups);
    contentEl.appendChild(renderStatusLegend());
    contentEl.appendChild(renderPrStatusLegend());
    renderAbout(contentEl);
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
  { focusContent = false, settingId = null, updateHash = true }: { focusContent?: boolean; settingId?: string | null; updateHash?: boolean } = {}
) {
  const page = pageSectionOf(SETTINGS_VIEW_MAP, sectionId) ?? selectedPage;
  if (selectedPage.id !== page.id) isAdvancedSettingsExpanded = false;
  selectedPage = page;
  const targetSection = SETTINGS_VIEW_MAP.find((section) => section.id === sectionId) ?? page;
  markCurrentSection(navigationEl);
  markCurrentSection(sectionPickerEl);
  if (sectionButtonTitleEl) {
    sectionButtonTitleEl.textContent = selectedPage.title;
    if (sectionButtonEl) sectionButtonEl.title = selectedPage.title;
  }
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
  setSectionPickerOpen(false);
  if (!searchEl) return;
  searchEl.value = '';
  searchQuery = '';
  renderNavigation();
  selectSection(searchResult.section.id, { settingId: searchResult.setting.id });
}

function searchSettings(query: string) {
  return scoreSettingsSearch(SETTINGS_VIEW_MAP, query, SETTINGS_REGISTRY.fileOnly);
}

function appendFileOnlyResult(group: HTMLElement, result: SettingsSearchResult) {
  const row = el('div', 'settings-view-nav-item settings-view-search-result settings-view-search-file-only', result.setting.title);
  row.append(
    el('code', 'settings-view-key-path', result.setting.path),
    el('span', 'settings-view-search-default', fileOnlyDefaultText(result.setting)),
  );
  row.title = result.setting.fileOnlyReason ?? '';
  group.appendChild(row);
}

function appendSearchResults(target: HTMLElement, results: SettingsSearchResult[]) {
  if (results.length === 0) {
    target.appendChild(el('div', 'settings-empty settings-view-search-empty', 'No settings found.'));
    return;
  }
  const resultsByGroup = new Map<string, SettingsSearchResult[]>();
  for (const result of results) {
    const groupId = result.section?.id ?? FILE_ONLY_RESULT_GROUP;
    if (!resultsByGroup.has(groupId)) resultsByGroup.set(groupId, []);
    resultsByGroup.get(groupId)?.push(result);
  }
  for (const groupResults of resultsByGroup.values()) {
    const section = groupResults[0].section;
    const group = el('div', 'settings-view-nav-group');
    group.appendChild(el('div', 'settings-view-nav-label', section ? section.title : FILE_ONLY_RESULT_GROUP));
    for (const result of groupResults) {
      if (!hasSection(result)) {
        appendFileOnlyResult(group, result);
        continue;
      }
      const button = el('button', 'settings-view-nav-item settings-view-search-result', result.setting.title);
      button.type = 'button';
      button.addEventListener('click', () => chooseSearchResult(result));
      group.appendChild(button);
    }
    target.appendChild(group);
  }
}

function appendSectionButtons(
  container: HTMLElement,
  sections: readonly SettingsSection[],
  { groupClassName, createButton }: { groupClassName: string; createButton: (section: SettingsSection) => HTMLElement }
) {
  const group = el('div', groupClassName);
  for (const section of sections) group.appendChild(createButton(section));
  container.appendChild(group);
}

function renderSectionPicker(sections: readonly SettingsSection[]) {
  if (!sectionPickerEl) return;
  sectionPickerEl.textContent = '';
  appendSectionButtons(sectionPickerEl, sections, {
    groupClassName: 'settings-view-section-picker-group',
    createButton(section: SettingsSection) {
      const button = el('button', 'settings-view-section-option', section.title);
      button.type = 'button';
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => {
        setSectionPickerOpen(false);
        selectSection(section.id);
      });
      return button;
    },
  });
  markCurrentSection(sectionPickerEl);
}

function isSectionPickerOpen() {
  return !!sectionPickerEl && !sectionPickerEl.hidden;
}

function setSectionPickerOpen(isOpen: boolean, { returnFocus = true }: { returnFocus?: boolean } = {}) {
  if (!sectionPickerEl || !sectionButtonEl) return;
  const wasOpen = isSectionPickerOpen();
  sectionPickerEl.hidden = !isOpen;
  sectionButtonEl.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    renderSectionPicker(topLevelSectionsOf(SETTINGS_VIEW_MAP));
    requestAnimationFrame(() => {
      const currentSectionButton = sectionPickerEl?.querySelector('[aria-current="page"]');
      if (!(currentSectionButton instanceof HTMLElement)) return;
      currentSectionButton.focus();
    });
    return;
  }
  if (returnFocus && wasOpen) sectionButtonEl.focus();
}

function renderNavigation() {
  if (!navigationEl || !phoneSearchResultsEl || !shellEl) return;
  const sections = topLevelSectionsOf(SETTINGS_VIEW_MAP);
  navigationEl.textContent = '';
  phoneSearchResultsEl.textContent = '';
  shellEl.dataset.searching = String(Boolean(searchQuery));
  phoneSearchResultsEl.hidden = !searchQuery;
  if (searchQuery) {
    const results = searchSettings(searchQuery);
    appendSearchResults(navigationEl, results);
    appendSearchResults(phoneSearchResultsEl, results);
    return;
  }
  appendSectionButtons(navigationEl, sections, {
    groupClassName: 'settings-view-nav-group',
    createButton(section: SettingsSection) {
      const button = el('button', 'settings-view-nav-item', section.title);
      button.type = 'button';
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => selectSection(section.id));
      return button;
    },
  });
  renderSectionPicker(sections);
  selectSection(selectedPage.id, { updateHash: false });
}

function handleNavigationKeydown(event: KeyboardEvent) {
  if (searchQuery && event.key === 'Enter') {
    const first = searchSettings(searchQuery).find(hasSection);
    if (!first) return;
    event.preventDefault();
    chooseSearchResult(first);
    return;
  }
  if (event.key === 'Escape' && searchQuery) {
    if (!searchEl) return;
    event.preventDefault();
    searchEl.value = '';
    searchQuery = '';
    renderNavigation();
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

export function mountSettingsView(
  container: HTMLElement,
  {
    onRestart = () => {},
    onConfirmUpdateAndRestart = (proceed: (confirmedSessionIds: string[]) => void) => { proceed([]); },
  }: { onRestart?: () => void; onConfirmUpdateAndRestart?: (proceed: (confirmedSessionIds: string[]) => void) => void } = {},
) {
  restartServer = onRestart;
  confirmUpdateAndRestart = onConfirmUpdateAndRestart;
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
  sectionButtonEl = el('button', 'settings-view-section-button');
  sectionButtonEl.type = 'button';
  sectionButtonEl.setAttribute('aria-expanded', 'false');
  sectionButtonEl.setAttribute('aria-controls', 'settings-section-picker');
  sectionButtonTitleEl = el('span', 'settings-view-section-button-title');
  const sectionButtonChevron = el('span', 'settings-view-section-button-chevron', String.fromCharCode(0x2304));
  sectionButtonChevron.setAttribute('aria-hidden', 'true');
  sectionButtonEl.append(sectionButtonTitleEl, sectionButtonChevron);
  sectionPickerEl = el('div', 'settings-view-section-picker');
  sectionPickerEl.id = 'settings-section-picker';
  sectionPickerEl.hidden = true;
  sectionPickerEl.setAttribute('role', 'dialog');
  sectionPickerEl.setAttribute('aria-label', 'Settings sections');
  phoneSearchResultsEl = el('nav', 'settings-view-phone-results');
  phoneSearchResultsEl.hidden = true;
  phoneSearchResultsEl.setAttribute('aria-label', 'Settings search results');
  contentEl = el('div', 'settings-view-content');
  contentEl.setAttribute('aria-live', 'polite');
  searchEl.addEventListener('input', () => {
    const currentSearchEl = searchEl;
    if (!currentSearchEl) return;
    searchQuery = currentSearchEl.value.trim();
    renderNavigation();
  });
  searchEl.addEventListener('keydown', handleNavigationKeydown);
  navigationEl.addEventListener('keydown', handleNavigationKeydown);
  phoneSearchResultsEl.addEventListener('keydown', handleNavigationKeydown);
  sectionButtonEl.addEventListener('click', () => setSectionPickerOpen(!isSectionPickerOpen()));
  if (sectionPickerDocumentClickHandler) document.removeEventListener('click', sectionPickerDocumentClickHandler);
  if (sectionPickerDocumentKeydownHandler) document.removeEventListener('keydown', sectionPickerDocumentKeydownHandler);
  sectionPickerDocumentClickHandler = (event) => {
    if (!isSectionPickerOpen()) return;
    if (!(event.target instanceof Node)) return;
    if (sectionPickerEl?.contains(event.target) || sectionButtonEl?.contains(event.target)) return;
    setSectionPickerOpen(false);
  };
  sectionPickerDocumentKeydownHandler = (event) => {
    if (event.key !== 'Escape' || !isSectionPickerOpen()) return;
    event.preventDefault();
    setSectionPickerOpen(false);
  };
  document.addEventListener('click', sectionPickerDocumentClickHandler);
  document.addEventListener('keydown', sectionPickerDocumentKeydownHandler);
  sidebar.append(searchEl, sectionButtonEl, navigationEl, sectionPickerEl);
  shellEl.append(sidebar, phoneSearchResultsEl, contentEl);
  rootEl.appendChild(shellEl);
  hydrate(settingsPayload);
  renderNavigation();
  reloadCustomSounds();
  settingsViewVisibilityObserver?.disconnect();
  settingsViewVisibilityObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) reloadCustomSounds();
  });
  settingsViewVisibilityObserver.observe(rootEl);
}

function reloadCustomSounds() {
  void loadCustomSounds().then(refreshSoundOptions);
}

function isAlertSoundPage(page: SettingsSection) {
  return pageSettings(page).some((setting) => setting.path === 'pref:soundId');
}

function refreshSoundOptions() {
  SETTINGS_VIEW_MAP = buildSettingsViewMap();
  selectedPage = pageSectionOf(SETTINGS_VIEW_MAP, selectedPage.id) ?? SETTINGS_VIEW_MAP[0];
  storedValues['pref:soundId'] = resolveSoundId(getSoundId());
  const setting = settingById('alert-sound');
  if (setting && isAlertSoundPage(selectedPage)) refreshRow(setting);
}

export function closeSettingsSectionPicker({ returnFocus = true }: { returnFocus?: boolean } = {}) {
  setSectionPickerOpen(false, { returnFocus });
}

export function activateSettingsSection(sectionId: string | null = null, settingId: string | null = null) {
  selectSection(sectionId || selectedPage.id, { settingId });
}

export function resolveSettingsTarget(hash: unknown) {
  return parseSettingsHash(hash, SETTINGS_VIEW_MAP, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS);
}

export function applySettingsBroadcast(freshSettings: unknown) {
  if (!freshSettings) return;
  settingsPayload = freshSettings as SettingsPayload;
  hydrate(settingsPayload);
  refreshVisibleRows();
}

export function applySettingsProjects(_projects: unknown) {
  refreshSettingsStatus();
}

function refreshRowStatusSlot(setting: SettingsSetting, row: Element) {
  const currentStatus = row.querySelector('.settings-view-status-slot');
  const nextStatus = buildStatusSlot(setting);
  if (currentStatus && nextStatus) currentStatus.replaceWith(nextStatus);
  if (currentStatus && !nextStatus) currentStatus.remove();
  if (!currentStatus && nextStatus) row.appendChild(nextStatus);
}

export function refreshSettingsStatus() {
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

export function applySettingsUpdateStatus(status: unknown) {
  updateStatus = status as UpdateStatusView;
  isUpdateCheckInFlight = false;
  updateCheckSendFailure = null;
  updateRequest = reduceUpdateRequest(updateRequest, 'status-frame');
  refreshUpdateRows();
  if (isAutoUpdateCheckAwaitingStatus && selectedPage.id === UPDATES_SECTION_ID) checkUpdatesIfStale();
}

export function applySettingsUpdateProgress(journal: unknown) {
  updateJournal = journal as UpdateJournal;
  updateRequest = reduceUpdateRequest(updateRequest, 'progress-frame');
  refreshUpdateRows();
}

export function clearSettingsUpdateRequest() {
  dispatchUpdateRequest('error-frame');
  if (!isUpdateCheckInFlight) return;
  isUpdateCheckInFlight = false;
  refreshUpdateRows();
}

function refreshFlyingAnimalsAvailability() {
  if (selectedPage.id !== APPEARANCE_PAGE_ID) return;
  renderContent();
}

window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refreshFlyingAnimalsAvailability);
onLayoutChange(refreshFlyingAnimalsAvailability);
