import type { AgentAccountStatus, LaneAccountLane } from '#shared/contracts/agent-accounts.ts';
import { NO_VALUE, planWindowOf, planWindowTone } from '../usage/usage-store-core.ts';
import type { PlanLimits, PlanLimitsVendor } from '../usage/usage-store-core.ts';
import type { MeterTone } from '../ui/meter-core.ts';

export type AccountAgent = 'claude-code' | 'codex';
type LoginState = AgentAccountStatus['login']['state'];

export const ACCOUNT_AGENTS: readonly AccountAgent[] = ['claude-code', 'codex'];

export const LANE_TITLES: Readonly<Record<LaneAccountLane, string>> = Object.freeze({
  'team-review': 'Team review',
  radar: 'Radar',
  community: 'Community',
  'task-title': 'Task titles',
  'question-manager': 'Question manager',
});

export const LANE_DESCRIPTIONS: Readonly<Record<LaneAccountLane, string>> = Object.freeze({
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

export const PLAN_VENDOR_BY_AGENT: Readonly<Record<AccountAgent, PlanLimitsVendor>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'codex',
});

const PLAN_WINDOW_LABELS: Readonly<Record<'fiveHour' | 'sevenDay', string>> = Object.freeze({
  fiveHour: '5h',
  sevenDay: '7d',
});

const FOLLOWS_DEFAULT_VALUE = 'default';
const MACHINE_LOGIN_VALUE = 'machine';

interface PlanMeterDisplay {
  key: 'fiveHour' | 'sevenDay';
  label: string;
  value: number;
  tone: MeterTone;
  ariaLabel: string;
  percentText: string;
}

interface AccountRowDisplay {
  account: AgentAccountStatus;
  isSignedIn: boolean;
  hasDefaultChoice: boolean;
  radioName: string;
  radioValue: string;
  radioAccessibleName: string;
  isRadioDisabled: boolean;
  swatchColor: string;
  subText: string;
  planMeters: PlanMeterDisplay[] | null;
  showSignInButton: boolean;
  menuAccountId: string | null;
}

interface AgentAccountCardDisplay {
  agent: AccountAgent;
  agentLabel: string;
  rows: AccountRowDisplay[];
}

interface LaneAccountRowDisplay {
  lane: LaneAccountLane;
  selectId: string;
  title: string;
  description: string;
  options: { value: string; label: string }[];
  chosenValue: string;
  swatchColor: string;
  billsText: string;
}

type RenameDialogState =
  | { isOpen: false }
  | {
    isOpen: true;
    accountId: string;
    currentLabel: string;
    isSubmitting: boolean;
    errorText: string;
  };

export const CLOSED_RENAME_DIALOG: RenameDialogState = Object.freeze({ isOpen: false });

export function openRenameDialogState(accountId: string, currentLabel: string): RenameDialogState {
  return {
    isOpen: true,
    accountId,
    currentLabel,
    isSubmitting: false,
    errorText: '',
  };
}

export function beginRenameSubmit(state: RenameDialogState): RenameDialogState {
  if (!state.isOpen) return state;
  return { ...state, isSubmitting: true };
}

export function failRenameSubmit(state: RenameDialogState, errorText: string): RenameDialogState {
  if (!state.isOpen) return state;
  return { ...state, isSubmitting: false, errorText };
}

