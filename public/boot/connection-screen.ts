import { refreshAgentAccounts } from '../agent-logins.ts';
import { clearHeaderError, reportHeaderError } from '../action-status.ts';
import { decideAppReveal, MAX_REVEAL_WAIT_MS } from '../app-reveal-core.ts';
import type { RevealInput } from '../app-reveal-core.ts';
import { refreshOpenAddSessionDialog } from '../dialogs.ts';
import { sendControlRequest, setConnectionStateCallback } from '../control-ws.ts';
import { onTenantWakingChange } from '../connection-supervisor.ts';
import { queryTag } from '../dom-helpers.ts';
import { revealFlyingAnimals } from '../flying-animals.ts';
import { refreshFirstRunChecklist, revealFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { countShownConnectingTerminals, onTerminalLinkChange } from '../session-card/terminal-data-socket.ts';
import { getActiveView } from '../ui-state-core.ts';
import { prefetchViewsWhenIdle, reloadOnceIfBundleRetired } from './view-registry.ts';
import { applyDashboardSettings, reportOperatorTimezone } from './dashboard-settings.ts';
import { playLoadingUnlock } from '../loading-unlock.ts';
import { activateSettingsHash } from './hash-routes.ts';
import { VIEW_TABS, refreshViewsIfVisible, resendUnsentShownView } from './view-tabs.ts';

const connectionEl = queryTag(document, '#connection-status', 'span');
const connectionLabel = queryTag(connectionEl, '.connection-label', 'span');

const loadingScreen = queryTag(document, '#loading-screen', 'div');
const loadingStatus = queryTag(document, '#loading-status', 'div');
const loadingDetail = queryTag(document, '#loading-detail', 'div');
const shutdownScreen = queryTag(document, '#shutdown-screen', 'div');
const shutdownStatus = queryTag(document, '#shutdown-status', 'div');
let appRevealed = false;
let controlConnectedAt: number | null = null;
const awaitedRevealInputs = new Set<RevealInput>(['snapshot', 'settings']);

function revealAppWhenTerminalsLive() {
  if (appRevealed || controlConnectedAt === null) return;
  const decision = decideAppReveal({
    awaitedInputCount: awaitedRevealInputs.size,
    connectingTerminalCount: countShownConnectingTerminals(),
    msSinceConnected: performance.now() - controlConnectedAt,
  });
  if (decision === 'reveal') revealApp();
}

function noteSnapshotReceived() {
  awaitedRevealInputs.delete('snapshot');
  revealAppWhenTerminalsLive();
}

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  prefetchViewsWhenIdle(VIEW_TABS);
  revealFlyingAnimals();
  revealFirstRunChecklist();
  playLoadingUnlock(loadingScreen).then(fadeOutLoadingScreen, fadeOutLoadingScreen);
}

function fadeOutLoadingScreen() {
  document.body.classList.add('app-revealed');
  loadingScreen.classList.add('fade-out');
  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', (event) => {
    if (event.target === loadingScreen) removeLoading();
  });
  setTimeout(removeLoading, 1000);
}

function showServerGoingDown(connectionText: string, overlayText: string) {
  connectionEl.dataset.state = 'shutdown';
  connectionLabel.textContent = connectionText;
  shutdownStatus.textContent = overlayText;
  shutdownScreen.classList.add('active');
}

const RECOVERING_CONNECTION_STATES = new Set(['disconnected', 'connecting', 'waking']);

function renderConnectionHeader(state: string, label: string, isReconnect: boolean) {
  connectionEl.dataset.state = state;
  connectionEl.toggleAttribute('data-reconnected', isReconnect);
  connectionLabel.textContent = label;
}

function showConnectionState(state: string, label: string) {
  const isReconnect = state === 'connected' && RECOVERING_CONNECTION_STATES.has(connectionEl.dataset.state ?? '');
  renderConnectionHeader(state, label, isReconnect);
}

function showLivenessProbeState(state: string, label: string) {
  if (connectionEl.dataset.state === 'shutdown' || isTenantWakingShown()) return;
  const headerState = state === 'verified' ? 'connected' : state;
  renderConnectionHeader(headerState, label, false);
}

const SERVER_UNREACHABLE_HINT_DELAY_MS = 10000;
const SERVER_ERROR_SOURCE = 'Server';
const SERVER_UNREACHABLE_TEXT = 'The server is not answering. Check the terminal running Glimmervoid for errors, or start it again with glimmervoid. This page reconnects on its own.';
const SERVER_UNREACHABLE_LOADING_DETAIL = 'Server not answering. Check the Glimmervoid terminal for errors, or run glimmervoid. This page retries on its own.';
let serverUnreachableHintTimer: number | null = null;
let isServerUnreachableHintShown = false;
let controlSocketState = 'disconnected';
const TENANT_WAKING_LABEL = 'Waking your machine';

