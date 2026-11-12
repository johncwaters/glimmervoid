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
  warn?: (message: string) => void;
}

interface SecretsWiring {
  seedSessionMasks: (session: Session) => void;
}

function wireSecretsBroker({ broker, findSession, broadcastControl, warn = console.warn }: SecretsWiringOptions): SecretsWiring {
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
    session.raiseAttention('secret', `asks for ${newNames.join(', ')}: allow or deny on this session's card`);
  });
  broker.events.on('delivered', (sessionId: string) => {
    const session = findSession(sessionId);
    if (!session) return;
    session.maskDeliveredSecretValues(broker.deliveredValuesOf(sessionId));
    forgetOnTeardown(session);
  });
  broker.events.on('approvals-changed', () => broadcastControl({ type: 'secret-approvals', projects: broker.approvalRows() }));

  const seededDirectoryBySession = new WeakMap<Session, string>();
  function seedFromCurrentDirectory(session: Session): void {
    const directory = session.effectiveCwd();
    if (seededDirectoryBySession.get(session) === directory) return;
    seededDirectoryBySession.set(session, directory);
    void broker.seedMasks({ id: session.id, project: session.path, cwd: directory }).then((problem) => {
      if (problem !== null) warn(`[secrets] ${problem}`);
    });
  }
  function seedSessionMasks(session: Session): void {
    seedFromCurrentDirectory(session);
    session.on('state-change', () => seedFromCurrentDirectory(session));
  }
  return { seedSessionMasks };
}

export { wireSecretsBroker };
