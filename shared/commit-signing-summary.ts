import type { CommitSigningStatus } from './contracts/commit-signing.ts';

type CommitSigningSituation = 'registered' | 'removed' | 'turns-on-with-github' | 'manual-only' | 'off' | 'unregistered';
type CommitSigningSummary = { situation: CommitSigningSituation; text: string };
type GithubState = NonNullable<CommitSigningStatus['githubState']>;

const UNVERIFIED_TEXT = 'Off, so commits show as Unverified on GitHub.';
const NEXT_GITHUB_STEP_BY_STATE: Partial<Record<GithubState, string>> = {
  disconnected: 'connect GitHub',
  'awaiting-code': 'approve the sign-in on GitHub',
  'needs-install': 'install the Glimmervoid App',
};

function registeredSummaryOf(status: CommitSigningStatus): CommitSigningSummary {
  const signedText = `Commits are signed and show as Verified on GitHub as ${status.login ?? 'you'}.`;
  if (status.githubState !== 'reconnect-needed') return { situation: 'registered', text: signedText };
  return { situation: 'registered', text: `${signedText} Reconnect GitHub before removing the key, or delete it on GitHub yourself.` };
}

function manualOnlySummaryOf(status: CommitSigningStatus): CommitSigningSummary {
  if (status.state === 'off') return { situation: 'manual-only', text: 'Off. This host cannot connect GitHub, so Set up makes a signing key here for you to add on GitHub yourself.' };
  return { situation: 'manual-only', text: `Key ${status.fingerprint ?? ''} is on this host. Add its public key on GitHub as a Signing Key.` };
}

function turnsOnSummaryOf(status: CommitSigningStatus, nextGithubStep: string): CommitSigningSummary {
  if (status.state === 'off') return { situation: 'turns-on-with-github', text: `Turns on by itself when you ${nextGithubStep}: a signing key is made here and registered on GitHub, so commits show as Verified.` };
  return { situation: 'turns-on-with-github', text: `Key ${status.fingerprint ?? ''} is on this host and registers on GitHub by itself when you ${nextGithubStep}.` };
}

function unregisteredSummaryOf(status: CommitSigningStatus): CommitSigningSummary {
  if (status.githubState === 'reconnect-needed') return { situation: 'unregistered', text: `Key ${status.fingerprint ?? ''} is on this host but not on GitHub. Reconnect GitHub, then register it.` };
  return { situation: 'unregistered', text: `Key ${status.fingerprint ?? ''} is on this host but not on GitHub yet.` };
}

function commitSigningSummaryOf(status: CommitSigningStatus): CommitSigningSummary {
  if (status.state === 'registered') return registeredSummaryOf(status);
  if (status.state === 'off' && status.isSwitchedOff) return { situation: 'removed', text: 'Off: you removed the signing key, so commits show as Unverified on GitHub.' };
  if (status.githubState === 'unavailable') return manualOnlySummaryOf(status);
  const nextGithubStep = status.githubState === null ? undefined : NEXT_GITHUB_STEP_BY_STATE[status.githubState];
  if (nextGithubStep !== undefined) return turnsOnSummaryOf(status, nextGithubStep);
  if (status.state === 'off' && status.githubState === 'reconnect-needed') return { situation: 'off', text: `${UNVERIFIED_TEXT} Reconnect GitHub, then set it up.` };
  if (status.state === 'off') return { situation: 'off', text: UNVERIFIED_TEXT };
  return unregisteredSummaryOf(status);
}

export { commitSigningSummaryOf };
export type { CommitSigningSituation, CommitSigningSummary };
