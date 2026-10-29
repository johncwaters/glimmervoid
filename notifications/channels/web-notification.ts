import type { NotifyAlertGroup } from '../../shared/contracts/control-messages.ts';

type NotifyBroadcast = {
  type: string;
  session: string;
  category: string;
  message: string;
  escalationCount: number;
  kind?: 'plan';
  group?: NotifyAlertGroup;
};

function createWebNotificationChannel(
  broadcast: (msg: NotifyBroadcast) => void,
): (
  sessionName: string,
  category: string,
  message: string,
  context?: { escalationCount?: number; kind?: 'plan'; group?: NotifyAlertGroup } | null,
) => undefined {
  return function webNotificationChannel(sessionName, category, message, context) {
    broadcast({
      type: 'notify',
      session: sessionName,
      category,
      message,
      escalationCount: context?.escalationCount ?? 0,
      ...(context?.kind ? { kind: context.kind } : {}),
      ...(context?.group ? { group: context.group } : {}),
    });
  };
}

export { createWebNotificationChannel };