function showTenantWaking() {
  clearServerUnreachableHint();
  renderConnectionHeader('waking', TENANT_WAKING_LABEL, false);
  if (!appRevealed) loadingStatus.textContent = TENANT_WAKING_LABEL;
}

function isTenantWakingShown() {
  return connectionEl.dataset.state === 'waking';
}

function noteTenantWakingChange(isWaking: boolean) {
  if (isWaking) {
    showTenantWaking();
    return;
  }
  if (!isTenantWakingShown()) return;
  showConnectionState('disconnected', 'Reconnecting');
  scheduleServerUnreachableHint();
  if (!appRevealed) showReconnectingLoadingStatus();
}

function showReconnectingLoadingStatus() {
  loadingStatus.textContent = 'Reconnecting to server...';
  loadingDetail.textContent = SERVER_UNREACHABLE_LOADING_DETAIL;
  loadingDetail.hidden = !isServerUnreachableHintShown;
}

function showServerUnreachableHint() {
  serverUnreachableHintTimer = null;
  isServerUnreachableHintShown = true;
  if (!appRevealed) {
    showReconnectingLoadingStatus();
    return;
  }
  reportHeaderError({ source: SERVER_ERROR_SOURCE, message: SERVER_UNREACHABLE_TEXT });
}

function scheduleServerUnreachableHint() {
  if (serverUnreachableHintTimer !== null || isServerUnreachableHintShown || isTenantWakingShown()) return;
  if (document.visibilityState !== 'visible') return;
  serverUnreachableHintTimer = window.setTimeout(showServerUnreachableHint, SERVER_UNREACHABLE_HINT_DELAY_MS);
}

function cancelServerUnreachableCountdown() {
  if (serverUnreachableHintTimer !== null) window.clearTimeout(serverUnreachableHintTimer);
  serverUnreachableHintTimer = null;
}

function restartServerUnreachableCountdownOnVisibilityChange() {
  cancelServerUnreachableCountdown();
  if (controlSocketState === 'connected') return;
  scheduleServerUnreachableHint();
}

function clearServerUnreachableHint() {
  cancelServerUnreachableCountdown();
  isServerUnreachableHintShown = false;
  loadingDetail.hidden = true;
  clearHeaderError(SERVER_ERROR_SOURCE);
}

function onControlConnected() {
  clearServerUnreachableHint();
  reloadOnceIfBundleRetired(import.meta.url, () => window.sessionStorage);
  resendUnsentShownView();
  if (shutdownScreen.classList.contains('active')) {
    location.reload();
    return;
  }
  refreshFirstRunChecklist();
  refreshOpenAddSessionDialog();
  refreshAgentAccounts();
  document.body.classList.add('app-ready');
  if (!appRevealed && controlConnectedAt === null) {
    controlConnectedAt = performance.now();
    loadingStatus.textContent = 'Connecting to sessions...';
    setTimeout(revealApp, MAX_REVEAL_WAIT_MS);
  }
  revealAppWhenTerminalsLive();

  refreshViewsIfVisible('connected');

  sendControlRequest('get-settings', {})
    .then((msg) => {
      if (!msg.settings) return;
      applyDashboardSettings(msg.settings);
      reportOperatorTimezone(msg.settings);
      if (getActiveView() === 'settings') activateSettingsHash(location.hash);
      awaitedRevealInputs.delete('settings');
      revealAppWhenTerminalsLive();
    })
    .catch(() => {});
}

function onConnectionStateChanged(state: string, label: string) {
  if (state === 'connecting' || state === 'verified') {
    showLivenessProbeState(state, label);
    return;
  }
  controlSocketState = state;
  for (const viewTab of VIEW_TABS) viewTab.onConnectionChange?.(state === 'connected');
  if (isTenantWakingShown() && state !== 'connected') return;
  showConnectionState(state, label);

  if (state === 'connected') {
    onControlConnected();
    return;
  }
  if (state === 'disconnected' && shutdownScreen.classList.contains('active')) {
    shutdownStatus.textContent = 'Waiting for server...';
    return;
  }
  scheduleServerUnreachableHint();
  if (!appRevealed) showReconnectingLoadingStatus();
}

function mountConnectionScreen() {
  onTerminalLinkChange(revealAppWhenTerminalsLive);
  setConnectionStateCallback(onConnectionStateChanged);
  onTenantWakingChange(noteTenantWakingChange);
  document.addEventListener('visibilitychange', restartServerUnreachableCountdownOnVisibilityChange);
}

export { SERVER_ERROR_SOURCE, mountConnectionScreen, noteSnapshotReceived, scheduleServerUnreachableHint, showServerGoingDown };
