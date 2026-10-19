import { reportUnsourcedError } from './action-status.ts';
import { desktopNotificationOptions } from './desktop-notification-core.ts';
import { el } from './dom-helpers.ts';
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

function notificationPermission() {
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

function notificationPermissionHint(): string | null {
  if (!notificationsSupported() && !window.isSecureContext) return 'Browsers allow desktop notifications only over HTTPS or on localhost, and this page is plain HTTP on another address. Open the dashboard on localhost, or use Telegram.';
  if (!notificationsSupported()) return 'This browser does not support desktop notifications.';
  if (notificationPermission() === 'denied' && isNotificationsEnabled()) return 'Blocked by the browser. Allow notifications for this site in its site settings.';
  return null;
}

function canAskNotificationPermission() {
  return isNotificationsEnabled() && notificationPermission() === 'default';
}

export function createNotificationPermissionControl(onAnswered: () => void = () => {}) {
  const control = el('div', 'notification-permission');
  const render = () => {
    const hint = notificationPermissionHint();
    control.replaceChildren();
    control.hidden = !hint && !canAskNotificationPermission();
    if (hint) {
      control.append(el('p', 'notification-permission-hint text-xs text-text-muted', hint));
      return;
    }
    const button = el('button', 'btn-dialog btn-dialog-cancel', 'Enable desktop notifications');
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      void ensureNotificationPermission().then(() => {
        render();
        onAnswered();
      });
    });
    control.append(button);
  };
  render();
  return { element: control, refresh: render };
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
