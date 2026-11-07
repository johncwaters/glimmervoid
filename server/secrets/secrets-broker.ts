import { EventEmitter } from 'node:events';

import type { AgentNeedReply, NeedStatus, ProjectApprovals, SecretDecision, SecretRevoke, VaultJob, VaultResult } from '../../shared/contracts/secrets.ts';
import type { EnvFileWrite } from './env-file.ts';
import { unwritableEnvNames } from './core/env-file-core.ts';
import { approvalRowsOf, approvalsOf, decideNeed, denialEndsAtMs, missingReferenceNames, withApprovals, withoutApproval } from './core/secrets-broker-core.ts';
import type { ProjectSecretState } from './core/secrets-broker-core.ts';

interface NeedingSession {
  id: string;
  project: string;
  cwd: string;
  isRemote: boolean;
}

interface Delivery {
  statusByName: Record<string, NeedStatus>;
  noteByName: Record<string, string>;
  envFile: string | null;
}

interface PendingCard {
  project: string;
  names: string[];
}

interface SecretsBrokerOptions {
  readSecrets: () => unknown;
  writeSecrets: (mutate: (rawSecrets: unknown) => Record<string, unknown> | null) => Promise<boolean>;
  isCompanionOnline?: () => boolean;
  readVault?: (items: VaultJob['items']) => Promise<VaultResult['items'] | null>;
  writeEnvFile?: (directory: string, valuesByName: Readonly<Record<string, string>>) => Promise<EnvFileWrite>;
  now?: () => number;
}

const NOTE_BY_STATUS: Readonly<Record<NeedStatus, string>> = Object.freeze({
  delivered: 'written to the env file',
  pending: "waiting on the operator's approval card in Glimmervoid; ask again later or pass --wait",
  denied: 'the operator denied it; do not ask again today',
  'companion-offline': 'the vault companion is not connected, so ask the operator to run glimmervoid vault and then ask again',
  failed: 'the vault could not read it',
});

const REMOTE_SESSION_NOTE = 'this session runs on another machine, where Glimmervoid cannot write an env file yet';
const UNWRITABLE_VALUE_NOTE = 'the value holds every kind of quote, so no env file reader would get it back unchanged';
const COMPANION_LOST_NOTE = 'the vault companion did not answer, so ask again once glimmervoid vault is running';

