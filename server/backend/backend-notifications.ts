import type { WebSocket } from 'ws';
import { NotificationManager } from '../../notifications/notification-manager.ts';
import { createTelegramChannel, decideTelegramNotification, formatTelegramText } from '../../notifications/channels/telegram.ts';
import { createWebNotificationChannel } from '../../notifications/channels/web-notification.ts';
import { createTelegramCompletionDefer } from '../../notifications/telegram-completion-defer.ts';
import { createTelegramDigest } from '../../notifications/telegram-digest.ts';
import { createTelegramOutbox } from '../../notifications/telegram-outbox.ts';
import type { Session } from '../../session/sessions.ts';
import type { ControlBroadcast, ControlConnectionHandler } from './backend-websockets.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { telegramSetupWarning, telegramTestRefusal } from '../core/telegram-delivery-core.ts';
import type { TelegramDeliveryStatus } from '../../shared/contracts/control-messages.ts';
import { HUB_PHONE_ALERT_TEXT_MAX } from '../../shared/contracts/hosts.ts';
import type { HubPhoneAlertFrame } from '../../shared/contracts/hosts.ts';
import type { NotificationContext } from '../../notifications/notification-manager.ts';
import { createHeartbeat } from '../ws-heartbeat.ts';
import { NOTIFICATION_STATES } from '../../shared/notification-states.ts';
import { clock } from '../../shared/clock.ts';

const ESCALATION_INTERVAL_MS = 300000;
const DEFAULT_ALERT_GROUP_WINDOW_MS = 3000;
const DEFAULT_PHONE_ESCALATION_MS = 300000;
const TELEGRAM_TEST_TEXT = 'Glimmervoid test message. Session notifications reach this chat.';