function clampPct(pct: unknown): number {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function meterToneForPlanWindow(tone: string): MeterTone {
  if (tone === 'crit' || tone === 'fail') return 'failed';
  if (tone === 'warn') return 'waiting';
  return 'accent';
}

export function accountSubText(account: AgentAccountStatus): string {
  if (account.login.state !== 'signed-in') return LOGIN_STATE_TEXT[account.login.state];
  return [account.plan, account.detail].filter((part) => part !== null && part !== '').join(' \u00b7 ');
}

function buildPlanMeterDisplay(planLimits: PlanLimits, key: 'fiveHour' | 'sevenDay', accountLabel: string): PlanMeterDisplay {
  const usedPct = planWindowOf(planLimits, key)?.pct ?? null;
  const label = PLAN_WINDOW_LABELS[key];
  return {
    key,
    label,
    value: clampPct(usedPct ?? 0) / 100,
    tone: meterToneForPlanWindow(planWindowTone(usedPct)),
    ariaLabel: `${accountLabel} ${label} plan limit used`,
    percentText: usedPct === null ? NO_VALUE : `${Math.round(usedPct)}%`,
  };
}

function planMetersDisplayOf(planLimits: PlanLimits | null, accountLabel: string): PlanMeterDisplay[] | null {
  if (planLimits === null) return null;
  return [
    buildPlanMeterDisplay(planLimits, 'fiveHour', accountLabel),
    buildPlanMeterDisplay(planLimits, 'sevenDay', accountLabel),
  ];
}

export function agentAccountCardsOf(
  accountsByAgent: Readonly<Record<AccountAgent, readonly AgentAccountStatus[]>>,
  agentNames: Readonly<Record<AccountAgent, string>>,
  planLimitsLookup: (vendor: PlanLimitsVendor, accountId: string | null) => PlanLimits | null,
  colourOf: (accountId: string | null) => string,
): AgentAccountCardDisplay[] {
  return ACCOUNT_AGENTS.map((agent) => {
    const accounts = accountsByAgent[agent];
    const hasDefaultChoice = accounts.filter((account) => !account.isPending).length > 1;
    const vendor = PLAN_VENDOR_BY_AGENT[agent];
    return {
      agent,
      agentLabel: agentNames[agent],
      rows: accounts.map((account) => {
        const isSignedIn = account.login.state === 'signed-in';
        const accountId = account.accountId;
        return {
          account,
          isSignedIn,
          hasDefaultChoice,
          radioName: `settings-default-account-${agent}`,
          radioValue: accountId ?? MACHINE_LOGIN_VALUE,
          radioAccessibleName: `Make ${account.label} the default`,
          isRadioDisabled: account.isPending,
          swatchColor: colourOf(accountId),
          subText: accountSubText(account),
          planMeters: isSignedIn ? planMetersDisplayOf(planLimitsLookup(vendor, accountId), account.label) : null,
          showSignInButton: !isSignedIn && !account.isPending && accountId !== null,
          menuAccountId: accountId === null || account.isPending ? null : accountId,
        };
      }),
    };
  });
}

export function confirmAccountRemovalCopy(
  agentName: string,
  account: AgentAccountStatus,
): { title: string; message: string } {
  const message = account.usedBy.length > 0
    ? `${account.label} is in use by ${account.usedBy.join(', ')}. Switch those sessions to another account or close them first.`
    : `Glimmervoid forgets ${account.label}. An account added here is also signed out and its folder deleted. Your settings, skills, plugins and conversations stay with ${agentName} on this machine.`;
  return {
    title: `Remove ${account.label}?`,
    message,
  };
}

function optionValueOf(account: AgentAccountStatus): string {
  return account.accountId === null ? MACHINE_LOGIN_VALUE : `account:${account.accountId}`;
}

function chosenValueOf(lane: LaneAccountLane, accounts: readonly AgentAccountStatus[]): string {
  const pinned = accounts.find((account) => account.lanes.includes(lane));
  return pinned ? optionValueOf(pinned) : FOLLOWS_DEFAULT_VALUE;
}

export function laneChoiceOf(value: string): { followsDefault: boolean; accountId: string | null } {
  if (value === FOLLOWS_DEFAULT_VALUE) return { followsDefault: true, accountId: null };
  if (value === MACHINE_LOGIN_VALUE) return { followsDefault: false, accountId: null };
  return { followsDefault: false, accountId: value.slice('account:'.length) };
}

function resolvedLaneAccountOf(
  lane: LaneAccountLane,
  accounts: readonly AgentAccountStatus[],
): AgentAccountStatus | undefined {
  return accounts.find((account) => account.lanes.includes(lane)) ?? accounts.find((account) => account.isDefault);
}

function billsTextOf(account: AgentAccountStatus | undefined): string {
  if (account === undefined) return 'Bills the default account';
  if (account.plan === null) return `Bills ${account.label}`;
  return `Bills ${account.plan}`;
}

export function laneAccountRowsOf(
  lanes: readonly LaneAccountLane[],
  accounts: readonly AgentAccountStatus[],
  colourOf: (accountId: string | null) => string,
): LaneAccountRowDisplay[] {
  const readyAccounts = accounts.filter((account) => !account.isPending);
  const defaultAccount = readyAccounts.find((account) => account.isDefault);
  const defaultOptionLabel = defaultAccount ? `Follows default ${defaultAccount.label}` : 'Follows default';
  const baseOptions = [
    { value: FOLLOWS_DEFAULT_VALUE, label: defaultOptionLabel },
    ...readyAccounts.map((account) => ({ value: optionValueOf(account), label: account.label })),
  ];
  return lanes.map((lane) => {
    const resolvedAccount = resolvedLaneAccountOf(lane, readyAccounts);
    return {
      lane,
      selectId: `settings-lane-account-${lane}`,
      title: LANE_TITLES[lane],
      description: LANE_DESCRIPTIONS[lane],
      options: baseOptions,
      chosenValue: chosenValueOf(lane, readyAccounts),
      swatchColor: colourOf(resolvedAccount?.accountId ?? null),
      billsText: billsTextOf(resolvedAccount),
    };
  });
}