function createSecretsBroker({ readSecrets, writeSecrets, isCompanionOnline = () => false, readVault = async () => null, writeEnvFile = async () => ({ ok: false, reason: 'no env file writer' }), now = Date.now }: SecretsBrokerOptions) {
  const events = new EventEmitter();
  const deniedUntilMsByProject = new Map<string, Record<string, number>>();
  const cardsBySession = new Map<string, PendingCard>();
  const deliveriesBySession = new Map<string, Map<string, { source: string; envFile: string }>>();

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

  function failedDelivery(names: readonly string[], note: string): Delivery {
    return {
      statusByName: Object.fromEntries(names.map((name) => [name, 'failed'])),
      noteByName: Object.fromEntries(names.map((name) => [name, note])),
      envFile: null,
    };
  }

  function deliverySource(session: NeedingSession, reference: string): string {
    return JSON.stringify([session.cwd, reference]);
  }

  function rememberDelivery(session: NeedingSession, items: readonly { name: string; reference: string }[], envFile: string): void {
    const deliveries = deliveriesBySession.get(session.id) ?? new Map<string, { source: string; envFile: string }>();
    for (const { name, reference } of items) deliveries.set(name, { source: deliverySource(session, reference), envFile });
    deliveriesBySession.set(session.id, deliveries);
    events.emit('delivered', session.id);
  }

  async function deliver(session: NeedingSession, names: readonly string[]): Promise<Delivery> {
    if (session.isRemote) return failedDelivery(names, REMOTE_SESSION_NOTE);
    const approvals = approvalsOf(readSecrets(), session.project);
    const items = names.flatMap((name) => {
      const reference = approvals[name]?.reference;
      return reference ? [{ name, reference }] : [];
    });
    const deliveries = deliveriesBySession.get(session.id);
    const alreadyDelivered = items.filter((item) => deliveries?.get(item.name)?.source === deliverySource(session, item.reference));
    const itemsToRead = items.filter((item) => !alreadyDelivered.includes(item));
    const earlier: Delivery = {
      statusByName: Object.fromEntries(alreadyDelivered.map((item) => [item.name, 'delivered'])),
      noteByName: Object.fromEntries(alreadyDelivered.map((item) => [item.name, `written to ${deliveries?.get(item.name)?.envFile ?? 'the env file'}`])),
      envFile: alreadyDelivered.length > 0 ? deliveries?.get(alreadyDelivered[0]?.name ?? '')?.envFile ?? null : null,
    };
    if (itemsToRead.length === 0) return earlier;
    return mergedDelivery(earlier, await readAndWrite(session, itemsToRead));
  }

  async function readAndWrite(session: NeedingSession, items: readonly { name: string; reference: string }[]): Promise<Delivery> {
    const names = items.map((item) => item.name);
    const resolvedItems = await readVault([...items]);
    if (resolvedItems === null) return failedDelivery(names, COMPANION_LOST_NOTE);
    const delivery: Delivery = { statusByName: {}, noteByName: {}, envFile: null };
    const valuesByName: Record<string, string> = {};
    for (const item of resolvedItems) {
      if (!names.includes(item.name)) continue;
      if ('value' in item) {
        valuesByName[item.name] = item.value;
        continue;
      }
      delivery.statusByName[item.name] = 'failed';
      delivery.noteByName[item.name] = `the vault could not read it (${item.failure.kind}): ${item.failure.message}`;
    }
    const unwritableNames = unwritableEnvNames(valuesByName);
    for (const name of unwritableNames) delete valuesByName[name];
    const unansweredNames = names.filter((name) => !Object.hasOwn(valuesByName, name) && !Object.hasOwn(delivery.statusByName, name) && !unwritableNames.includes(name));
    const answered = mergedDelivery(mergedDelivery(delivery, failedDelivery(unansweredNames, NOTE_BY_STATUS.failed)), failedDelivery(unwritableNames, UNWRITABLE_VALUE_NOTE));
    const deliveredNames = Object.keys(valuesByName);
    if (deliveredNames.length === 0) return answered;
    const written = await writeEnvFile(session.cwd, valuesByName);
    if (!written.ok) return mergedDelivery(answered, failedDelivery(deliveredNames, written.reason));
    rememberDelivery(session, items.filter((item) => deliveredNames.includes(item.name)), written.envFile);
    return mergedDelivery(answered, {
      statusByName: Object.fromEntries(deliveredNames.map((name) => [name, 'delivered'])),
      noteByName: Object.fromEntries(deliveredNames.map((name) => [name, `written to ${written.envFile}`])),
      envFile: written.envFile,
    });
  }

  function mergedDelivery(base: Delivery, overlay: Delivery): Delivery {
    return {
      statusByName: { ...base.statusByName, ...overlay.statusByName },
      noteByName: { ...base.noteByName, ...overlay.noteByName },
      envFile: overlay.envFile ?? base.envFile,
    };
  }

  async function need(session: NeedingSession, names: readonly string[]): Promise<AgentNeedReply> {
    const decision = decideNeed(projectState(session.project), names, isCompanionOnline(), now());
    raiseCard(session, decision.namesNeedingCard);
    const delivery = decision.namesToRead.length === 0 ? null : await deliver(session, decision.namesToRead);
    const results = Object.entries(decision.statusByName).map(([name, status]) => {
      const deliveredStatus = delivery?.statusByName[name];
      if (deliveredStatus === undefined) return { name, status, note: NOTE_BY_STATUS[status] };
      return { name, status: deliveredStatus, note: delivery?.noteByName[name] ?? NOTE_BY_STATUS[deliveredStatus] };
    });
    return { ok: true, results, envFile: delivery?.envFile ?? null };
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

  function forgetSession(sessionId: string): void {
    deliveriesBySession.delete(sessionId);
    closeCard(sessionId);
  }

  return { events, need, decide, revoke, requestsSnapshot, approvalRows, forgetSession };
}

type SecretsBroker = ReturnType<typeof createSecretsBroker>;

export { createSecretsBroker };
export type { SecretsBroker };
