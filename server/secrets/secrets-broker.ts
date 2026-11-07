import { EventEmitter } from 'node:events';

import type { AgentNeedReply, NeedResult, NeedStatus, ProjectApprovals, SecretDecision, SecretRevoke } from '../../shared/contracts/secrets.ts';
import { approvalRowsOf, approvalsOf, decideNeed, denialEndsAtMs, missingReferenceNames, withApprovals, withoutApproval } from './core/secrets-broker-core.ts';
import type { ProjectSecretState } from './core/secrets-broker-core.ts';

interface NeedingSession {
  id: string;
  project: string;
}

interface PendingCard {
  project: string;
  names: string[];
}

interface SecretsBrokerOptions {
  readSecrets: () => unknown;
  writeSecrets: (mutate: (rawSecrets: unknown) => Record<string, unknown> | null) => Promise<boolean>;
  isCompanionOnline?: () => boolean;
  now?: () => number;
}

const NOTE_BY_STATUS: Readonly<Record<NeedStatus, string>> = Object.freeze({
  delivered: 'written to the env file',
  pending: "waiting on the operator's approval card in Glimmervoid; ask again later or pass --wait",
  denied: 'the operator denied it; do not ask again today',
  'companion-offline': 'the vault companion is not connected, so ask the operator to run glimmervoid vault and then ask again',
  failed: 'the vault could not read it',
});

function createSecretsBroker({ readSecrets, writeSecrets, isCompanionOnline = () => false, now = Date.now }: SecretsBrokerOptions) {
  const events = new EventEmitter();
  const deniedUntilMsByProject = new Map<string, Record<string, number>>();
  const cardsBySession = new Map<string, PendingCard>();

  function projectState(project: string): ProjectSecretState {
    return { approvals: approvalsOf(readSecrets(), project), deniedUntilMs: deniedUntilMsByProject.get(project) ?? {} };
  }

  function raiseCard(session: NeedingSession, names: readonly string[]): void {
    const card = cardsBySession.get(session.id) ?? { project: session.project, names: [] };
    const newNames = names.filter((name) => !card.names.includes(name));
    if (newNames.length === 0) return;
    card.names = [...card.names, ...newNames];
    cardsBySession.set(session.id, card);
    emitCard(session.id, newNames);
  }

  function need(session: NeedingSession, names: readonly string[]): AgentNeedReply {
    const decision = decideNeed(projectState(session.project), names, isCompanionOnline(), now());
    raiseCard(session, decision.namesNeedingCard);
    const results: NeedResult[] = Object.entries(decision.statusByName).map(([name, status]) => ({ name, status, note: NOTE_BY_STATUS[status] }));
    return { ok: true, results, envFile: null };
  }

  function emitCard(sessionId: string, newNames: readonly string[]): void {
    events.emit('card-changed', { sessionId, names: cardsBySession.get(sessionId)?.names ?? [], newNames });
  }

  function closeCard(sessionId: string): void {
    if (!cardsBySession.delete(sessionId)) return;
    emitCard(sessionId, []);
  }

  function restoreCard(sessionId: string, claimed: PendingCard): void {
    const raisedMeanwhile = cardsBySession.get(sessionId)?.names ?? [];
    cardsBySession.set(sessionId, { project: claimed.project, names: [...claimed.names, ...raisedMeanwhile.filter((name) => !claimed.names.includes(name))] });
    emitCard(sessionId, []);
  }

  function holdDenial(project: string, names: readonly string[]): void {
    const deniedUntilMs = { ...deniedUntilMsByProject.get(project) };
    for (const name of names) deniedUntilMs[name] = denialEndsAtMs(now());
    deniedUntilMsByProject.set(project, deniedUntilMs);
  }

  function releaseDenial(project: string, names: readonly string[]): void {
    const deniedUntilMs = { ...deniedUntilMsByProject.get(project) };
    for (const name of names) delete deniedUntilMs[name];
    deniedUntilMsByProject.set(project, deniedUntilMs);
  }

  async function decide(decision: SecretDecision): Promise<string | null> {
    const card = cardsBySession.get(decision.id);
    if (!card) return 'This secret request was already answered.';
    if (!decision.isAllowed) {
      holdDenial(card.project, card.names);
      closeCard(decision.id);
      return null;
    }
    const referenceByName = Object.fromEntries(card.names.map((name) => [name, decision.referenceByName[name] ?? '']));
    const missingNames = missingReferenceNames(card.names, referenceByName);
    if (missingNames.length > 0) return `Give a vault reference for ${missingNames.join(', ')} before allowing.`;
    cardsBySession.delete(decision.id);
    const isSaved = await writeSecrets((rawSecrets) => withApprovals(rawSecrets, card.project, referenceByName));
    if (!isSaved) {
      restoreCard(decision.id, card);
      return 'Glimmervoid could not save the approval to config.json.';
    }
    releaseDenial(card.project, card.names);
    emitCard(decision.id, []);
    events.emit('approvals-changed');
    return null;
  }

  async function revoke({ project, name }: SecretRevoke): Promise<string | null> {
    const isSaved = await writeSecrets((rawSecrets) => withoutApproval(rawSecrets, project, name));
    if (!isSaved) return 'Glimmervoid could not save the change to config.json.';
    events.emit('approvals-changed');
    return null;
  }

  function requestsSnapshot(): Record<string, string[]> {
    return Object.fromEntries([...cardsBySession].map(([sessionId, card]) => [sessionId, card.names]));
  }

  function approvalRows(): ProjectApprovals[] {
    return approvalRowsOf(readSecrets());
  }

  return { events, need, decide, revoke, requestsSnapshot, approvalRows, forgetSession: closeCard };
}

type SecretsBroker = ReturnType<typeof createSecretsBroker>;

export { createSecretsBroker };
export type { SecretsBroker };
