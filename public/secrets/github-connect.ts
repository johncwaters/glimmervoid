import type { GithubConnection, GithubConnectionAction } from '#shared/contracts/watcher-link.ts';
import { createActionStatus, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { button } from '../ui/button.ts';
import { clock } from '#shared/clock.ts';
import { GITHUB_CONNECT_CONTROLS, githubConnectViewOf } from './github-connect-core.ts';
import type { GithubConnectControl } from './github-connect-core.ts';

const CONNECTION_REQUEST_TIMEOUT_MS = 20_000;
const HIDDEN_UNANSWERED_RECHECK_MAX_MS = 60_000;
const FAILED_READ_RETRY_MS = 2_000;
const FAILED_ACTION_TEXT = {
  connect: 'GitHub did not start a sign-in. The server log names why.',
  disconnect: 'Disconnect did not reach this host. The server log names why.',
} as const;

function settingColumnsOf(description: HTMLElement, controlRow: HTMLElement): HTMLElement[] {
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', 'GitHub'));
  text.append(heading, description);
  const control = el('div', 'settings-view-setting-control');
  control.append(controlRow);
  return [text, control];
}

function isConnectOffered(connection: GithubConnection | null | 'reading'): boolean {
  if (connection === null || connection === 'reading') return false;
  return connection.state !== 'unavailable' || connection.reason !== 'no-app';
}

type GithubConnectLayout = 'setting' | 'stacked';
type GithubConnectOptions = { layout?: GithubConnectLayout; isHiddenWithoutConnect?: boolean; onConnectionChange?: (connection: GithubConnection | null) => void };

function buildGithubConnectSection({ layout = 'setting', isHiddenWithoutConnect = false, onConnectionChange = () => {} }: GithubConnectOptions = {}): HTMLElement {
  let connection: GithubConnection | null | 'reading' = 'reading';
  let isRequesting = false;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenUnansweredRecheckMs = 0;
  const article = layout === 'stacked' ? el('div', 'github-connect-stacked') : el('article', 'settings-view-setting');
  const description = el('p', layout === 'stacked' ? 'github-connect-stacked-status' : 'settings-view-setting-description');
  const requestStatus = createActionStatus('settings-vault-test-status');
  const buttonsByControl: Record<GithubConnectControl, HTMLButtonElement> = {
    connect: button({ variant: 'primary', label: 'Connect GitHub', action: 'github-connect', onClick: () => { void request('connect'); } }),
    'open-github': button({ variant: 'secondary', label: 'Open GitHub', action: 'github-open-device-page', onClick: () => {
      if (connection !== null && connection !== 'reading' && connection.state === 'awaiting-code') openExternalUrl(connection.verificationUri);
    } }),
    install: button({ variant: 'secondary', label: 'Install the App', action: 'github-install-app', onClick: () => {
      if (connection !== null && connection !== 'reading' && (connection.state === 'needs-install' || connection.state === 'connected')) openExternalUrl(connection.installUrl);
    } }),
    disconnect: button({ variant: 'secondary', label: 'Disconnect', action: 'github-disconnect', onClick: () => { void request('disconnect'); } }),
  };
  const controlRow = el('div', layout === 'stacked' ? 'github-connect-stacked-actions' : 'settings-telegram-test');
  controlRow.append(...GITHUB_CONNECT_CONTROLS.map((controlName) => buttonsByControl[controlName]), requestStatus.element);
  article.append(...(layout === 'stacked' ? [description, controlRow] : settingColumnsOf(description, controlRow)));

  function paint(): void {
    const view = githubConnectViewOf(connection, clock.nowMs());
    article.hidden = isHiddenWithoutConnect && !isConnectOffered(connection);
    description.textContent = view.text;
    for (const controlName of GITHUB_CONNECT_CONTROLS) {
      buttonsByControl[controlName].hidden = !view.controls.includes(controlName);
      buttonsByControl[controlName].disabled = isRequesting || (controlName === 'connect' && view.isConnectWaiting);
    }
    controlRow.hidden = view.controls.length === 0 && requestStatus.element.textContent === '';
    scheduleRecheck(recheckDelayOf(view.recheckAfterMs));
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

  paint();
  void request('read');
  document.addEventListener('visibilitychange', recheckOnceShown);
  return article;
}

export { buildGithubConnectSection };
