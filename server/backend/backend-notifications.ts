import type { WebSocket } from 'ws';
import { NotificationManager } from '../../notifications/notification-manager.ts';
import { createTelegramChannel, decideTelegramNotification } from '../../notifications/channels/telegram.ts';
import { createWebNotificationChannel } from '../../notifications/channels/web-notification.ts';
import { createTelegramCompletionDefer } from '../../notifications/telegram-completion-defer.ts';
import { createTelegramDigest } from '../../notifications/telegram-digest.ts';
import { createTelegramOutbox } from '../../notifications/telegram-outbox.ts';
import type { Session } from '../../session/sessions.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { createClientPresence } from '../core/client-presence.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { telegramSetupWarning, telegramTestRefusal } from '../core/telegram-delivery-core.ts';
import type { TelegramDeliveryStatus } from '../../shared/contracts/control-messages.ts';
import { createHeartbeat } from '../ws-heartbeat.ts';

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
  clients: Iterable<WebSocket>;
  on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
}

interface BackendNotificationDependencies {
  config: NotificationConfig;
  configStore: { configPath: string };
  sessions: Map<string, Session>;
  controlWss: NotificationWsServer;
  dataWss: NotificationWsServer;
  broadcastControl: ControlBroadcast;
  recordOutcome?: OutcomeRecorder;
  logger: Pick<Console, 'warn'>;
}

function createBackendNotifications(dependencies: BackendNotificationDependencies) {
  const {
    config, configStore, sessions, controlWss, dataWss, broadcastControl, recordOutcome = () => {}, logger,
  } = dependencies;
  const clientPresence = createClientPresence();
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
    lastTelegramFailure = sendResult.ok ? null : { message: sendResult.error ?? 'The send failed.', failedAt: Date.now() };
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
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => clientPresence.connectionCount(),
    getActiveAgentCount: (sessionId: string) => sessions.get(sessionId)?.toSnapshot().activeAgents || 0,
    getSessionName: (sessionId: string) => sessions.get(sessionId)?.name,
    outbox: telegramDigest,
  });
  const telegramChannel = createTelegramCompletionDefer({
    deliver: sendTelegramNotification,
    onDeferredSend: (sessionId) => notificationManager.markPhoneReached(sessionId),
  });
  notificationManager.registerChannel('telegram', telegramChannel, {
    offDashboard: true,
    canEscalate: () => decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: config.telegram?.botToken,
      chatId: config.telegram?.chatId,
      connectionCount: 0,
      phoneEscalation: true,
    }).send,
  });
  void telegramOutbox.replay();

  notificationManager.setSessionInViewCheck(clientPresence.isSessionInView);

  function handleClientFocus(socket: WebSocket, viewedSessionIds: readonly string[]): void {
    clientPresence.setViewedSessions(socket, viewedSessionIds);
  }

  controlWss.on('connection', (socket) => {
    clientPresence.connect(socket);
    socket.on('error', (error) => {
      logger.warn(`[control-ws] Error: ${error.message}`);
    });
    socket.on('close', () => {
      clientPresence.disconnect(socket);
    });
  });

  const heartbeat = createHeartbeat({ servers: [controlWss, dataWss] });
  controlWss.on('connection', (socket) => heartbeat.track(socket));
  dataWss.on('connection', (socket) => heartbeat.track(socket));
  heartbeat.start();
  const reviewSessions = new Map<string, Session>();
  const investigationSessions = new Map<string, Session>();
  notificationManager.on('notification-state-change', ({ session, from, to, event, category }) => {
    const liveSession = sessions.get(session);
    if (!liveSession) return;
    liveSession.recordNotifyDecision({ ts: Date.now(), kind: 'notify-state', from, to, event, category });
  });

  function applySettings(): void {
    notificationManager.updateSettings(notificationTimings());
  }

  return {
    applySettings,
    handleClientFocus,
    heartbeat,
    investigationSessions,
    notificationManager,
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
