import './settings-accounts.css';

import { LANE_ACCOUNT_AGENT_ID, LaneAccountLane } from '#shared/contracts/agent-accounts.ts';
import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import type { ActionStatus } from '../action-status.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import { agentAccountsOf, applyAgentAccounts, CONNECTABLE_AGENT_NAMES } from '../agent-logins.ts';
import { openAgentAccountDialog } from '../dialogs.ts';
import { el } from '../dom-helpers.ts';
import { accountColourOf } from '../agent-account-colour.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { buildDialogShell, openConfirmDialog } from '../session-card/modal.ts';
import { button, menuButton } from '../ui/button.ts';
import { radio } from '../ui/checkbox.ts';
import { buildMenuItem, popupMenu } from '../ui/popup-menu.ts';
import { accountPlanLimitsOf } from '../usage/usage-store.ts';
import { NO_VALUE, planWindowOf, planWindowTone } from '../usage/usage-store-core.ts';
import type { PlanLimits, PlanLimitsVendor } from '../usage/usage-store-core.ts';
import { buildMeter } from '../usage/usage-panel-parts.ts';
import { select } from '../ui/select.ts';
import { textInput } from '../ui/text-input.ts';

type AccountAgent = 'claude-code' | 'codex';
type LoginState = AgentAccountStatus['login']['state'];

const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude-code', 'codex'];

const LANE_TITLES: Readonly<Record<LaneAccountLane, string>> = Object.freeze({
  'team-review': 'Team review',
  radar: 'Radar',
  community: 'Community',
  'task-title': 'Task titles',
  'question-manager': 'Question manager',
});

const LANE_DESCRIPTIONS: Readonly<Record<LaneAccountLane, string>> = Object.freeze({
  'team-review': 'Reviews the pull requests your teams are asked on.',
  radar: 'Investigates PostHog errors and traffic spikes.',
  community: 'Researches community questions and drafts replies.',
  'task-title': 'Names session cards from their first prompt.',
  'question-manager': 'Answers the questions sessions hold for you.',
});

const LOGIN_STATE_TEXT: Readonly<Record<LoginState, string>> = Object.freeze({
  'signed-in': 'Signed in',
  'signed-out': 'Not signed in',
  connecting: 'Signing in',
  failed: 'Sign-in failed',
  unchecked: 'Sign-in not checked',
});

const FOLLOWS_DEFAULT_VALUE = 'default';
const MACHINE_LOGIN_VALUE = 'machine';

const accountActionStatus = createActionStatus('settings-agent-accounts-status');
const laneActionStatus = createActionStatus('settings-lane-accounts-status');

async function removeAgentAccount(account: AgentAccountStatus) {
  const reply = await requestWithStatus('agent-account-remove', { accountId: account.accountId }, accountActionStatus, { busyText: `Removing ${account.label}.` });
  if (reply?.type !== 'agent-accounts') return;
  applyAgentAccounts(reply.accounts);
  if (reply.error) accountActionStatus.show('error', reply.error);
}

async function makeAgentAccountDefault(agent: AccountAgent, account: AgentAccountStatus) {
  const reply = await requestWithStatus('agent-account-default', { agent, accountId: account.accountId }, accountActionStatus, { busyText: `Making ${account.label} the default.` });
  if (reply?.type !== 'agent-accounts') return;
  applyAgentAccounts(reply.accounts);
  if (reply.error) accountActionStatus.show('error', reply.error);
}

function confirmAccountRemoval(agent: AccountAgent, account: AgentAccountStatus) {
  openConfirmDialog({
    title: `Remove ${account.label}?`,
    message: account.usedBy.length > 0
      ? `${account.label} is in use by ${account.usedBy.join(', ')}. Switch those sessions to another account or close them first.`
      : `Glimmervoid forgets ${account.label}. An account added here is also signed out and its folder deleted. Your settings, skills, plugins and conversations stay with ${CONNECTABLE_AGENT_NAMES[agent]} on this machine.`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: () => { void removeAgentAccount(account); },
  });
}

async function renameAgentAccount(accountId: string, label: string): Promise<string | null> {
  const reply = await requestWithStatus('agent-account-rename', { accountId, label }, accountActionStatus, { busyText: `Renaming ${label}.` });
  if (reply?.type !== 'agent-accounts') return 'Could not rename the account.';
  applyAgentAccounts(reply.accounts);
  return reply.error ?? null;
}

function openRenameDialog(accountId: string, currentLabel: string) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: `Rename ${currentLabel}` });
  const input = textInput({ value: currentLabel, label: 'Account name' });
  const errorText = el('div', 'dialog-error');
  errorText.setAttribute('role', 'alert');
  const btnRename = button({ variant: 'primary', label: 'Rename', action: 'rename-agent-account' });
  actions.append(btnRename);
  dialog.append(input, errorText, actions);
  async function submitRename() {
    btnRename.disabled = true;
    const error = await renameAgentAccount(accountId, input.value);
    btnRename.disabled = false;
    if (error === null) {
      close();
      return;
    }
    errorText.textContent = error;
  }
  btnCancel.addEventListener('click', close);
  btnRename.addEventListener('click', () => { void submitRename(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submitRename();
  });
  requestAnimationFrame(() => input.select());
}

