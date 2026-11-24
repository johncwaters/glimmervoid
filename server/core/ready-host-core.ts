import type { CommitSigningStatus, GitIdentity } from '../../shared/contracts/commit-signing.ts';
import type { HostReady, HostReadyRow } from '../../shared/contracts/host-ready.ts';
import type { GithubConnection } from '../../shared/contracts/watcher-link.ts';
import { commitSigningSummaryOf } from '../../shared/commit-signing-summary.ts';
import type { CommitSigningSituation } from '../../shared/commit-signing-summary.ts';

type GhState = 'missing' | 'signed-in' | 'wrapped' | 'signed-out';

interface HostReadyFacts {
  connectedLogin: string | null;
  githubState: GithubConnection['state'] | null;
  signing: CommitSigningStatus | null;
  ownIdentity: GitIdentity | null;
  gh: GhState;
}

const SET_ONCE_CONNECTED_TEXT = 'Set once GitHub is connected.';
const SET_ONCE_RECONNECTED_TEXT = 'Set once GitHub is reconnected.';

function setLaterTextOf(githubState: HostReadyFacts['githubState'], textWithoutGithub: string): string {
  if (githubState === 'unavailable') return textWithoutGithub;
  if (githubState === 'reconnect-needed') return SET_ONCE_RECONNECTED_TEXT;
  return SET_ONCE_CONNECTED_TEXT;
}

function githubRow({ connectedLogin, githubState }: HostReadyFacts): HostReadyRow {
  if (connectedLogin !== null) return { id: 'github', state: 'ready', text: `Connected as ${connectedLogin}.`, fix: null };
  if (githubState === 'unavailable') return { id: 'github', state: 'unavailable', text: 'GitHub connect is not set up on this host.', fix: null };
  if (githubState === 'reconnect-needed') return { id: 'github', state: 'needs-action', text: 'GitHub access ended. Reconnect so agents can push, open pull requests and sign commits as you.', fix: 'connect-github' };
  return { id: 'github', state: 'needs-action', text: 'Not connected. Connecting lets agents push, open pull requests and sign commits as you.', fix: 'connect-github' };
}

function identityRow({ connectedLogin, githubState, signing, ownIdentity }: HostReadyFacts): HostReadyRow {
  if (ownIdentity) return { id: 'git-identity', state: 'ready', text: `Sessions commit as ${ownIdentity.name} <${ownIdentity.email}>, from your git config.`, fix: null };
  const githubIdentity = signing?.identity ?? null;
  if (githubIdentity) return { id: 'git-identity', state: 'ready', text: `Sessions commit as ${githubIdentity.name} <${githubIdentity.email}>, from your GitHub account.`, fix: null };
  if (connectedLogin !== null) return { id: 'git-identity', state: 'needs-action', text: 'No git identity yet, so a session cannot commit. Glimmervoid reads it from GitHub shortly after connecting; you can also set user.name and user.email in git.', fix: null };
  return { id: 'git-identity', state: 'needs-action', text: `No git identity on this host, so a session cannot commit. ${setLaterTextOf(githubState, 'Set user.name and user.email in git.')}`, fix: null };
}

function ghRow({ connectedLogin, githubState, gh }: HostReadyFacts): HostReadyRow {
  if (gh === 'missing') return { id: 'gh', state: 'unavailable', text: 'gh is not installed on this host, so agents cannot use it.', fix: null };
  if (gh === 'signed-in') return { id: 'gh', state: 'ready', text: 'gh is signed in on this host.', fix: null };
  if (gh === 'wrapped') return { id: 'gh', state: 'ready', text: `gh runs in sessions as ${connectedLogin ?? 'your GitHub account'}.`, fix: null };
  if (connectedLogin !== null) return { id: 'gh', state: 'needs-action', text: 'gh is not signed in on this host. Run gh auth login in a terminal here.', fix: null };
  return { id: 'gh', state: 'needs-action', text: `gh is not signed in. ${setLaterTextOf(githubState, 'Run gh auth login in a terminal here.')}`, fix: null };
}

function withProblem(text: string, problem: string | null): string {
  return problem === null ? text : `${text} ${problem}`;
}

const SIGNING_FIX_BY_SITUATION: Readonly<Record<CommitSigningSituation, HostReadyRow['fix']>> = Object.freeze({
  registered: null,
  removed: 'set-up-signing',
  'turns-on-with-github': null,
  'manual-only': null,
  off: 'set-up-signing',
  unregistered: 'register-signing',
});

function signingFixOf(signing: CommitSigningStatus, situation: CommitSigningSituation): HostReadyRow['fix'] {
  if (situation === 'manual-only' && signing.state === 'off') return 'set-up-signing';
  if (situation === 'unregistered' && !signing.canRegister) return null;
  return SIGNING_FIX_BY_SITUATION[situation];
}

function signingRow({ signing }: HostReadyFacts): HostReadyRow {
  if (signing === null) return { id: 'commit-signing', state: 'unavailable', text: 'Commit signing is not available on this host.', fix: null };
  const { situation, text } = commitSigningSummaryOf(signing);
  return { id: 'commit-signing', state: situation === 'registered' ? 'ready' : 'needs-action', text: withProblem(text, signing.problem), fix: signingFixOf(signing, situation) };
}

function hostReadyOf(facts: HostReadyFacts): HostReady {
  return { rows: [githubRow(facts), identityRow(facts), ghRow(facts), signingRow(facts)] };
}

export { hostReadyOf };
export type { GhState };
