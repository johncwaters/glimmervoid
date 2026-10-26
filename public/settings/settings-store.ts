import type { UpdateJournal } from '#shared/contracts/update-journal.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import { SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '#shared/settings/registry.ts';
import { parseSettingsHash } from '#shared/settings/registry-core.ts';
import { soundOptions } from '../alert-sound.ts';
import { sendControlMsg } from '../control-ws.ts';
import { applyAgentLogins } from '../dialogs.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { getThemeList } from '../theme.ts';
import { IDLE_UPDATE_REQUEST, NOT_CONNECTED_TEXT, reduceUpdateRequest, updateErrorText } from '../updates-view-core.ts';
import type { UpdateRequestEvent, UpdateRequestState, UpdateStatusView } from '../updates-view-core.ts';
import type { PrimaryViewDefinition } from '../view-registry-core.ts';
import { settingsSearchHash } from './settings-link.ts';
import { parseSettingsSearchHash } from './settings-view-core.ts';
import type { SettingsPayload } from './settings-view-core.ts';

export type SettingsChange =
  | { kind: 'broadcast' }
  | { kind: 'status' }
  | { kind: 'update'; frame: 'status' | 'progress' | 'error' | 'request' }
  | { kind: 'activate' }
  | { kind: 'return-to-list' };

type FeatureTabView = Pick<PrimaryViewDefinition<unknown>, 'view' | 'label' | 'gate'>;

interface SectionActivation {
  sectionId: string | null;
  settingId: string | null;
  hashAtRequest: string;
}

export const FEATURES_PAGE_ID = 'lanes-features';
const FEATURES_SECTION: SettingsSection = Object.freeze({
  id: FEATURES_PAGE_ID,
  level: 'lanes',
  title: 'Features',
  description: 'Optional tabs, each hidden until its own toggle is on.',
  settings: [],
});
export const SHORTCUTS_PAGE_ID = 'browser-shortcuts';
export const STATUS_KEY_PAGE_ID = 'browser-status-key';
const STATUS_KEY_SECTION: SettingsSection = Object.freeze({
  id: STATUS_KEY_PAGE_ID,
  level: 'browser',
  title: 'Status key and about',
  description: 'What each session status and pull request icon means, and build information.',
  settings: [],
});
const OPTION_CATALOGS: Readonly<Record<string, () => { id: string; label: string }[]>> = Object.freeze({
  sounds: () => soundOptions(),
  themes: getThemeList,
});

let settingsPayload: SettingsPayload = {};
let updateStatus: UpdateStatusView | null = null;
let updateJournal: UpdateJournal | null = null;
let updateRequest: UpdateRequestState = IDLE_UPDATE_REQUEST;
let lastAutoUpdateCheckAt: number | null = null;
let isUpdateCheckInFlight = false;
let updateCheckSendFailure: string | null = null;
let featureTabViews: readonly FeatureTabView[] = [];
let pendingActivation: SectionActivation | null = null;
let phoneSettingsScreenProbe: () => string | null = () => null;
let restartHandler = () => {};
const phoneSettingsScreenListeners = new Set<() => void>();
const listeners = new Set<(change: SettingsChange) => void>();

function notify(change: SettingsChange): void {
  for (const listener of listeners) listener(change);
}

function resolveSettingOptions(setting: SettingsSetting): SettingsSetting {
  if (!setting.optionsFrom) return setting;
  const catalog = OPTION_CATALOGS[setting.optionsFrom]?.() ?? [];
  return {
    ...setting,
    options: catalog.map((option) => ({ value: option.id, label: option.label })),
  };
}

export function buildSettingsViewMap(): readonly SettingsSection[] {
  const sections = SETTINGS_REGISTRY.sections.map((section) => ({
    ...section,
    settings: section.settings.map(resolveSettingOptions),
  }));
  const statusKeyIndex = sections.findIndex((section) => section.id === SHORTCUTS_PAGE_ID) + 1;
  const withStatusKey = [...sections.slice(0, statusKeyIndex), STATUS_KEY_SECTION, ...sections.slice(statusKeyIndex)];
  const firstLaneIndex = withStatusKey.findIndex((section) => section.level === 'lanes');
  return Object.freeze([...withStatusKey.slice(0, firstLaneIndex), FEATURES_SECTION, ...withStatusKey.slice(firstLaneIndex)]);
}

export function subscribeSettings(listener: (change: SettingsChange) => void): void {
  listeners.add(listener);
}

export function settingsPayloadSnapshot(): SettingsPayload {
  return settingsPayload;
}