function accountSubText(account: AgentAccountStatus) {
  if (account.login.state !== 'signed-in') return LOGIN_STATE_TEXT[account.login.state];
  return [account.plan, account.detail].filter((part) => part !== null && part !== '').join(' \u00b7 ');
}

function buildAccountMenu(agent: AccountAgent, account: AgentAccountStatus, accountId: string, signal: AbortSignal) {
  const wrap = el('div', 'settings-accounts-menu');
  const trigger = menuButton({ label: `${account.label} actions`, action: 'agent-account-menu' });
  const menu = el('div', 'popup-menu settings-accounts-menu-panel');
  const renameItem = buildMenuItem('Rename', 'settings-accounts-menu-item');
  renameItem.addEventListener('click', () => openRenameDialog(accountId, account.label));
  const signInItem = buildMenuItem('Sign in again', 'settings-accounts-menu-item');
  signInItem.addEventListener('click', () => openAgentAccountDialog(agent, accountId));
  const removeItem = buildMenuItem('Remove', 'settings-accounts-menu-item', { tone: 'danger' });
  removeItem.addEventListener('click', () => confirmAccountRemoval(agent, account));
  menu.append(renameItem, signInItem, removeItem);
  popupMenu({ trigger, menu, signal });
  wrap.append(trigger, menu);
  return wrap;
}

function buildAccountDefaultRadio(agent: AccountAgent, account: AgentAccountStatus) {
  return radio({
    name: `settings-default-account-${agent}`,
    value: account.accountId ?? MACHINE_LOGIN_VALUE,
    label: '',
    accessibleName: `Make ${account.label} the default`,
    checked: account.isDefault,
    disabled: account.isPending,
    onSelect: () => { void makeAgentAccountDefault(agent, account); },
  }).element;
}

const PLAN_VENDOR_BY_AGENT: Readonly<Record<AccountAgent, PlanLimitsVendor>> = Object.freeze({ 'claude-code': 'claude', codex: 'codex' });

const PLAN_WINDOW_LABELS: Readonly<Record<'fiveHour' | 'sevenDay', string>> = Object.freeze({ fiveHour: '5h', sevenDay: '7d' });

function buildPlanWindowMeter(planLimits: PlanLimits, key: 'fiveHour' | 'sevenDay', accountLabel: string) {
  const usedPct = planWindowOf(planLimits, key)?.pct ?? null;
  const line = el('div', 'settings-accounts-meter');
  const percentText = usedPct === null ? NO_VALUE : `${Math.round(usedPct)}%`;
  line.append(
    el('span', 'settings-accounts-meter-label', PLAN_WINDOW_LABELS[key]),
    buildMeter(usedPct ?? 0, planWindowTone(usedPct), `${accountLabel} ${PLAN_WINDOW_LABELS[key]} plan limit used`),
    el('span', 'settings-accounts-meter-value', percentText),
  );
  return line;
}

function buildPlanMeters(agent: AccountAgent, account: AgentAccountStatus) {
  const planLimits = accountPlanLimitsOf(PLAN_VENDOR_BY_AGENT[agent], account.accountId);
  if (planLimits === null) return el('div', 'settings-accounts-no-reading', 'No reading yet');
  const meters = el('div', 'settings-accounts-meters');
  meters.append(buildPlanWindowMeter(planLimits, 'fiveHour', account.label), buildPlanWindowMeter(planLimits, 'sevenDay', account.label));
  return meters;
}

function buildAccountRow(agent: AccountAgent, account: AgentAccountStatus, hasDefaultChoice: boolean, signal: AbortSignal) {
  const row = el('div', 'settings-accounts-row');
  const isSignedIn = account.login.state === 'signed-in';
  row.dataset.signedIn = String(isSignedIn);
  row.dataset.hasDefaultChoice = String(hasDefaultChoice);
  if (hasDefaultChoice) row.append(buildAccountDefaultRadio(agent, account));
  const swatch = el('span', 'settings-accounts-swatch');
  swatch.style.background = accountColourOf(account.accountId);
  const name = el('div', 'settings-accounts-name');
  name.append(swatch, account.label);
  const body = el('div', 'settings-accounts-body');
  body.append(name, el('div', 'settings-accounts-sub', accountSubText(account)));
  const actionSlot = el('div', 'settings-accounts-action');
  const accountId = account.accountId;
  if (isSignedIn) actionSlot.append(buildPlanMeters(agent, account));
  if (!isSignedIn && !account.isPending && accountId !== null) {
    actionSlot.append(button({ variant: 'secondary', size: 'small', label: 'Sign in', action: 'sign-in-agent-account', onClick: () => openAgentAccountDialog(agent, accountId) }));
  }
  const menuSlot = accountId === null || account.isPending ? el('span') : buildAccountMenu(agent, account, accountId, signal);
  row.append(body, actionSlot, menuSlot);
  return row;
}

