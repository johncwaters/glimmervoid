import type { NotificationContext } from './notification-manager.ts';

interface DeferredDelivery {
  sessionId: string;
  category: string;
  message: string;
  context?: Partial<NotificationContext>;
}

interface DeliveryDecision {
  send?: boolean;
  reason?: string;
}

function createTelegramCompletionDefer({
  deliver,
  onDeferredSend = () => {},
}: {
  deliver: (
    sessionId: string,
    category: string,
    message: string,
    context?: Partial<NotificationContext>,
  ) => DeliveryDecision | undefined;
  onDeferredSend?: (sessionId: string) => void;
}) {
  const pendingCompletions = new Map<string, DeferredDelivery>();

  function cancel(sessionId: string): void {
    pendingCompletions.delete(sessionId);
  }

  function schedule(delivery: DeferredDelivery): void {
    pendingCompletions.set(delivery.sessionId, delivery);
  }

  function send(delivery: DeferredDelivery): DeliveryDecision | undefined {
    const decision = deliver(
      delivery.sessionId, delivery.category, delivery.message, delivery.context,
    );
    if (decision?.reason === 'active-agents') {
      schedule(delivery);
      return decision;
    }
    cancel(delivery.sessionId);
    return decision;
  }

  function sendDeferred(delivery: DeferredDelivery): void {
    const decision = send(delivery);
    if (decision?.send === true) onDeferredSend(delivery.sessionId);
  }

  function channel(
    sessionId: string,
    category: string,
    message: string,
    context?: Partial<NotificationContext>,
  ): DeliveryDecision | undefined {
    if (category !== 'complete') cancel(sessionId);
    return send({ sessionId, category, message, context });
  }

  channel.recheck = (sessionId: string): void => {
    const delivery = pendingCompletions.get(sessionId);
    if (!delivery) return;
    cancel(sessionId);
    sendDeferred(delivery);
  };
  channel.noteStateChange = cancel;
  channel.destroy = (): void => {
    pendingCompletions.clear();
  };
  return channel;
}

export { createTelegramCompletionDefer };
