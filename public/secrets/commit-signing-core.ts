import type { CommitSigningStatus } from '#shared/contracts/commit-signing.ts';

const COMMIT_SIGNING_CONTROLS = ['setup', 'register', 'open-github', 'copy', 'remove'] as const;
type CommitSigningControl = typeof COMMIT_SIGNING_CONTROLS[number];

type CommitSigningView = {
  text: string;
  controls: readonly CommitSigningControl[];
  publicKey: string | null;
  problem: string | null;
};

const GITHUB_SIGNING_KEY_PAGE = 'https://github.com/settings/ssh/new';

function commitSigningViewOf(status: CommitSigningStatus | null | 'reading'): CommitSigningView {
  const view = { controls: [], publicKey: null, problem: null };
  if (status === 'reading') return { ...view, text: 'Reading commit signing.' };
  if (status === null) return { ...view, text: 'This host did not answer about commit signing.' };
  const problem = status.problem;
  if (status.state === 'off') return { ...view, problem, text: 'Off. Set up makes a signing key on this host, so agents\' commits show as Verified on GitHub.', controls: ['setup'] };
  if (status.state === 'registered') return { ...view, problem, text: `Signing as ${status.login ?? 'your GitHub account'} with ${status.fingerprint}. Sessions started from now on sign their commits.`, controls: ['remove'] };
  if (status.canRegister) return { ...view, problem, text: `Key ${status.fingerprint} is on this host but not on GitHub yet.`, controls: ['register', 'remove'] };
  return {
    problem,
    text: `Key ${status.fingerprint} is on this host. Add this public key on GitHub as a Signing Key, or connect GitHub to register it.`,
    controls: ['open-github', 'copy', 'remove'],
    publicKey: status.publicKey,
  };
}

export { COMMIT_SIGNING_CONTROLS, commitSigningViewOf, GITHUB_SIGNING_KEY_PAGE };
export type { CommitSigningControl };
