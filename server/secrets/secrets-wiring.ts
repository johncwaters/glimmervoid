import type { Session } from '../../session/sessions.ts';
import type { SecretsBroker } from './secrets-broker.ts';

interface CardChange {
  sessionId: string;
  names: string[];
  newItemsVault: string | null;
  newNames: string[];
}

interface SecretsWiringOptions {
  broker: SecretsBroker;
  findSession: (id: string) => Session | null;
  broadcastControl: (message: Record<string, unknown>) => void;
}

function wireSecretsBroker({ broker, findSession, broadcastControl }: SecretsWiringOptions): void {
  const watchedSessionIds = new Set<string>();
  function forgetOnTeardown(session: Session): void {
    if (watchedSessionIds.has(session.id)) return;
    watchedSessionIds.add(session.id);
    session.once('teardown', () => {
      watchedSessionIds.delete(session.id);
      broker.forgetSession(session.id);
    });
  }
  broker.events.on('card-changed', ({ sessionId, names, newItemsVault, newNames }: CardChange) => {
    broadcastControl({ type: 'session-secret-request', id: sessionId, names, newItemsVault });
    if (newNames.length === 0) return;
    const session = findSession(sessionId);
    if (!session) return;
    forgetOnTeardown(session);
    session.noteAttention(`asks for ${newNames.join(', ')}: allow or deny on this session's card`);
  });
  broker.events.on('delivered', (sessionId: string) => {
    const session = findSession(sessionId);
    if (!session) return;
    session.maskDeliveredSecretValues(broker.deliveredValuesOf(sessionId));
    forgetOnTeardown(session);
  });
  broker.events.on('approvals-changed', () => broadcastControl({ type: 'secret-approvals', projects: broker.approvalRows() }));
}

export { wireSecretsBroker };
