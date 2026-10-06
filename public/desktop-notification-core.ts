export function desktopNotificationOptions(session: unknown, category: unknown, message: unknown): NotificationOptions & { renotify: boolean } {
  return {
    body: String(message || 'Session needs attention'),
    tag: `glimmervoid-${session || ''}-${category || ''}`,
    renotify: true,
    silent: true,
  };
}
