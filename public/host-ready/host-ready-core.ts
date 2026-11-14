import type { HostReady, HostReadyFix, HostReadyRow, HostReadyRowId, HostReadyState } from '#shared/contracts/host-ready.ts';
import type { StatusIcon } from '#shared/state-icons.ts';

const FIX_LABELS: Readonly<Record<HostReadyFix, string>> = Object.freeze({
  'connect-github': 'Connect GitHub',
  'set-up-signing': 'Set up',
  'register-signing': 'Register on GitHub',
});

const ROW_TITLES: Readonly<Record<HostReadyRowId, string>> = Object.freeze({
  github: 'GitHub',
  'git-identity': 'Git identity',
  gh: 'gh',
  'commit-signing': 'Commit signing',
});

const STATE_ICONS_BY_STATE: Readonly<Record<HostReadyState, StatusIcon>> = Object.freeze({
  ready: 'complete',
  'needs-action': 'needs-input',
  unavailable: 'not-started',
});

const STATE_WORDS: Readonly<Record<HostReadyState, string>> = Object.freeze({
  ready: 'Ready',
  'needs-action': 'Needs action',
  unavailable: 'Not available',
});

const HOST_READY_FIXES = ['connect-github', 'set-up-signing', 'register-signing'] as const satisfies readonly HostReadyFix[];

type HostReadyRowView = {
  id: HostReadyRowId;
  state: HostReadyState;
  title: string;
  stateIcon: StatusIcon;
  stateWord: string;
  text: string;
  fix: HostReadyFix | null;
};

function rowViewOf(row: HostReadyRow): HostReadyRowView {
  return { id: row.id, state: row.state, title: ROW_TITLES[row.id], stateIcon: STATE_ICONS_BY_STATE[row.state], stateWord: STATE_WORDS[row.state], text: row.text, fix: row.fix };
}

function hostReadyRowViewsOf(hostReady: HostReady | null): readonly HostReadyRowView[] {
  return (hostReady?.rows ?? []).map(rowViewOf);
}

export { FIX_LABELS, HOST_READY_FIXES, hostReadyRowViewsOf };
export type { HostReadyRowView };
