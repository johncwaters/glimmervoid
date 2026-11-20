import '../host-ready/host-ready.css';
import './settings-accounts.css';

import { LANE_ACCOUNT_AGENT_ID, LaneAccountLane } from '#shared/contracts/agent-accounts.ts';
import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import type { ActionStatus } from '../action-status.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import { agentAccountsOf, applyAgentAccounts, CONNECTABLE_AGENT_NAMES } from '../agent-logins.ts';
import { openAgentAccountDialog } from '../dialogs.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { button } from '../ui/button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { select } from '../ui/select.ts';
import { tag } from '../ui/tag.ts';

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

const LOGIN_STATE_TEXT: Readonly<Record<LoginState, string>> = Object.freeze({
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  connecting: 'Signing in',
  failed: 'Sign-in failed',
  unchecked: 'Sign-in not checked',
});

const LOGIN_STATE_ICON: Readonly<Record<LoginState, StatusIcon>> = Object.freeze({
  'signed-in': 'complete',
  'signed-out': 'needs-input',
  connecting: 'starting',
  failed: 'failed',
  unchecked: 'not-started',
});

const FOLLOWS_DEFAULT_VALUE = 'default';
const MACHINE_LOGIN_VALUE = 'machine';

const accountActionStatus = createActionStatus('settings-agent-accounts-status');

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

function accountDetailText(account: AgentAccountStatus) {
  const isSignedIn = account.login.state === 'signed-in';
  return [isSignedIn ? null : LOGIN_STATE_TEXT[account.login.state], account.detail]
    .filter((part) => part !== null && part !== '')
    .join(', ');
}

function buildAccountControls(agent: AccountAgent, account: AgentAccountStatus) {
  const controls = el('div', 'host-ready-controls');
  if (account.isDefault) controls.append(tag({ text: 'Default', tone: 'neutral' }));
  if (!account.isDefault && !account.isPending) {
    controls.append(button({ variant: 'secondary', size: 'small', label: 'Make default', action: 'make-default-agent-account', onClick: () => { void makeAgentAccountDefault(agent, account); } }));
  }
  const accountId = account.accountId;
  if (accountId === null) return controls;
  if (account.login.state !== 'signed-in' && !account.isPending) {
    controls.append(button({ variant: 'secondary', size: 'small', label: 'Sign in', action: 'sign-in-agent-account', onClick: () => openAgentAccountDialog(agent, accountId) }));
  }
  controls.append(button({ variant: 'danger', size: 'small', label: 'Remove', action: 'remove-agent-account', onClick: () => confirmAccountRemoval(agent, account) }));
  return controls;
}

function buildAccountRow(agent: AccountAgent, account: AgentAccountStatus) {
  const row = el('div', 'host-ready-row settings-accounts-row');
  const isSignedIn = account.login.state === 'signed-in';
  row.dataset.hostReadyState = isSignedIn ? 'ready' : 'needs-action';
  const mark = el('span', 'host-ready-mark');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', LOGIN_STATE_TEXT[account.login.state]);
  paintStatusIcon(mark, LOGIN_STATE_ICON[account.login.state]);
  const name = el('span', 'host-ready-name settings-accounts-name');
  name.append(mark, account.label);
  const body = el('div', 'host-ready-body');
  body.append(name, el('p', 'host-ready-text', accountDetailText(account)));
  row.append(body, buildAccountControls(agent, account));
  return row;
}

function buildAgentGroup(agent: AccountAgent) {
  const group = el('section', 'settings-accounts-group');
  const head = el('div', 'settings-accounts-group-head');
  const agentMark = el('span', 'agent-mark');
  agentMark.setAttribute('aria-hidden', 'true');
  paintAgentMark(agentMark, agent, CONNECTABLE_AGENT_NAMES[agent]);
  const title = el('h3', 'settings-accounts-group-title');
  title.append(agentMark, CONNECTABLE_AGENT_NAMES[agent]);
  head.append(title, button({ variant: 'secondary', size: 'small', label: 'Add account', action: 'add-agent-account', onClick: () => openAgentAccountDialog(agent) }));
  const rows = el('div', 'host-ready-rows');
  rows.append(...agentAccountsOf(agent).map((account) => buildAccountRow(agent, account)));
  group.append(head, rows);
  return group;
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

function buildLaneAccountRow(lane: LaneAccountLane, accounts: readonly AgentAccountStatus[], status: ActionStatus) {
  const row = el('div', 'settings-accounts-lane');
  const selectId = `settings-lane-account-${lane}`;
  const label = el('label', 'settings-accounts-lane-name', LANE_TITLES[lane]);
  label.htmlFor = selectId;
  const laneSelect = select({
    id: selectId,
    options: [
      { value: FOLLOWS_DEFAULT_VALUE, label: 'Default account' },
      ...accounts.map((account) => ({ value: optionValueOf(account), label: account.label })),
    ],
    value: chosenValueOf(lane, accounts),
    onChange: (value) => { void chooseLaneAccount(lane, value, status); },
  });
  row.append(label, laneSelect.element);
  return row;
}

function buildLaneAccountsBlock(status: ActionStatus): HTMLElement {
  const block = el('section', 'settings-accounts-lanes');
  block.append(
    sectionHeading({ title: 'Lanes', level: 3 }).element,
    el('p', 'settings-accounts-lanes-text', 'The Claude Code account each lane runs under. Lanes running another agent use this machine\'s login.'),
  );
  const accounts = agentAccountsOf(LANE_ACCOUNT_AGENT_ID).filter((account) => !account.isPending);
  const rows = el('div', 'settings-accounts-lane-rows');
  rows.append(...LaneAccountLane.options.map((lane) => buildLaneAccountRow(lane, accounts, status)));
  block.append(rows);
  return block;
}

export function buildAgentAccountsBlock(): HTMLElement {
  const block = el('div', 'settings-accounts');
  const groups = el('div', 'settings-accounts-groups');
  groups.append(...ACCOUNT_AGENTS.map(buildAgentGroup));
  block.append(groups, buildLaneAccountsBlock(accountActionStatus), accountActionStatus.element);
  return block;
}
