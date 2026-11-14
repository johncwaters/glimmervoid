import './host-ready.css';

import type { HostReady, HostReadyFix } from '#shared/contracts/host-ready.ts';
import type { CommitSigningAction } from '#shared/contracts/commit-signing.ts';
import { createActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { settingsHash } from '../settings/settings-link.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { button } from '../ui/button.ts';
import { refreshWhileShown } from './host-ready-changes.ts';
import { FIX_LABELS, HOST_READY_FIXES, hostReadyRowViewsOf } from './host-ready-core.ts';
import type { HostReadyRowView } from './host-ready-core.ts';

const READ_TIMEOUT_MS = 20_000;
const SIGNING_REQUEST_TIMEOUT_MS = 45_000;
const GITHUB_CONNECTION_SECTION_ID = 'machine-vault';
const SIGNING_ACTION_BY_FIX: Readonly<Record<Exclude<HostReadyFix, 'connect-github'>, CommitSigningAction>> = Object.freeze({ 'set-up-signing': 'setup', 'register-signing': 'register' });
const BUSY_TEXT_BY_FIX: Readonly<Record<Exclude<HostReadyFix, 'connect-github'>, string>> = Object.freeze({ 'set-up-signing': 'Setting up commit signing.', 'register-signing': 'Registering the key on GitHub.' });

type HostReadyRows = { element: HTMLElement; refresh: () => Promise<void> };

function openGithubConnectionInSettings(): void {
  location.hash = settingsHash(GITHUB_CONNECTION_SECTION_ID);
}

export function buildHostReadyRows({ openGithubConnection = openGithubConnectionInSettings }: { openGithubConnection?: () => void } = {}): HostReadyRows {
  let hostReady: HostReady | null = null;
  let isRequesting = false;
  const section = el('section', 'host-ready');
  const list = el('div', 'host-ready-rows');
  const readStatus = createActionStatus('host-ready-status');
  section.append(el('h2', 'host-ready-title', 'Ready to commit as you'), list, readStatus.element);

  function buildFixControls(view: HostReadyRowView, rowStatus: ActionStatus): readonly HTMLElement[] {
    return HOST_READY_FIXES.filter((fix) => fix === view.fix).map((fix) => {
      const fixButton = button({ variant: 'secondary', label: FIX_LABELS[fix], action: `host-ready-${fix}`, onClick: () => { void runFix(fix, rowStatus); } });
      fixButton.disabled = isRequesting;
      return fixButton;
    });
  }

  function buildRow(view: HostReadyRowView): HTMLElement {
    const row = el('div', 'host-ready-row');
    row.dataset.hostReadyState = view.state;
    const mark = el('span', 'host-ready-mark');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', view.stateWord);
    paintStatusIcon(mark, view.stateIcon);
    const rowStatus = createActionStatus('host-ready-status');
    const controls = el('div', 'host-ready-controls');
    controls.append(...buildFixControls(view, rowStatus), rowStatus.element);
    const body = el('div', 'host-ready-body');
    const name = el('span', 'host-ready-name');
    name.append(mark, view.title);
    body.append(name, el('p', 'host-ready-text', view.text));
    row.append(body, controls);
    return row;
  }

  function paint(): void {
    list.replaceChildren(...hostReadyRowViewsOf(hostReady).map(buildRow));
  }

  function setRequesting(isNowRequesting: boolean): void {
    isRequesting = isNowRequesting;
    for (const fixButton of list.querySelectorAll('button')) fixButton.disabled = isNowRequesting;
  }

  async function refresh(): Promise<void> {
    try {
      const reply = await sendControlRequest('host-ready', {}, { timeoutMs: READ_TIMEOUT_MS });
      if (reply.type !== 'host-ready-result') throw new Error('The server sent an unexpected reply.');
      hostReady = reply.hostReady;
      readStatus.clear();
      if (hostReady === null) readStatus.show('error', 'This host did not answer about its git setup.');
    } catch (reason) {
      readStatus.show('error', requestFailureText(reason, READ_TIMEOUT_MS));
    }
    paint();
  }

  async function runFix(fix: HostReadyFix, rowStatus: ActionStatus): Promise<void> {
    if (fix === 'connect-github') return openGithubConnection();
    setRequesting(true);
    rowStatus.show('busy', BUSY_TEXT_BY_FIX[fix]);
    try {
      const reply = await sendControlRequest('commit-signing', { action: SIGNING_ACTION_BY_FIX[fix] }, { timeoutMs: SIGNING_REQUEST_TIMEOUT_MS });
      if (reply.type !== 'commit-signing-result') throw new Error('The server sent an unexpected reply.');
      isRequesting = false;
      await refresh();
    } catch (reason) {
      rowStatus.show('error', requestFailureText(reason, SIGNING_REQUEST_TIMEOUT_MS));
      setRequesting(false);
    }
  }

  readStatus.show('busy', 'Reading this host.');
  void refresh();
  refreshWhileShown(section, () => { if (!isRequesting) void refresh(); });
  return { element: section, refresh };
}
