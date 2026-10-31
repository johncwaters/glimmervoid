import { clearHeaderError, reportHeaderError } from '../action-status.ts';
import { decideAppReveal, MAX_REVEAL_WAIT_MS } from '../app-reveal-core.ts';
import { sendControlRequest, setConnectionStateCallback } from '../control-ws.ts';
import { queryTag } from '../dom-helpers.ts';
import { buildFlyingAnimalPreview, pickRandomIncludedAnimal } from '../flying-animal-preview.ts';
import { revealFlyingAnimals } from '../flying-animals.ts';
import { refreshFirstRunChecklist, revealFirstRunChecklist } from '../onboarding/first-run-loader.ts';
import { applyPlanConnectionState } from '../session-card/lifecycle.ts';
import { countShownConnectingTerminals, onTerminalLinkChange } from '../session-card/terminal.ts';
import { preloadShownFaceWhenIdle } from '../shown-files.ts';
import { getActiveView } from '../ui-state-core.ts';
import { prefetchViewsWhenIdle, reloadOnceIfBundleRetired } from '../view-registry.ts';
import { applyDashboardSettings } from './dashboard-settings.ts';
import { activateSettingsHash } from './hash-routes.ts';
import { disablePowerButton } from './power-menu.ts';
import { VIEW_TABS, refreshViewsIfVisible, resendUnsentShownView } from './view-tabs.ts';
import { sendFocusState } from './viewer-focus.ts';

const connectionEl = queryTag(document, '#connection-status', 'span');
const connectionLabel = queryTag(connectionEl, '.connection-label', 'span');

const loadingScreen = queryTag(document, '#loading-screen', 'div');
const loadingStatus = queryTag(document, '#loading-status', 'div');
const loadingDetail = queryTag(document, '#loading-detail', 'div');
const shutdownScreen = queryTag(document, '#shutdown-screen', 'div');
const shutdownStatus = queryTag(document, '#shutdown-status', 'div');
let appRevealed = false;
let controlConnectedAt: number | null = null;
let hasReceivedSnapshot = false;

function showLoadingAnimal() {
  const animal = pickRandomIncludedAnimal();
  const spinner = loadingScreen.querySelector('.loading-spinner');
  if (!animal || !spinner) return;
  spinner.replaceWith(buildFlyingAnimalPreview(animal, 'loading-animal'));
}

function revealAppWhenTerminalsLive() {
  if (appRevealed || controlConnectedAt === null) return;
  const decision = decideAppReveal({
    hasSnapshot: hasReceivedSnapshot,
    connectingTerminalCount: countShownConnectingTerminals(),
    msSinceConnected: performance.now() - controlConnectedAt,
  });
  if (decision === 'reveal') revealApp();
}

function noteSnapshotReceived() {
  hasReceivedSnapshot = true;
  revealAppWhenTerminalsLive();
}

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  loadingScreen.classList.add('fade-out');
  prefetchViewsWhenIdle(VIEW_TABS);
  preloadShownFaceWhenIdle();
  revealFlyingAnimals();
  revealFirstRunChecklist();

  const removeLoading = () => loadingScreen.remove();
  loadingScreen.addEventListener('transitionend', removeLoading, { once: true });
  setTimeout(removeLoading, 1000);
}

function showServerGoingDown(connectionText: string, overlayText: string) {
  connectionEl.dataset.state = 'shutdown';
  connectionLabel.textContent = connectionText;
  connectionEl.title = connectionText;
  disablePowerButton();
  shutdownStatus.textContent = overlayText;
  shutdownScreen.classList.add('active');
}

const RECOVERING_CONNECTION_STATES = new Set(['disconnected', 'connecting']);

function renderConnectionHeader(state: string, label: string, isReconnect: boolean) {
  connectionEl.dataset.state = state;
  connectionEl.toggleAttribute('data-reconnected', isReconnect);
  connectionLabel.textContent = label;
  connectionEl.title = label;
}

function showConnectionState(state: string, label: string) {
  const isReconnect = state === 'connected' && RECOVERING_CONNECTION_STATES.has(connectionEl.dataset.state ?? '');
  renderConnectionHeader(state, label, isReconnect);
}

function showLivenessProbeState(state: string, label: string) {
  if (connectionEl.dataset.state === 'shutdown') return;
  const headerState = state === 'verified' ? 'connected' : state;
  renderConnectionHeader(headerState, label, false);
}

const SERVER_UNREACHABLE_HINT_DELAY_MS = 10000;
const SERVER_ERROR_SOURCE = 'Server';
const SERVER_UNREACHABLE_TEXT = 'The server is not answering. Check the terminal running Glimmervoid for errors, or start it again with glimmervoid. This page reconnects on its own.';
const SERVER_UNREACHABLE_LOADING_DETAIL = 'Server not answering. Check the Glimmervoid terminal for errors, or run glimmervoid. This page retries on its own.';
let serverUnreachableHintTimer: number | null = null;
let isServerUnreachableHintShown = false;

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
  reportHeaderError({ source: SERVER_ERROR_SOURCE, message: SERVER_UNREACHABLE_TEXT, hidesInStreamerMode: false });
}

function scheduleServerUnreachableHint() {
  if (serverUnreachableHintTimer !== null || isServerUnreachableHintShown) return;
  serverUnreachableHintTimer = window.setTimeout(showServerUnreachableHint, SERVER_UNREACHABLE_HINT_DELAY_MS);
}

function clearServerUnreachableHint() {
  if (serverUnreachableHintTimer !== null) window.clearTimeout(serverUnreachableHintTimer);
  serverUnreachableHintTimer = null;
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
  document.body.classList.add('app-ready');
  if (!appRevealed && controlConnectedAt === null) {
    controlConnectedAt = performance.now();
    loadingStatus.textContent = 'Connecting to sessions...';
    setTimeout(revealApp, MAX_REVEAL_WAIT_MS);
  }
  revealAppWhenTerminalsLive();
  sendFocusState();

  refreshViewsIfVisible('connected');

  sendControlRequest('get-settings', {})
    .then((msg) => {
      if (!msg.settings) return;
      applyDashboardSettings(msg.settings);
      if (getActiveView() === 'settings') activateSettingsHash(location.hash);
    })
    .catch(() => {});
}

function onConnectionStateChanged(state: string, label: string) {
  if (state === 'connecting' || state === 'verified') {
    showLivenessProbeState(state, label);
    return;
  }
  showConnectionState(state, label);
  applyPlanConnectionState(state === 'connected');
  for (const viewTab of VIEW_TABS) viewTab.onConnectionChange?.(state === 'connected');

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
  showLoadingAnimal();
  onTerminalLinkChange(revealAppWhenTerminalsLive);
  setConnectionStateCallback(onConnectionStateChanged);
}

export { SERVER_ERROR_SOURCE, mountConnectionScreen, noteSnapshotReceived, scheduleServerUnreachableHint, showServerGoingDown };
