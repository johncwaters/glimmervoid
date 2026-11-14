import type { CommitSigningStatus, GitIdentity } from '../../shared/contracts/commit-signing.ts';
import type { HostReady, HostReadyRow } from '../../shared/contracts/host-ready.ts';

type GhState = 'missing' | 'signed-in' | 'wrapped' | 'signed-out';

interface HostReadyFacts {
  connectedLogin: string | null;
  signing: CommitSigningStatus | null;
  ownIdentity: GitIdentity | null;
  gh: GhState;
}

const SET_ONCE_CONNECTED_TEXT = 'Set once GitHub is connected.';

function githubRow({ connectedLogin }: HostReadyFacts): HostReadyRow {
  if (connectedLogin !== null) return { id: 'github', state: 'ready', text: `Connected as ${connectedLogin}.`, fix: null };
  return { id: 'github', state: 'needs-action', text: 'Not connected. Connecting lets agents push, open pull requests and sign commits as you.', fix: 'connect-github' };
}

function identityRow({ connectedLogin, signing, ownIdentity }: HostReadyFacts): HostReadyRow {
  if (ownIdentity) return { id: 'git-identity', state: 'ready', text: `Sessions commit as ${ownIdentity.name} <${ownIdentity.email}>, from your git config.`, fix: null };
  const githubIdentity = signing?.identity ?? null;
  if (githubIdentity) return { id: 'git-identity', state: 'ready', text: `Sessions commit as ${githubIdentity.name} <${githubIdentity.email}>, from your GitHub account.`, fix: null };
  if (connectedLogin !== null) return { id: 'git-identity', state: 'needs-action', text: 'No git identity yet, so a session cannot commit. Glimmervoid reads it from GitHub shortly after connecting; you can also set user.name and user.email in git.', fix: null };
  return { id: 'git-identity', state: 'needs-action', text: `No git identity on this host, so a session cannot commit. ${SET_ONCE_CONNECTED_TEXT}`, fix: null };
}

function ghRow({ connectedLogin, gh }: HostReadyFacts): HostReadyRow {
  if (gh === 'missing') return { id: 'gh', state: 'unavailable', text: 'gh is not installed on this host, so agents cannot use it.', fix: null };
  if (gh === 'signed-in') return { id: 'gh', state: 'ready', text: 'gh is signed in on this host.', fix: null };
  if (gh === 'wrapped') return { id: 'gh', state: 'ready', text: `gh runs in sessions as ${connectedLogin ?? 'your GitHub account'}.`, fix: null };
  if (connectedLogin !== null) return { id: 'gh', state: 'needs-action', text: 'gh is not signed in on this host. Run gh auth login in a terminal here.', fix: null };
  return { id: 'gh', state: 'needs-action', text: `gh is not signed in. ${SET_ONCE_CONNECTED_TEXT}`, fix: null };
}

function withProblem(text: string, problem: string | null): string {
  return problem === null ? text : `${text} ${problem}`;
}

function signingRow({ connectedLogin, signing }: HostReadyFacts): HostReadyRow {
  if (signing === null) return { id: 'commit-signing', state: 'unavailable', text: 'Commit signing is not available on this host.', fix: null };
  if (signing.state === 'registered') return { id: 'commit-signing', state: 'ready', text: withProblem(`Commits are signed and show as Verified on GitHub as ${signing.login ?? 'you'}.`, signing.problem), fix: null };
  if (signing.state === 'off' && connectedLogin === null) return { id: 'commit-signing', state: 'needs-action', text: withProblem(`Off, so commits show as Unverified on GitHub. ${SET_ONCE_CONNECTED_TEXT}`, signing.problem), fix: null };
  if (signing.state === 'off') return { id: 'commit-signing', state: 'needs-action', text: withProblem('Off, so commits show as Unverified on GitHub.', signing.problem), fix: 'set-up-signing' };
  if (signing.canRegister) return { id: 'commit-signing', state: 'needs-action', text: withProblem('The signing key is on this host but not on GitHub yet.', signing.problem), fix: 'register-signing' };
  return { id: 'commit-signing', state: 'needs-action', text: withProblem(`The signing key is on this host but not on GitHub. ${SET_ONCE_CONNECTED_TEXT}`, signing.problem), fix: null };
}

function hostReadyOf(facts: HostReadyFacts): HostReady {
  return { rows: [githubRow(facts), identityRow(facts), ghRow(facts), signingRow(facts)] };
}

export { hostReadyOf };
export type { GhState };
