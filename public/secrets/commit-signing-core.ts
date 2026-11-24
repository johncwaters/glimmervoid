import type { CommitSigningStatus } from '#shared/contracts/commit-signing.ts';
import { commitSigningSummaryOf } from '#shared/commit-signing-summary.ts';

const COMMIT_SIGNING_CONTROLS = ['setup', 'register', 'open-github', 'copy', 'remove'] as const;
type CommitSigningControl = typeof COMMIT_SIGNING_CONTROLS[number];
const KEY_WITHOUT_GITHUB_CONTROLS = ['setup', 'open-github', 'copy'] as const satisfies readonly CommitSigningControl[];
type KeyWithoutGithubControl = typeof KEY_WITHOUT_GITHUB_CONTROLS[number];

type CommitSigningView = {
  text: string;
  controls: readonly CommitSigningControl[];
  keyWithoutGithubControls: readonly KeyWithoutGithubControl[];
  publicKey: string | null;
  isPublicKeyWithoutGithub: boolean;
  problem: string | null;
  identityText: string | null;
};

const GITHUB_SIGNING_KEY_PAGE = 'https://github.com/settings/ssh/new';
const BY_HAND_CONTROLS = ['open-github', 'copy', 'remove'] as const satisfies readonly CommitSigningControl[];

function signingViewOf(status: CommitSigningStatus): Omit<CommitSigningView, 'text' | 'problem' | 'identityText'> {
  const view = { controls: [], keyWithoutGithubControls: [], publicKey: null, isPublicKeyWithoutGithub: false };
  const { situation } = commitSigningSummaryOf(status);
  if (situation === 'registered') return { ...view, controls: ['remove'] };
  if (status.state === 'off' && situation === 'turns-on-with-github') return { ...view, keyWithoutGithubControls: ['setup'] };
  if (status.state === 'off') return { ...view, controls: ['setup'] };
  if (situation === 'turns-on-with-github') return { controls: ['remove'], keyWithoutGithubControls: ['open-github', 'copy'], publicKey: status.publicKey, isPublicKeyWithoutGithub: true };
  if (status.canRegister) return { ...view, controls: ['register', 'remove'] };
  return { ...view, controls: BY_HAND_CONTROLS, publicKey: status.publicKey };
}

function commitSigningViewOf(status: CommitSigningStatus | null | 'reading'): CommitSigningView {
  const view = { controls: [], keyWithoutGithubControls: [], publicKey: null, isPublicKeyWithoutGithub: false, problem: null, identityText: null };
  if (status === 'reading') return { ...view, text: 'Reading commit signing.' };
  if (status === null) return { ...view, text: 'This host did not answer about commit signing.' };
  const identityText = status.identity ? `Sessions with no git identity of their own commit as ${status.identity.name} <${status.identity.email}>.` : null;
  return { ...signingViewOf(status), text: commitSigningSummaryOf(status).text, problem: status.problem, identityText };
}

export { COMMIT_SIGNING_CONTROLS, commitSigningViewOf, GITHUB_SIGNING_KEY_PAGE, KEY_WITHOUT_GITHUB_CONTROLS };
export type { CommitSigningControl, KeyWithoutGithubControl };