function buildAgentCard(agent: AccountAgent, signal: AbortSignal) {
  const card = el('section', 'settings-accounts-card');
  const head = el('div', 'settings-accounts-card-head');
  const agentMark = el('span', 'agent-mark');
  agentMark.setAttribute('aria-hidden', 'true');
  paintAgentMark(agentMark, agent, CONNECTABLE_AGENT_NAMES[agent]);
  const title = el('h3', 'settings-accounts-card-title');
  title.append(agentMark, CONNECTABLE_AGENT_NAMES[agent]);
  head.append(title, button({ variant: 'primary', size: 'small', label: 'Add account', action: 'add-agent-account', onClick: () => openAgentAccountDialog(agent) }));
  const accounts = agentAccountsOf(agent);
  const hasDefaultChoice = accounts.filter((account) => !account.isPending).length > 1;
  card.append(head, ...accounts.map((account) => buildAccountRow(agent, account, hasDefaultChoice, signal)));
  return card;
}

function optionValueOf(account: AgentAccountStatus): string {
  return account.accountId === null ? MACHINE_LOGIN_VALUE : `account:${account.accountId}`;
}

function chosenValueOf(lane: LaneAccountLane, accounts: readonly AgentAccountStatus[]): string {
  const pinned = accounts.find((account) => account.lanes.includes(lane));
  return pinned ? optionValueOf(pinned) : FOLLOWS_DEFAULT_VALUE;
}

function laneChoiceOf(value: string): { followsDefault: boolean; accountId: string | null } {
  if (value === FOLLOWS_DEFAULT_VALUE) return { followsDefault: true, accountId: null };
  if (value === MACHINE_LOGIN_VALUE) return { followsDefault: false, accountId: null };
  return { followsDefault: false, accountId: value.slice('account:'.length) };
}

async function chooseLaneAccount(lane: LaneAccountLane, value: string, status: ActionStatus) {
  const reply = await requestWithStatus('agent-lane-account', { lane, ...laneChoiceOf(value) }, status, { busyText: `Saving the ${LANE_TITLES[lane]} account.` });
  if (reply?.type !== 'agent-accounts') return;
  applyAgentAccounts(reply.accounts);
  if (reply.error) status.show('error', reply.error);
}

function resolvedLaneAccountOf(lane: LaneAccountLane, accounts: readonly AgentAccountStatus[]): AgentAccountStatus | undefined {
  return accounts.find((account) => account.lanes.includes(lane)) ?? accounts.find((account) => account.isDefault);
}

function billsText(account: AgentAccountStatus | undefined): string {
  if (account === undefined) return 'Bills the default account';
  if (account.plan === null) return `Bills ${account.label}`;
  return `Bills ${account.plan}`;
}

function buildLaneAccountRow(lane: LaneAccountLane, accounts: readonly AgentAccountStatus[], status: ActionStatus) {
  const row = el('div', 'settings-background-job');
  const selectId = `settings-lane-account-${lane}`;
  const title = el('label', 'settings-background-job-title', LANE_TITLES[lane]);
  title.htmlFor = selectId;
  const body = el('div', 'settings-background-job-body');
  body.append(title, el('div', 'settings-background-job-text', LANE_DESCRIPTIONS[lane]));
  const defaultAccount = accounts.find((account) => account.isDefault);
  const laneSelect = select({
    id: selectId,
    options: [
      { value: FOLLOWS_DEFAULT_VALUE, label: defaultAccount ? `Follows default ${defaultAccount.label}` : 'Follows default' },
      ...accounts.map((account) => ({ value: optionValueOf(account), label: account.label })),
    ],
    value: chosenValueOf(lane, accounts),
    onChange: (value) => { void chooseLaneAccount(lane, value, status); },
  });
  const resolvedAccount = resolvedLaneAccountOf(lane, accounts);
  const swatch = el('span', 'settings-accounts-swatch');
  swatch.style.background = accountColourOf(resolvedAccount?.accountId ?? null);
  const bills = el('div', 'settings-background-job-bills');
  bills.append(swatch, billsText(resolvedAccount));
  const choice = el('div', 'settings-background-job-choice');
  choice.append(laneSelect.element, bills);
  row.append(body, choice);
  return row;
}

export function buildLaneAccountsBlock(): HTMLElement {
  const block = el('div', 'settings-background-jobs');
  const accounts = agentAccountsOf(LANE_ACCOUNT_AGENT_ID).filter((account) => !account.isPending);
  block.append(...LaneAccountLane.options.map((lane) => buildLaneAccountRow(lane, accounts, laneActionStatus)), laneActionStatus.element);
  return block;
}

let accountsBlockListeners = new AbortController();

export function buildAgentAccountsBlock(): HTMLElement {
  accountsBlockListeners.abort();
  accountsBlockListeners = new AbortController();
  const { signal } = accountsBlockListeners;
  const block = el('div', 'settings-accounts');
  const groups = el('div', 'settings-accounts-groups');
  groups.append(...ACCOUNT_AGENTS.map((agent) => buildAgentCard(agent, signal)));
  block.append(groups, accountActionStatus.element);
  return block;
}
