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
const FAILED_ACTION_TEXT = {
  connect: 'GitHub did not start a sign-in. The server log names why.',
  disconnect: 'Disconnect did not reach this host. The server log names why.',
} as const;

function buildGithubConnectSection(): HTMLElement {
  let connection: GithubConnection | null | 'reading' = 'reading';
  let isRequesting = false;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  const article = el('article', 'settings-view-setting');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', 'GitHub'));
  const description = el('p', 'settings-view-setting-description');
  text.append(heading, description);
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
  const controlRow = el('div', 'settings-telegram-test');
  controlRow.append(...GITHUB_CONNECT_CONTROLS.map((controlName) => buttonsByControl[controlName]), requestStatus.element);
  const control = el('div', 'settings-view-setting-control');
  control.append(controlRow);
  article.append(text, control);

  function paint(): void {
    const view = githubConnectViewOf(connection, clock.nowMs());
    description.textContent = view.text;
    for (const controlName of GITHUB_CONNECT_CONTROLS) {
      buttonsByControl[controlName].hidden = !view.controls.includes(controlName);
      buttonsByControl[controlName].disabled = isRequesting || (controlName === 'connect' && view.isConnectWaiting);
    }
    if (recheckTimer !== null) clearTimeout(recheckTimer);
    recheckTimer = null;
    if (view.recheckAfterMs === null) return;
    recheckTimer = setTimeout(() => {
      if (article.isConnected) void request('read');
    }, view.recheckAfterMs);
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
    } catch (reason) {
      if (connection === 'reading') connection = null;
      requestStatus.show('error', requestFailureText(reason, CONNECTION_REQUEST_TIMEOUT_MS));
    }
    isRequesting = false;
    paint();
  }

  paint();
  void request('read');
  return article;
}

export { buildGithubConnectSection };
