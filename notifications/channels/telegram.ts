import { sendTelegramMessage } from '../../server/telegram-transport.ts';
import { decideOffDashboardDelivery } from '../../server/core/client-presence.ts';
import type { NotificationContext } from '../notification-manager.ts';
import { sessionTagFor, withoutSessionTags } from '../../server/core/telegram-inbound-core.ts';

interface TelegramDecision {
  send: boolean;
  reason: string;
}

interface TelegramGateInput {
  enabled: unknown;

  botToken: string | undefined;

  chatId: string | undefined;

  connectionCount: number;

  phoneEscalation?: boolean;
  category?: string | null;
  activeAgents?: number;
}

interface OffDashboardGateInput {
  isEnabled: boolean;
  isConfigured: boolean;
  connectionCount: number;
  phoneEscalation: boolean;
  category: string | null;
  activeAgents: number;
}

function decideOffDashboardChannel({ isEnabled, isConfigured, connectionCount, phoneEscalation, category, activeAgents }: OffDashboardGateInput): TelegramDecision {
  if (!isEnabled) return { send: false, reason: 'disabled' };
  if (!isConfigured) return { send: false, reason: 'not-configured' };
  if (category === 'complete' && activeAgents > 0) return { send: false, reason: 'active-agents' };
  if (phoneEscalation) return { send: true, reason: 'unacknowledged-escalation' };
  if (!decideOffDashboardDelivery(connectionCount)) return { send: false, reason: 'dashboard-open' };
  return { send: true, reason: 'no-dashboard-audience' };
}

function decideTelegramNotification({
  enabled,
  botToken,
  chatId,
  connectionCount,
  phoneEscalation = false,
  category = null,
  activeAgents = 0,
}: TelegramGateInput): TelegramDecision {
  return decideOffDashboardChannel({
    isEnabled: enabled === true,
    isConfigured: Boolean(botToken && chatId),
    connectionCount,
    phoneEscalation: phoneEscalation === true,
    category,
    activeAgents,
  });
}

function formatTelegramText(sessionName: string, message: string): string {
  return message || `${sessionName} needs attention`;
}

interface TelegramChannelDeps {
  getConfig: () => { telegramNotifications?: boolean; telegram?: { botToken?: string; chatId?: string; acceptReplies?: boolean } | null } | null;

  getConnectionCount: () => number;
  getActiveAgentCount?: (sessionId: string) => number;
  getSessionName?: (sessionId: string) => string | undefined;

  outbox?: { deliver: (text: string) => Promise<void> } | null;

  taggedOutbox?: { deliver: (text: string) => Promise<void> } | null;

  send?: (message: { botToken: string; chatId: string; text: string; tag?: string }) => unknown;
}

function createTelegramChannel({
  getConfig,
  getConnectionCount,
  getActiveAgentCount = () => 0,
  getSessionName = () => undefined,
  outbox = null,
  taggedOutbox = null,
  send = sendTelegramMessage,
}: TelegramChannelDeps): (sessionName: string, category: string, message: string, context?: Partial<NotificationContext>) => TelegramDecision {
  return function telegramChannel(sessionId, category, message, context) {
    const config = getConfig() || {};
    const telegram = config.telegram || {};
    const botToken = telegram.botToken;
    const chatId = telegram.chatId;
    const activeAgents = category === 'complete' ? getActiveAgentCount(sessionId) : 0;
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken,
      chatId,
      connectionCount: getConnectionCount(),
      phoneEscalation: context?.phoneEscalation === true,
      category,
      activeAgents,
    });
    if (!decision.send) return decision;
    if (!botToken || !chatId) return decision;
    const alertText = formatTelegramText(getSessionName(sessionId) || sessionId, message);
    const isTagged = telegram.acceptReplies === true;
    const text = isTagged ? `${withoutSessionTags(alertText)} ${sessionTagFor(sessionId)}` : alertText;
    const target = isTagged ? taggedOutbox ?? outbox : outbox;

    if (target) {
      void target.deliver(text);
      return decision;
    }

    send({
      botToken,
      chatId,
      text,
      tag: 'channel:telegram',
    });
    return decision;
  };
}

export { createTelegramChannel, decideOffDashboardChannel, decideTelegramNotification, formatTelegramText };
export type { TelegramDecision };
