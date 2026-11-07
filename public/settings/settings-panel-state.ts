import { resolveSoundId, soundOptions } from '../alert-sound.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import { SETTINGS_REGISTRY, settingsSectionsAvailableOn } from '#shared/settings/registry.ts';
import { childSectionsOf, hydrateFromSettings, pageSectionOf } from './settings-view-core.ts';
import type { ControlDraft, SettingsPayload, SettingsValues } from './settings-view-core.ts';
import { settingsHash } from './settings-link.ts';
import { getThemeList } from '../theme.ts';
import { isFlyingAnimalsEnabled, getFlyingAnimalsEnteredValues, getSoundId, getThemeId, isNotificationsEnabled, isPhoneArrowPad, isSoundEnabled, getNextAttentionKeyCode, getReviewsTurnLimit } from '../ui-prefs.ts';
import { settingsPayloadSnapshot } from './settings-store.ts';

type SaveTone = 'saving' | 'saved' | 'error';

interface SaveStatus {
  tone: SaveTone;
  text: string;
}

const WEBSITE_ORIGIN = 'https://glimmervoid.dev';
const FEATURES_PAGE_ID = 'lanes-features';

const FEATURES_SECTION: SettingsSection = Object.freeze({
  id: FEATURES_PAGE_ID,
  level: 'lanes',
  title: 'Features',
  description: 'Optional tabs, each hidden until its own toggle is on.',
  settings: [],
});

const PACKS_PAGE_ID = 'machine-packs';

const PACKS_SECTION: SettingsSection = Object.freeze({
  id: PACKS_PAGE_ID,
  level: 'machine',
  title: 'Packs',
  description: 'Packs other people share, each waiting for your approval before anything in it runs.',
  settings: [],
});

const SECRETS_PAGE_ID = 'machine-secrets';

const SECRETS_SECTION: SettingsSection = Object.freeze({
  id: SECRETS_PAGE_ID,
  level: 'machine',
  title: 'Secrets',
  description: 'Vault secrets each project allows agents to read, with revoke.',
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
  return Object.freeze([...withStatusKey.slice(0, firstLaneIndex), PACKS_SECTION, SECRETS_SECTION, FEATURES_SECTION, ...withStatusKey.slice(firstLaneIndex), ABOUT_SECTION]);
}

const saveStatusById = new Map<string, SaveStatus>();
const pendingSaveById = new Map<string, unknown>();
const draftByControl = new WeakMap<Element, ControlDraft>();
const fieldErrorById = new Map<string, string>();

function browserPreferences() {
  return {
    themeId: getThemeId(),
    flyingAnimalsEnabled: isFlyingAnimalsEnabled(),
    ...getFlyingAnimalsEnteredValues(),
    soundEnabled: isSoundEnabled(),
    soundId: resolveSoundId(getSoundId()),
    notificationsEnabled: isNotificationsEnabled(),
    phoneArrowPad: isPhoneArrowPad(),
    reviewsTurnLimit: getReviewsTurnLimit(),
    nextAttentionKeyCode: getNextAttentionKeyCode(),
  };
}

function hydrate(payload: SettingsPayload) {
  storedValues = hydrateFromSettings(viewMap, { ...payload, prefs: browserPreferences() });
}

function storedValue(setting: SettingsSetting): unknown {
  if (pendingSaveById.has(setting.id)) return pendingSaveById.get(setting.id);
  return storedValues[setting.path];
}

function pageParts(page: SettingsSection): SettingsSection[] {
  return [page, ...childSectionsOf(viewMap, page.id)];
}

function pageSettings(page: SettingsSection): SettingsSetting[] {
  return pageParts(page).flatMap((part) => part.settings);
}

function sectionOfSetting(setting: SettingsSetting): SettingsSection {
  return viewMap.find((section) => section.settings.some((entry) => entry.id === setting.id)) ?? selectedPage;
}

function replaceSettingsHash(sectionId: string, settingId: string | null = null) {
  history.replaceState(history.state, '', settingsHash(sectionId, settingId));
}

function websiteUrl(pathname: string): string {
  const url = new URL(pathname, WEBSITE_ORIGIN);
  const { telemetryInstallId } = settingsPayload;
  if (typeof telemetryInstallId === 'string' && telemetryInstallId) url.searchParams.set('gv', telemetryInstallId);
  return url.href;
}

function settingById(settingId: string): SettingsSetting | null {
  return viewMap.flatMap((section) => section.settings).find((setting) => setting.id === settingId) ?? null;
}

function rebuildSettingsViewMap() {
  viewMap = buildSettingsViewMap();
  isViewMapExperimental = isExperimentalBuildPayload(settingsPayloadSnapshot());
  selectedPage = pageSectionOf(viewMap, selectedPage.id) ?? viewMap[0];
}

function syncSettingsViewMapToBuild(): boolean {
  if (isExperimentalBuildPayload(settingsPayload) === isViewMapExperimental) return false;
  rebuildSettingsViewMap();
  return true;
}

interface PanelRefresher {
  refreshRow(setting: SettingsSetting, options?: { force?: boolean }): void;
  refreshRowFoot(setting: SettingsSetting): void;
  refreshSettingsStatus(): void;
  refreshShortcutGroups(): void;
}

let viewMap = buildSettingsViewMap();
let isViewMapExperimental = isExperimentalBuildPayload(settingsPayloadSnapshot());
let contentEl: HTMLDivElement | null = null;
let selectedPage: SettingsSection = viewMap[0];
let settingsPayload: SettingsPayload = settingsPayloadSnapshot();
let storedValues: SettingsValues = {};
let isAutoUpdateCheckAwaitingStatus = false;

function setContentEl(element: HTMLDivElement) {
  contentEl = element;
}

function setSelectedPage(page: SettingsSection) {
  selectedPage = page;
}

function setSettingsPayload(payload: SettingsPayload) {
  settingsPayload = payload;
}

function setAutoUpdateCheckAwaitingStatus(isAwaiting: boolean) {
  isAutoUpdateCheckAwaitingStatus = isAwaiting;
}

const inertRefresher: PanelRefresher = {
  refreshRow: () => {},
  refreshRowFoot: () => {},
  refreshSettingsStatus: () => {},
  refreshShortcutGroups: () => {},
};

let installedRefresher = inertRefresher;

function setPanelRefresher(refresher: PanelRefresher) {
  installedRefresher = refresher;
}

function panelRefresher(): PanelRefresher {
  return installedRefresher;
}

export { ABOUT_PAGE_ID, FEATURES_PAGE_ID, PACKS_PAGE_ID, SECRETS_PAGE_ID, SHORTCUTS_PAGE_ID, STATUS_KEY_PAGE_ID, availableSettingsSections, draftByControl, fieldErrorById, hydrate, pageParts, pageSettings, panelRefresher, contentEl, isAutoUpdateCheckAwaitingStatus, selectedPage, settingsPayload, storedValues, viewMap, setContentEl, setSelectedPage, setSettingsPayload, setAutoUpdateCheckAwaitingStatus, pendingSaveById, rebuildSettingsViewMap, replaceSettingsHash, saveStatusById, sectionOfSetting, setPanelRefresher, settingById, storedValue, syncSettingsViewMapToBuild, websiteUrl };
export type { SaveStatus };
