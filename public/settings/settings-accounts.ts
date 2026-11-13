import { LANE_ACCOUNT_AGENT_ID, LaneAccountLane } from '#shared/contracts/agent-accounts.ts';
import type { AgentAccountStatus } from '#shared/contracts/agent-accounts.ts';
import type { ActionStatus } from '../action-status.ts';
import { requestWithStatus } from '../action-status.ts';
import { agentAccountsOf, applyAgentAccounts } from '../agent-logins.ts';
import { el } from '../dom-helpers.ts';

const LANE_TITLES: Readonly<Record<LaneAccountLane, string>> = Object.freeze({
  'team-review': 'Team review',
  radar: 'Radar',
  community: 'Community',
  'task-title': 'Task titles',
  'question-manager': 'Question manager',
});

const FOLLOWS_DEFAULT_VALUE = 'default';
const MACHINE_LOGIN_VALUE = 'machine';

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
  const row = el('div', 'settings-telegram-test');
  const selectId = `settings-lane-account-${lane}`;
  const label = el('label', 'settings-readonly', LANE_TITLES[lane]);
  label.htmlFor = selectId;
  const select = el('select', 'settings-view-input');
  select.id = selectId;
  const defaultAccount = accounts.find((account) => account.isDefault);
  const followsDefault = el('option', null, `Default account${defaultAccount ? ` (${defaultAccount.label})` : ''}`);
  followsDefault.value = FOLLOWS_DEFAULT_VALUE;
  select.appendChild(followsDefault);
  for (const account of accounts) {
    const option = el('option', null, account.label);
    option.value = optionValueOf(account);
    select.appendChild(option);
  }
  select.value = chosenValueOf(lane, accounts);
  select.addEventListener('change', () => { void chooseLaneAccount(lane, select.value, status); });
  row.append(label, select);
  return row;
}

export function buildLaneAccountsBlock(status: ActionStatus): HTMLElement {
  const block = el('div');
  block.appendChild(el('div', 'settings-section-title', 'Lanes'));
  block.appendChild(el('div', 'settings-readonly', 'The Claude Code account each lane runs under. Lanes running another agent use this machine\'s login.'));
  const accounts = agentAccountsOf(LANE_ACCOUNT_AGENT_ID).filter((account) => !account.isPending);
  for (const lane of LaneAccountLane.options) block.appendChild(buildLaneAccountRow(lane, accounts, status));
  return block;
}
