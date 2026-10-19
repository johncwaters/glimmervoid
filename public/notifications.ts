import { reportUnsourcedError } from './action-status.ts';
import { desktopNotificationOptions } from './desktop-notification-core.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { createPlanHash } from './plan/plan-link.ts';
import { sessionName, sessionUIs } from './session-card/card-registry.ts';
import { isNotificationsEnabled } from './ui-prefs.ts';

function getNotificationApi() {
  if (typeof Notification === 'undefined') return null;
  return Notification;
}

export function notificationsSupported() {
  return getNotificationApi() !== null;
}

export function notificationPermission() {
  const notificationApi = getNotificationApi();
  if (!notificationApi) return 'unavailable';
  return notificationApi.permission;
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  const notificationApi = getNotificationApi();
  if (!notificationApi) return 'denied';
  if (notificationApi.permission !== 'default') return notificationApi.permission;
  try {
    return await notificationApi.requestPermission();
  } catch {
    return notificationApi.permission;
  }
}

export function initNotifications() {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (notificationApi.permission === 'default') {
    ensureNotificationPermission();
  }
}

const BLOCKED_NOTIFICATIONS_TEXT = 'Desktop notifications are blocked by the browser, so alerts show only in this tab. Allow notifications for this site to get them again.';

const shownNotificationsBySession = new Map<string, Set<Notification>>();
let hasReportedBlockedNotifications = false;

function reportBlockedNotificationsOnce() {
  if (hasReportedBlockedNotifications) return;
  hasReportedBlockedNotifications = true;
  reportUnsourcedError(BLOCKED_NOTIFICATIONS_TEXT, { hidesInStreamerMode: false });
}

function rememberShownNotification(sessionId: string, notification: Notification) {
  const shownForSession = shownNotificationsBySession.get(sessionId) ?? new Set<Notification>();
  shownForSession.add(notification);
  shownNotificationsBySession.set(sessionId, shownForSession);
  notification.addEventListener('close', () => shownForSession.delete(notification));
}

export function closeSessionNotifications(sessionId: string) {
  const shownForSession = shownNotificationsBySession.get(sessionId);
  if (!shownForSession) return;
  shownNotificationsBySession.delete(sessionId);
  for (const notification of shownForSession) notification.close();
}

export function showDesktopNotification({
  session,
  category,
  message,
  kind,
  ignoreFocus = false,
}: { session?: unknown; category?: unknown; message?: unknown; kind?: unknown; ignoreFocus?: unknown; [key: string]: unknown } = {}) {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (document.documentElement.hasAttribute('data-streamer')) return;
  if (!ignoreFocus && typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()) return;
  if (notificationApi.permission === 'denied') reportBlockedNotificationsOnce();
  if (notificationApi.permission !== 'granted') return;

  if (!claimNotification(window.localStorage, claimKey(session, category), Date.now())) return;
  const sessionId = typeof session === 'string' ? session : '';
  const sessionUi = sessionUIs.get(sessionId);
  const shownSessionName = sessionUi ? sessionName(sessionUi) : '';
  try {
    const notification = new notificationApi(shownSessionName || 'Glimmervoid', desktopNotificationOptions(session, category, message));
    notification.onclick = () => {
      window.focus();
      if (kind === 'plan' && sessionId) {
        window.location.hash = createPlanHash(sessionId);
      }
      notification.close();
    };
    if (sessionUi) rememberShownNotification(sessionId, notification);
  } catch {
  }
}
