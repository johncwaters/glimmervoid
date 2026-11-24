import type { GithubConnection } from '#shared/contracts/watcher-link.ts';

const GITHUB_CONNECT_CONTROLS = ['connect', 'install', 'add-accounts', 'disconnect'] as const;
type GithubConnectControl = typeof GITHUB_CONNECT_CONTROLS[number];

type GithubDeviceCode = { userCode: string; verificationUri: string };

type GithubConnectView = {
  text: string;
  deviceCode: GithubDeviceCode | null;
  controls: readonly GithubConnectControl[];
  isConnectWaiting: boolean;
  recheckAfterMs: number | null;
};

const UNANSWERED_RECHECK_MS = 5_000;
const AWAITING_CODE_RECHECK_MS = 5_000;
const NEEDS_INSTALL_RECHECK_MS = 10_000;
const UNAVAILABLE_TEXT = {
  'no-app': 'GitHub connect is not set up on this host.',
  'device-flow-off': 'GitHub connect is off: the Glimmervoid App does not allow device sign-in yet.',
  'user-tokens-never-expire': 'GitHub connect is off: the Glimmervoid App does not expire user tokens yet.',
} as const;
const RECONNECT_REASON_TEXT = { expired: 'expired', revoked: 'was revoked' } as const;

function minutesLeft(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 60_000));
}

function connectedTextOf(login: string, accounts: readonly string[]): string {
  const otherAccounts = accounts.filter((account) => account !== login);
  if (otherAccounts.length === 0) return `Connected as ${login}.`;
  return `Connected as ${login}. App installed on ${accounts.join(', ')}.`;
}

function githubConnectViewOf(connection: GithubConnection | null | 'reading', nowMs: number): GithubConnectView {
  const view = { deviceCode: null, controls: [], isConnectWaiting: false, recheckAfterMs: null };
  if (connection === 'reading') return { ...view, text: 'Reading the GitHub connection.' };
  if (connection === null) return { ...view, text: 'Waiting for this host to answer about GitHub.', recheckAfterMs: UNANSWERED_RECHECK_MS };
  switch (connection.state) {
    case 'unavailable':
      return { ...view, text: UNAVAILABLE_TEXT[connection.reason], controls: connection.reason === 'no-app' ? [] : ['connect'] };
    case 'disconnected':
      return { ...view, text: 'Not connected. Agents push as you after you connect.', controls: ['connect'] };
    case 'awaiting-code':
      return {
        text: `Waiting for you to approve on GitHub. The code expires in ${minutesLeft(connection.expiresAtMs, nowMs)} min.`,
        deviceCode: { userCode: connection.userCode, verificationUri: connection.verificationUri },
        controls: ['connect'],
        isConnectWaiting: true,
        recheckAfterMs: AWAITING_CODE_RECHECK_MS,
      };
    case 'needs-install':
      return {
        text: `Connected as ${connection.login}. Install the Glimmervoid App on the accounts whose repositories agents should reach. Checking for installations.`,
        deviceCode: null,
        controls: ['install', 'disconnect'],
        isConnectWaiting: false,
        recheckAfterMs: NEEDS_INSTALL_RECHECK_MS,
      };
    case 'connected':
      return { ...view, text: connectedTextOf(connection.login, connection.accounts), controls: ['add-accounts', 'disconnect'] };
    case 'reconnect-needed':
      return { ...view, text: `GitHub access for ${connection.login} ${RECONNECT_REASON_TEXT[connection.reason]}. Agents cannot push.`, controls: ['connect'] };
  }
}

function githubRepoListHintOf(connection: GithubConnection | null): string {
  if (connection === null || (connection.state === 'unavailable' && connection.reason === 'no-app')) return 'Run gh auth login on the machine running Glimmervoid to list your repositories.';
  if (connection.state === 'connected') return 'Reading your repositories.';
  if (connection.state === 'needs-install') return 'Install the App to list your repositories.';
  return 'Connect GitHub to list your repositories.';
}

export { GITHUB_CONNECT_CONTROLS, githubConnectViewOf, githubRepoListHintOf };
export type { GithubConnectControl, GithubDeviceCode };
