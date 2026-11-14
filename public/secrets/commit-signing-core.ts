import type { CommitSigningStatus } from '#shared/contracts/commit-signing.ts';

const COMMIT_SIGNING_CONTROLS = ['setup', 'register', 'open-github', 'copy', 'remove'] as const;
type CommitSigningControl = typeof COMMIT_SIGNING_CONTROLS[number];

type CommitSigningView = {
  text: string;
  controls: readonly CommitSigningControl[];
  publicKey: string | null;
  problem: string | null;
  identityText: string | null;
};

const GITHUB_SIGNING_KEY_PAGE = 'https://github.com/settings/ssh/new';
const OFF_TEXT_WHEN_SETUP_REGISTERS = 'Off. Set up makes a signing key on this host and registers it on GitHub, so agents\' commits show as Verified.';
const OFF_TEXT_WHEN_SETUP_ONLY_MAKES_THE_KEY = 'Off. GitHub is not connected on this host, so Set up only makes a signing key here; you then add it on GitHub by hand, or connect GitHub and register it.';

function commitSigningViewOf(status: CommitSigningStatus | null | 'reading'): CommitSigningView {
  const view = { controls: [], publicKey: null, problem: null, identityText: null };
  if (status === 'reading') return { ...view, text: 'Reading commit signing.' };
  if (status === null) return { ...view, text: 'This host did not answer about commit signing.' };
  const problem = status.problem;
  const identityText = status.identity ? `Sessions with no git identity of their own commit as ${status.identity.name} <${status.identity.email}>.` : null;
  if (status.state === 'off') return { ...view, problem, identityText, text: status.canRegister ? OFF_TEXT_WHEN_SETUP_REGISTERS : OFF_TEXT_WHEN_SETUP_ONLY_MAKES_THE_KEY, controls: ['setup'] };
  if (status.state === 'registered') return { ...view, problem, identityText, text: `Signing as ${status.login ?? 'your GitHub account'} with ${status.fingerprint}. Sessions started from now on sign their commits.`, controls: ['remove'] };
  if (status.canRegister) return { ...view, problem, identityText, text: `Key ${status.fingerprint} is on this host but not on GitHub yet.`, controls: ['register', 'remove'] };
  return {
    problem,
    identityText,
    text: `Key ${status.fingerprint} is on this host. Add this public key on GitHub as a Signing Key, or connect GitHub to register it.`,
    controls: ['open-github', 'copy', 'remove'],
    publicKey: status.publicKey,
  };
}

export { COMMIT_SIGNING_CONTROLS, commitSigningViewOf, GITHUB_SIGNING_KEY_PAGE };
export type { CommitSigningControl };
