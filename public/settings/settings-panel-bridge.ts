import { clock } from '#shared/clock.ts';
import type { UpdateJournal } from '#shared/contracts/update-journal.ts';
import { isPhoneLayout } from '../form-factor.ts';
import updateApplyAction from '../state/actions/update-apply.ts';
import updateCheckAction from '../state/actions/update-check.ts';
import { IDLE_UPDATE_REQUEST, reduceUpdateRequest, updateErrorText } from '../updates-view-core.ts';
import type { UpdateRequestEvent, UpdateRequestState, UpdateStatusView } from '../updates-view-core.ts';
import type { PrimaryViewDefinition } from '../view-registry-core.ts';

export type SettingsUiEvent =
  | { kind: 'status' }
  | { kind: 'update'; frame: 'status' | 'progress' | 'error' | 'request' }
  | { kind: 'activate' }
  | { kind: 'return-to-list' };

type FeatureTabView = Pick<PrimaryViewDefinition<unknown>, 'view' | 'label' | 'gate'>;

interface SectionActivation {
  sectionId: string | null;
  settingId: string | null;
  hashAtRequest: string;
  isLink: boolean;
}

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
const uiEventListeners = new Set<(event: SettingsUiEvent) => void>();

function notifyUiEvent(event: SettingsUiEvent): void {
  for (const listener of [...uiEventListeners]) listener(event);
}

export function onSettingsUiEvent(listener: (event: SettingsUiEvent) => void): () => void {
  uiEventListeners.add(listener);
  return () => {
    uiEventListeners.delete(listener);
  };
}

export function settingsUpdateState() {
  return {
    status: updateStatus,
    journal: updateJournal,
    request: updateRequest,
    lastAutoCheckAt: lastAutoUpdateCheckAt,
    isCheckInFlight: isUpdateCheckInFlight,
    checkSendFailure: updateCheckSendFailure,
  };
}

function dispatchUpdateRequest(event: UpdateRequestEvent, errorText?: string): void {
  const next = reduceUpdateRequest(updateRequest, event, errorText);
  if (next === updateRequest) return;
  updateRequest = next;
  notifyUiEvent({ kind: 'update', frame: 'request' });
}

export function requestUpdateApply(): void {
  dispatchUpdateRequest('request-sent');
  void updateApplyAction({}).then((outcome) => {
    if (outcome.ok) return;
    dispatchUpdateRequest('error-frame', updateErrorText(outcome.error.message));
  });
}

export function requestUpdateCheck(): void {
  lastAutoUpdateCheckAt = clock.nowMs();
  isUpdateCheckInFlight = true;
  updateCheckSendFailure = null;
  notifyUiEvent({ kind: 'update', frame: 'request' });
  void updateCheckAction({}).then((outcome) => {
    isUpdateCheckInFlight = false;
    if (!outcome.ok) updateCheckSendFailure = updateErrorText(outcome.error.message);
    notifyUiEvent({ kind: 'update', frame: 'request' });
  });
}

export function applySettingsUpdateStatus(status: unknown): void {
  updateStatus = status as UpdateStatusView;
  isUpdateCheckInFlight = false;
  updateCheckSendFailure = null;
  updateRequest = reduceUpdateRequest(updateRequest, 'status-frame');
  notifyUiEvent({ kind: 'update', frame: 'status' });
}

export function applySettingsUpdateProgress(journal: unknown): void {
  updateJournal = journal as UpdateJournal;
  updateRequest = reduceUpdateRequest(updateRequest, 'progress-frame');
  notifyUiEvent({ kind: 'update', frame: 'progress' });
}

export function applySettingsUpdateError(message: { scope?: string; message: string }): boolean {
  if (message.scope !== 'update') return false;
  const errorText = updateErrorText(message.message);
  const wasApplyRequested = updateRequest.requested;
  updateRequest = reduceUpdateRequest(updateRequest, 'error-frame', errorText);
  isUpdateCheckInFlight = false;
  if (!wasApplyRequested) updateCheckSendFailure = errorText;
  notifyUiEvent({ kind: 'update', frame: 'error' });
  return true;
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

export function activateSettingsSection(
  sectionId: string | null = null,
  settingId: string | null = null,
  linkHash: string | null = null,
): void {
  const isPendingTargeted = pendingActivation !== null && (pendingActivation.sectionId !== null || pendingActivation.isLink);
  if (sectionId === null && linkHash === null && isPendingTargeted) return;
  pendingActivation = { sectionId, settingId, hashAtRequest: linkHash ?? location.hash, isLink: linkHash !== null };
  notifyUiEvent({ kind: 'activate' });
}

export function takePendingSettingsActivation(): SectionActivation | null {
  const activation = pendingActivation;
  pendingActivation = null;
  return activation;
}

export function setPhoneSettingsScreenProbe(probe: () => string): void {
  phoneSettingsScreenProbe = probe;
}

export function notifyPhoneSettingsScreenChanged(): void {
  for (const listener of [...phoneSettingsScreenListeners]) listener();
}

export function onPhoneSettingsScreenChanged(listener: () => void): () => void {
  phoneSettingsScreenListeners.add(listener);
  return () => {
    phoneSettingsScreenListeners.delete(listener);
  };
}

export function canReturnToSettingsList(): boolean {
  return isPhoneLayout() && phoneSettingsScreenProbe() === 'section';
}

export function returnToSettingsList(): void {
  if (!canReturnToSettingsList()) return;
  notifyUiEvent({ kind: 'return-to-list' });
}

export function refreshSettingsStatus(): void {
  notifyUiEvent({ kind: 'status' });
}
