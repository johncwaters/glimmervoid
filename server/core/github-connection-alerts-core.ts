import type { GithubConnection, GithubConnectionNotified } from '../../shared/contracts/watcher-link.ts';

const EXPIRY_WARNING_LEAD_MS = 14 * 24 * 60 * 60_000;
const NOTHING_NOTIFIED: GithubConnectionNotified = { expiringRefreshTokenExpiresAtMs: null, reconnectNeededLogin: null };
const RECONNECT_REASON_TEXT = { expired: 'expired', revoked: 'was refused by GitHub' } as const;

type GithubConnectionAlertStep = { message: string | null; notified: GithubConnectionNotified };

function githubConnectionAlertStep(connection: GithubConnection, notified: GithubConnectionNotified | null, { nowMs, operatorDayOf }: { nowMs: number; operatorDayOf: (epochMs: number) => string }): GithubConnectionAlertStep {
  const held = notified ?? NOTHING_NOTIFIED;
  if (connection.state === 'reconnect-needed') {
    if (held.reconnectNeededLogin === connection.login) return { message: null, notified: held };
    return {
      message: `The GitHub connection for ${connection.login} ${RECONNECT_REASON_TEXT[connection.reason]}, so git in your sessions cannot push as you. Connect GitHub again in Settings, Vault.`,
      notified: { ...held, reconnectNeededLogin: connection.login },
    };
  }
  const reconnected = { ...held, reconnectNeededLogin: null };
  if (connection.state !== 'connected') return { message: null, notified: reconnected };
  const isExpiringSoon = connection.refreshTokenExpiresAtMs - nowMs <= EXPIRY_WARNING_LEAD_MS;
  if (!isExpiringSoon || held.expiringRefreshTokenExpiresAtMs === connection.refreshTokenExpiresAtMs) return { message: null, notified: reconnected };
  return {
    message: `The GitHub connection for ${connection.login} ends on ${operatorDayOf(connection.refreshTokenExpiresAtMs)}. Disconnect and connect GitHub again in Settings, Vault before then, so git in your sessions keeps pushing as you.`,
    notified: { ...reconnected, expiringRefreshTokenExpiresAtMs: connection.refreshTokenExpiresAtMs },
  };
}

export { githubConnectionAlertStep };
