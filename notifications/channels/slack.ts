import { sendSlackMessage } from '../../server/slack-transport.ts';
import { decideOffDashboardChannel, formatTelegramText } from './telegram.ts';
import type { TelegramDecision } from './telegram.ts';
import type { NotificationContext } from '../notification-manager.ts';

interface SlackChannelDeps {
  getConfig: () => { slack?: { webhookUrl?: string } | null } | null;
  getConnectionCount: () => number;
  getActiveAgentCount: (sessionId: string) => number;
  getSessionName: (sessionId: string) => string | undefined;
  send?: (message: { webhookUrl: string; text: string }) => unknown;
}

function createSlackChannel({ getConfig, getConnectionCount, getActiveAgentCount, getSessionName, send = sendSlackMessage }: SlackChannelDeps) {
  function slackDecision(sessionId: string, category: string | null, phoneEscalation: boolean): TelegramDecision {
    const slack = getConfig()?.slack ?? {};
    return decideOffDashboardChannel({
      isConfigured: Boolean(slack.webhookUrl?.trim()),
      connectionCount: phoneEscalation ? 0 : getConnectionCount(),
      phoneEscalation,
      category,
      activeAgents: category === 'complete' ? getActiveAgentCount(sessionId) : 0,
    });
  }

  function slackChannel(sessionId: string, category: string, message: string, context?: Partial<NotificationContext>): TelegramDecision {
    const decision = slackDecision(sessionId, category, context?.phoneEscalation === true);
    const webhookUrl = getConfig()?.slack?.webhookUrl;
    if (!decision.send || !webhookUrl) return decision;
    send({ webhookUrl, text: formatTelegramText(getSessionName(sessionId) || sessionId, message) });
    return decision;
  }

  return {
    slackChannel,
    canEscalate: () => slackDecision('', null, true).send,
  };
}

export { createSlackChannel };
