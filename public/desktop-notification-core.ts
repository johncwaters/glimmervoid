import type { NotifyAlertGroup } from '#shared/contracts/control-messages.ts';
import { QUIET_NOTIFY_CATEGORIES } from '#shared/contracts/session.ts';

export function desktopNotificationOptions(session: unknown, category: unknown, message: unknown): NotificationOptions & { renotify: boolean } {
  return {
    body: String(message || 'Session needs attention'),
    tag: `glimmervoid-${session || ''}-${category || ''}`,
    renotify: true,
    silent: typeof category === 'string' && QUIET_NOTIFY_CATEGORIES.has(category),
  };
}

export function foldAlertGroupLines(
  current: { groupId: number; lines: string[] } | null,
  group: NotifyAlertGroup,
  message: string,
): { groupId: number; lines: string[] } {
  const isSameGroup = !group.isStart && current !== null && current.groupId === group.id;
  const priorLines = isSameGroup ? current.lines : [];
  return { groupId: group.id, lines: [...priorLines, message || 'Session needs attention'] };
}

export function alertGroupBannerOptions(group: NotifyAlertGroup, lines: readonly string[]): NotificationOptions & { renotify: boolean } {
  return {
    body: lines.join('\n'),
    tag: `glimmervoid-alert-${group.id}`,
    renotify: group.isStart,
  };
}