export function mergeSettingsPayload(patch: SettingsPayload): SettingsPayload {
  settingsPayload = { ...settingsPayload, ...patch };
  return settingsPayload;
}

export function settingsUpdateState() {
  return { status: updateStatus, journal: updateJournal, request: updateRequest, lastAutoCheckAt: lastAutoUpdateCheckAt, isCheckInFlight: isUpdateCheckInFlight, checkSendFailure: updateCheckSendFailure };
}

function dispatchUpdateRequest(event: UpdateRequestEvent): void {
  const next = reduceUpdateRequest(updateRequest, event);
  if (next === updateRequest) return;
  updateRequest = next;
  notify({ kind: 'update', frame: 'request' });
}

export function requestUpdateApply(): void {
  const isSent = sendControlMsg({ type: 'update-apply' });
  dispatchUpdateRequest(isSent ? 'request-sent' : 'request-unsent');
}

export function requestUpdateCheck(): void {
  lastAutoUpdateCheckAt = Date.now();
  const isSent = sendControlMsg({ type: 'update-check' });
  isUpdateCheckInFlight = isSent;
  updateCheckSendFailure = isSent ? null : NOT_CONNECTED_TEXT;
  notify({ kind: 'update', frame: 'request' });
}

export function setSettingsRestartHandler(handler: () => void): void {
  restartHandler = handler;
}

export function restartServer(): void {
  restartHandler();
}

export function setFeatureTabViews(views: readonly FeatureTabView[]): void {
  featureTabViews = [...views];
}

export function settingsFeatureTabViews(): readonly FeatureTabView[] {
  return featureTabViews;
}

export function activateSettingsSection(sectionId: string | null = null, settingId: string | null = null): void {
  if (sectionId === null && pendingActivation?.sectionId) return;
  pendingActivation = { sectionId, settingId, hashAtRequest: location.hash };
  notify({ kind: 'activate' });
}

export function takePendingSettingsActivation(): SectionActivation | null {
  const activation = pendingActivation;
  pendingActivation = null;
  return activation;
}

export function resolveSettingsTarget(hash: unknown) {
  const search = parseSettingsSearchHash(hash);
  if (search) {
    const searchHash = settingsSearchHash(search.query);
    return { sectionId: searchHash, settingId: null, hash: searchHash };
  }
  return parseSettingsHash(hash, buildSettingsViewMap(), SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS);
}

export function setPhoneSettingsScreenProbe(probe: () => string): void {
  phoneSettingsScreenProbe = probe;
}

export function notifyPhoneSettingsScreenChanged(): void {
  for (const listener of phoneSettingsScreenListeners) listener();
}

export function onPhoneSettingsScreenChanged(listener: () => void): void {
  phoneSettingsScreenListeners.add(listener);
}

export function canReturnToSettingsList(): boolean {
  return isPhoneLayout() && phoneSettingsScreenProbe() === 'section';
}

export function returnToSettingsList(): void {
  if (!canReturnToSettingsList()) return;
  notify({ kind: 'return-to-list' });
}

export function applySettingsBroadcast(freshSettings: unknown): void {
  if (!freshSettings) return;
  settingsPayload = freshSettings as SettingsPayload;
  applyAgentLogins(settingsPayload.agentLogins);
  notify({ kind: 'broadcast' });
}

export function refreshSettingsStatus(): void {
  notify({ kind: 'status' });
}

export function applySettingsProjects(_projects: unknown): void {
  refreshSettingsStatus();
}

export function applySettingsUpdateStatus(status: unknown): void {
  updateStatus = status as UpdateStatusView;
  isUpdateCheckInFlight = false;
  updateCheckSendFailure = null;
  updateRequest = reduceUpdateRequest(updateRequest, 'status-frame');
  notify({ kind: 'update', frame: 'status' });
}

export function applySettingsUpdateProgress(journal: unknown): void {
  updateJournal = journal as UpdateJournal;
  updateRequest = reduceUpdateRequest(updateRequest, 'progress-frame');
  notify({ kind: 'update', frame: 'progress' });
}

export function applySettingsUpdateError(message: { scope?: string; message: string }): boolean {
  if (message.scope !== 'update') return false;
  const errorText = updateErrorText(message.message);
  const wasApplyRequested = updateRequest.requested;
  updateRequest = reduceUpdateRequest(updateRequest, 'error-frame', errorText);
  isUpdateCheckInFlight = false;
  if (!wasApplyRequested) updateCheckSendFailure = errorText;
  notify({ kind: 'update', frame: 'error' });
  return true;
}
