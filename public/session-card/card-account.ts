import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import { errorMessage } from '#shared/text.ts';
import { agentAccountsOf, onAgentAccountsChanged } from '../agent-logins.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { button } from '../ui/button.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import type { SessionUi } from './card-registry.ts';
import { buildDialogShell } from './modal.ts';

type AccountSignIn = (agent: string, accountId: string | null) => void;
let openAccountSignIn: AccountSignIn | null = null;

export function setAccountSignIn(signIn: AccountSignIn) {
  openAccountSignIn = signIn;
}

function sessionAccountIdOf(ui: SessionUi): string | null {
  return ui.card.dataset.accountId ?? null;
}

function switchableAccountsOf(ui: SessionUi): AgentAccountStatus[] {
  if (!ui.agent || ui.card.dataset.ephemeral !== undefined) return [];
  return agentAccountsOf(ui.agent).filter((account) => !account.isPending);
}

function sessionAccountLabelOf(ui: SessionUi, accounts: readonly AgentAccountStatus[]): string {
  const accountId = sessionAccountIdOf(ui);
  return accounts.find((account) => account.accountId === accountId)?.label ?? accountId ?? 'This machine';
}

export function paintSessionAccount(ui: SessionUi) {
  const accounts = switchableAccountsOf(ui);
  const isShown = accounts.some((account) => account.accountId !== null) || sessionAccountIdOf(ui) !== null;
  const chip = ui.card.querySelector<HTMLElement>('.session-account');
  const switchButton = ui.card.querySelector<HTMLElement>('.session-account-switch');
  const menuItem = ui.card.querySelector<HTMLElement>('.overflow-switch-account');
  if (chip) {
    writeTextIfChanged(chip, isShown ? sessionAccountLabelOf(ui, accounts) : '');
    writeHiddenIfChanged(chip, !isShown);
  }
  if (switchButton) writeHiddenIfChanged(switchButton, !isShown);
  menuItem?.classList.toggle('visible', isShown);
}

export function setSessionAccount(sessionId: unknown, accountId: string | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (accountId) ui.card.dataset.accountId = accountId;
  if (!accountId) delete ui.card.dataset.accountId;
  paintSessionAccount(ui);
}

onAgentAccountsChanged(() => {
  for (const ui of sessionUIs.values()) paintSessionAccount(ui);
});

function buildAccountChoice(account: AgentAccountStatus, currentAccountId: string | null): HTMLLabelElement {
  const choice = el('label', 'dialog-checkbox-label');
  const radio = el('input');
  radio.type = 'radio';
  radio.name = 'session-account';
  radio.className = 'dialog-checkbox';
  radio.value = account.accountId ?? '';
  radio.checked = account.accountId === currentAccountId;
  const isSignedOut = account.login.state === 'signed-out';
  choice.append(radio, el('span', null, isSignedOut ? `${account.label} (signed out)` : account.label));
  return choice;
}

export function openSwitchAccountDialog(sessionId: string) {
  const ui = findSessionUi(sessionId);
  if (!ui?.agent) return;
  const agent = ui.agent;
  const accounts = switchableAccountsOf(ui);
  const currentAccountId = sessionAccountIdOf(ui);
  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Switch account' });
  const hint = el('p', 'dialog-message', 'Switching restarts the agent under the account you pick and resumes its conversation.');
  const listEl = el('fieldset', 'dialog-workspace-list');
  listEl.setAttribute('aria-label', 'Accounts');
  for (const account of accounts) listEl.append(buildAccountChoice(account, currentAccountId));
  const statusEl = el('div', 'dialog-hint');
  statusEl.setAttribute('role', 'status');
  const errorEl = el('div', 'dialog-error');
  const btnSignIn = button({ variant: 'secondary', label: 'Sign in', hidden: true });
  const btnSwitch = button({ variant: 'primary', label: 'Switch' });
  actions.append(btnSignIn, btnSwitch);
  dialog.append(hint, listEl, statusEl, errorEl, actions);

  const pickedAccountId = () => {
    const picked = listEl.querySelector<HTMLInputElement>('input:checked');
    if (!picked) return undefined;
    return picked.value === '' ? null : picked.value;
  };

  btnCancel.addEventListener('click', close);
  btnSignIn.addEventListener('click', () => {
    const accountId = pickedAccountId();
    close();
    openAccountSignIn?.(agent, accountId ?? null);
  });
  btnSwitch.addEventListener('click', () => {
    const accountId = pickedAccountId();
    if (accountId === undefined) return;
    errorEl.textContent = '';
    btnSignIn.hidden = true;
    btnSwitch.disabled = true;
    statusEl.textContent = 'Checking the sign-in, then restarting.';
    sendControlRequest('switch-session-account', { id: sessionId, accountId })
      .then((reply) => {
        if (!overlay.isConnected) return;
        if (reply.type === 'switch-session-account-result' && reply.ok) {
          close();
          return;
        }
        btnSwitch.disabled = false;
        statusEl.textContent = '';
        errorEl.textContent = reply.type === 'switch-session-account-result' ? reply.error ?? 'Could not switch the account.' : 'Unexpected reply';
        btnSignIn.hidden = openAccountSignIn === null || reply.type !== 'switch-session-account-result' || reply.needsSignIn !== true;
      })
      .catch((error) => {
        if (!overlay.isConnected) return;
        btnSwitch.disabled = false;
        statusEl.textContent = '';
        errorEl.textContent = `Could not switch the account: ${errorMessage(error)}`;
      });
  });
  requestAnimationFrame(() => btnCancel.focus());
}