interface NotificationConfig {
  phoneEscalationMs?: number;
  notifyDebounceMs?: number;
  telegramNotifications?: boolean;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface NotificationWsServer {
  clients: ReadonlySet<WebSocket>;
}

interface DataWsServer extends NotificationWsServer {
  on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
}

interface BackendNotificationDependencies {
  config: NotificationConfig;
  configStore: { configPath: string };
  sessions: Map<string, Session>;
  controlWss: NotificationWsServer;
  onControlConnection: (handleConnection: ControlConnectionHandler) => void;
  viewerControlClientCount: () => number;
  hubControlClientCount: () => number;
  isHubControlSocket: (socket: WebSocket) => boolean;
  sendToHubControlSockets: (frame: HubPhoneAlertFrame) => number;
  dataWss: DataWsServer;
  broadcastControl: ControlBroadcast;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
}

function createBackendNotifications(dependencies: BackendNotificationDependencies) {
  const {
    config, configStore, sessions, controlWss, onControlConnection, viewerControlClientCount, hubControlClientCount, isHubControlSocket, sendToHubControlSockets,
    dataWss, broadcastControl, recordOutcome = () => {}, logger,
  } = dependencies;
  const alertGroupWindowMs = () => config.notifyDebounceMs ?? DEFAULT_ALERT_GROUP_WINDOW_MS;
  const notificationTimings = () => ({
    escalationIntervalMs: ESCALATION_INTERVAL_MS,
    alertGroupWindowMs: alertGroupWindowMs(),
    phoneEscalationMs: config.phoneEscalationMs ?? DEFAULT_PHONE_ESCALATION_MS,
  });
  const notificationManager = new NotificationManager({ ...notificationTimings(), recordOutcome });
  notificationManager.registerChannel('web', createWebNotificationChannel(broadcastControl));

  let lastTelegramFailure: TelegramDeliveryStatus['lastFailure'] = null;

  async function sendAndRecordTelegram(text: string): Promise<{ ok: boolean; error: string | null }> {
    const botToken = config.telegram?.botToken ?? '';
    const chatId = config.telegram?.chatId ?? '';
    const refusal = telegramTestRefusal({ botToken, chatId });
    if (refusal) return { ok: false, error: refusal };
    const sendResult = await sendTelegramMessage({ botToken, chatId, text, tag: 'channel:telegram' });
    lastTelegramFailure = sendResult.ok ? null : { message: sendResult.error ?? 'The send failed.', failedAt: clock.nowMs() };
    return sendResult;
  }

  function telegramDeliveryStatus(): TelegramDeliveryStatus {
    return {
      setupWarning: telegramSetupWarning({
        isEnabled: config.telegramNotifications === true,
        botToken: config.telegram?.botToken,
        chatId: config.telegram?.chatId,
      }),
      lastFailure: lastTelegramFailure,
    };
  }

  const telegramOutbox = createTelegramOutbox({
    filePath: configSiblingPath(configStore.configPath, 'telegram-outbox.json'),
    recordOutcome,
    send: (entry) => sendAndRecordTelegram(entry.text),
  });
  const telegramDigest = createTelegramDigest({ deliver: telegramOutbox.deliver, windowMs: alertGroupWindowMs() });
  const activeAgentCount = (sessionId: string) => sessions.get(sessionId)?.toSnapshot().activeAgents || 0;
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: viewerControlClientCount,
    getActiveAgentCount: activeAgentCount,
    getSessionName: (sessionId: string) => sessions.get(sessionId)?.name,
    outbox: telegramDigest,
  });
  const canTelegramEscalate = () => decideTelegramNotification({
    enabled: config.telegramNotifications === true,
    botToken: config.telegram?.botToken,
    chatId: config.telegram?.chatId,
    connectionCount: 0,
    phoneEscalation: true,
  }).send;

  const unsentHubAlertBySessionId = new Map<string, HubPhoneAlertFrame>();

  function deliverOffDashboard(sessionId: string, category: string, message: string, context?: Partial<NotificationContext>) {
    const telegramDecision = sendTelegramNotification(sessionId, category, message, context);
    if (context?.phoneEscalation !== true || telegramDecision.reason === 'active-agents') return telegramDecision;
    if (category === 'complete' && activeAgentCount(sessionId) > 0) return { send: false, reason: 'active-agents' };
    const sessionName = sessions.get(sessionId)?.name || sessionId;
    const frame: HubPhoneAlertFrame = { type: 'hub-phone-alert', text: formatTelegramText(sessionName, message).slice(0, HUB_PHONE_ALERT_TEXT_MAX) };
    if (sendToHubControlSockets(frame) > 0) return { send: true, reason: 'relayed-to-hub' };
    if (telegramDecision.send) return telegramDecision;
    unsentHubAlertBySessionId.set(sessionId, frame);
    return { send: true, reason: 'held-for-hub' };
  }

  function relayHostPhoneAlert(hostName: string, text: string): void {
    if (!canTelegramEscalate()) return;
    void telegramDigest.deliver(`${hostName}: ${text}`);
  }

  const telegramChannel = createTelegramCompletionDefer({
    deliver: deliverOffDashboard,
    onDeferredSend: (sessionId) => notificationManager.markPhoneReached(sessionId),
  });
  notificationManager.registerChannel('telegram', telegramChannel, {
    offDashboard: true,
    canEscalate: () => canTelegramEscalate() || hubControlClientCount() > 0,
  });
  void telegramOutbox.replay();

  const heartbeat = createHeartbeat({ servers: [controlWss, dataWss] });
  onControlConnection((socket) => {
    socket.on('error', (error) => {
      logger.warn(`[control-ws] Error: ${error.message}`);
    });
    heartbeat.track(socket);
    if (!isHubControlSocket(socket)) return;
    for (const frame of unsentHubAlertBySessionId.values()) socket.send(JSON.stringify(frame));
    unsentHubAlertBySessionId.clear();
    notificationManager.armPendingPhoneEscalations();
  });
  dataWss.on('connection', (socket) => heartbeat.track(socket));
  heartbeat.start();
  const reviewSessions = new Map<string, Session>();
  const investigationSessions = new Map<string, Session>();
  notificationManager.on('notification-state-change', ({ session, from, to, event, category }) => {
    if (to === NOTIFICATION_STATES.ACKNOWLEDGED || to === NOTIFICATION_STATES.IDLE) unsentHubAlertBySessionId.delete(session);
    const liveSession = sessions.get(session);
    if (!liveSession) return;
    liveSession.recordNotifyDecision({ ts: clock.nowMs(), kind: 'notify-state', from, to, event, category });
  });

  function applySettings(): void {
    notificationManager.updateSettings(notificationTimings());
  }

  return {
    applySettings,
    acknowledgeSeenAlert: (sessionId: string) => notificationManager.acknowledge(sessionId),
    heartbeat,
    investigationSessions,
    notificationManager,
    relayHostPhoneAlert,
    reviewSessions,
    telegramChannel,
    telegramDelivery: {
      status: telegramDeliveryStatus,
      sendTest: () => sendAndRecordTelegram(TELEGRAM_TEST_TEXT),
    },
    telegramOutbox: {
      ...telegramOutbox,
      idle: () => {
        void telegramDigest.flush();
        return telegramOutbox.idle();
      },
    },
  };
}

export { createBackendNotifications };
