import type { GithubConnection, GithubConnectionAction } from '#shared/contracts/watcher-link.ts';
import { createActionStatus, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { refreshWhileShown } from '../host-ready/host-ready-changes.ts';
import { button } from '../ui/button.ts';
import { clock } from '#shared/clock.ts';
import { GITHUB_CONNECT_CONTROLS, githubConnectViewOf } from './github-connect-core.ts';
import type { GithubConnectControl, GithubDeviceCode } from './github-connect-core.ts';

const CONNECTION_REQUEST_TIMEOUT_MS = 20_000;
const HIDDEN_UNANSWERED_RECHECK_MAX_MS = 60_000;
const FAILED_READ_RETRY_MS = 2_000;
const FAILED_ACTION_TEXT = {
  connect: 'GitHub did not start a sign-in. The server log names why.',
  disconnect: 'Disconnect did not reach this host. The server log names why.',
} as const;
const SETTING_DESCRIPTION_TEXT = 'Agents clone, push and open pull requests as the account you connect.';
const COPY_DONE_TEXT = 'Copied. Paste it on the GitHub page.';
const COPY_FAILED_TEXT = 'Copy did not work. Type the code on the GitHub page.';

function settingColumnsOf(connectionState: HTMLElement, deviceCodeBlock: HTMLElement, controlRow: HTMLElement): HTMLElement[] {
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', 'GitHub'));
  text.append(heading, el('p', 'settings-view-setting-description', SETTING_DESCRIPTION_TEXT), connectionState, deviceCodeBlock);
  const control = el('div', 'settings-view-setting-control');
  control.append(controlRow);
  return [text, control];
}

function isConnectOffered(connection: GithubConnection | null | 'reading'): boolean {
  if (connection === null || connection === 'reading') return false;
  return connection.state !== 'unavailable' || connection.reason !== 'no-app';
}

type GithubConnectLayout = 'setting' | 'stacked';
type GithubConnectOpening = 'read' | 'connect-when-signed-out';
const SIGNED_OUT_STATES: ReadonlySet<GithubConnection['state']> = new Set(['disconnected', 'reconnect-needed']);
type GithubConnectOptions = { layout?: GithubConnectLayout; isHiddenWithoutConnect?: boolean; opening?: GithubConnectOpening; onConnectionChange?: (connection: GithubConnection | null) => void };

type DeviceCodeBlock = { element: HTMLElement; paint: (deviceCode: GithubDeviceCode | null, isCodeComing: boolean) => void };
const PENDING_CODE_TEXT = 'XXXX-XXXX';

function buildDeviceCodeBlock(): DeviceCodeBlock {
  let shownDeviceCode: GithubDeviceCode | null = null;
  const element = el('div', 'github-device-code');
  const codeText = el('span', 'github-device-code-value');
  const copyStatus = createActionStatus('settings-vault-test-status');
  const copyAndOpenButton = button({ variant: 'primary', label: 'Copy code and open GitHub', action: 'github-copy-code-open-device-page', onClick: copyCodeAndOpenGithub });
  const copyStatusSlot = el('div', 'github-device-code-status');
  copyStatusSlot.append(copyStatus.element);
  element.append(el('span', 'github-device-code-step', 'Approve on GitHub'), codeText, copyAndOpenButton, copyStatusSlot);

  function copyCodeAndOpenGithub(): void {
    if (shownDeviceCode === null) return;
    const clipboardWrite = writeClipboardText(shownDeviceCode.userCode) ?? Promise.reject(new Error('This browser has no clipboard access.'));
    openExternalUrl(shownDeviceCode.verificationUri);
    clipboardWrite.then(() => copyStatus.show('ok', COPY_DONE_TEXT), () => copyStatus.show('error', COPY_FAILED_TEXT));
  }

  function paint(deviceCode: GithubDeviceCode | null, isCodeComing: boolean): void {
    element.hidden = deviceCode === null && !isCodeComing;
    if (deviceCode?.userCode !== shownDeviceCode?.userCode) copyStatus.clear();
    shownDeviceCode = deviceCode;
    codeText.textContent = deviceCode?.userCode ?? PENDING_CODE_TEXT;
    codeText.dataset.state = deviceCode === null ? 'pending' : 'ready';
    copyAndOpenButton.disabled = deviceCode === null;
  }

  return { element, paint };
}

function buildGithubConnectSection({ layout = 'setting', isHiddenWithoutConnect = false, opening = 'read', onConnectionChange = () => {} }: GithubConnectOptions = {}): HTMLElement {
  let connection: GithubConnection | null | 'reading' = 'reading';
  let isRequesting = false;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenUnansweredRecheckMs = 0;
  const article = layout === 'stacked' ? el('div', 'github-connect-stacked') : el('article', 'settings-view-setting');
  const connectionState = el('p', layout === 'stacked' ? 'github-connect-stacked-status' : 'settings-view-setting-description github-connect-state');
  const deviceCodeBlock = buildDeviceCodeBlock();
  const requestStatus = createActionStatus('settings-vault-test-status');
  const buttonsByControl: Record<GithubConnectControl, HTMLButtonElement> = {
    connect: button({ variant: 'primary', label: 'Connect GitHub', action: 'github-connect', onClick: () => { void request('connect'); } }),
    install: button({ variant: 'secondary', label: 'Install the App', action: 'github-install-app', onClick: openInstallPage }),
    'add-accounts': button({ variant: 'quiet', label: 'Add accounts', action: 'github-install-app', onClick: openInstallPage }),
    disconnect: button({ variant: 'secondary', label: 'Disconnect', action: 'github-disconnect', onClick: () => { void request('disconnect'); } }),
  };
  const controlRow = el('div', layout === 'stacked' ? 'github-connect-stacked-actions' : 'settings-telegram-test');
  controlRow.append(...GITHUB_CONNECT_CONTROLS.map((controlName) => buttonsByControl[controlName]), requestStatus.element);
  article.append(...(layout === 'stacked' ? [connectionState, deviceCodeBlock.element, controlRow] : settingColumnsOf(connectionState, deviceCodeBlock.element, controlRow)));

  function openInstallPage(): void {
    if (connection !== null && connection !== 'reading' && (connection.state === 'needs-install' || connection.state === 'connected')) openExternalUrl(connection.installUrl);
  }

  function paint(): void {
    const view = githubConnectViewOf(connection, clock.nowMs());
    article.hidden = isHiddenWithoutConnect && !isConnectOffered(connection);
    connectionState.textContent = view.text;
    deviceCodeBlock.paint(view.deviceCode, isCodeComing());
    for (const controlName of GITHUB_CONNECT_CONTROLS) {
      buttonsByControl[controlName].hidden = !view.controls.includes(controlName);
      buttonsByControl[controlName].disabled = isRequesting || (controlName === 'connect' && view.isConnectWaiting);
    }
    controlRow.hidden = opening === 'read' && view.controls.length === 0 && requestStatus.element.textContent === '';
    scheduleRecheck(recheckDelayOf(view.recheckAfterMs));
  }

  function isCodeComing(): boolean {
    if (opening !== 'connect-when-signed-out' || connection === null) return false;
    return connection === 'reading' || SIGNED_OUT_STATES.has(connection.state);
  }

  function scheduleRecheck(recheckAfterMs: number | null): void {
    if (recheckTimer !== null) clearTimeout(recheckTimer);
    recheckTimer = null;
    if (recheckAfterMs === null) return;
    recheckTimer = setTimeout(() => {
      if (article.isConnected) void request('read');
    }, recheckAfterMs);
  }

  function recheckOnceShown(): void {
    if (!article.isConnected) {
      document.removeEventListener('visibilitychange', recheckOnceShown);
      return;
    }
    if (document.visibilityState !== 'visible' || recheckTimer === null) return;
    void request('read');
  }

  function recheckDelayOf(viewRecheckAfterMs: number | null): number | null {
    if (viewRecheckAfterMs === null) return null;
    if (!article.hidden) {
      hiddenUnansweredRecheckMs = 0;
      return viewRecheckAfterMs;
    }
    if (connection !== null) return null;
    hiddenUnansweredRecheckMs = Math.min(HIDDEN_UNANSWERED_RECHECK_MAX_MS, Math.max(viewRecheckAfterMs, hiddenUnansweredRecheckMs * 2));
    return hiddenUnansweredRecheckMs;
  }

  async function request(action: GithubConnectionAction): Promise<void> {
    if (action !== 'read') {
      isRequesting = true;
      requestStatus.show('busy', action === 'connect' ? 'Asking GitHub for a code.' : 'Disconnecting.');
      paint();
    }
    try {
      const reply = await sendControlRequest('github-connection', { action }, { timeoutMs: CONNECTION_REQUEST_TIMEOUT_MS });
      if (reply.type !== 'github-connection-result') throw new Error('The server sent an unexpected reply.');
      if (action !== 'read' && reply.connection === null) throw new Error(FAILED_ACTION_TEXT[action]);
      connection = reply.connection;
      requestStatus.clear();
      onConnectionChange(connection);
    } catch (reason) {
      if (connection === 'reading') connection = null;
      if (action === 'read') return retryFailedRead();
      requestStatus.show('error', requestFailureText(reason, CONNECTION_REQUEST_TIMEOUT_MS));
    }
    isRequesting = false;
    paint();
  }

  function retryFailedRead(): void {
    paint();
    scheduleRecheck(FAILED_READ_RETRY_MS);
  }

  async function open(): Promise<void> {
    await request('read');
    if (opening !== 'connect-when-signed-out' || connection === null || connection === 'reading' || !SIGNED_OUT_STATES.has(connection.state)) return;
    await request('connect');
  }

  paint();
  void open();
  refreshWhileShown(article, () => { if (!isRequesting) void request('read'); });
  document.addEventListener('visibilitychange', recheckOnceShown);
  return article;
}

export { buildGithubConnectSection, isConnectOffered };
