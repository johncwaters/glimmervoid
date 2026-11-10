import { EventEmitter } from 'node:events';
import path from 'node:path';

import type { AgentNeedReply, NeedStatus, ProjectApprovals, SecretDecision, SecretRevoke, CreateJob, CreatedResult, ResolveJob, ResolvedResult } from '../../shared/contracts/secrets.ts';
import type { Telemetry } from '../telemetry.ts';
import type { EnvFileWrite } from './env-file.ts';
import type { CreateMiss } from './vault-socket.ts';
import { MAX_VAULT_NAME_LENGTH } from '../../shared/contracts/secrets.ts';
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
  readVault?: (items: ResolveJob['items']) => Promise<ResolvedResult['items'] | null>;
  createInVault?: (items: CreateJob['items']) => Promise<CreatedResult['items'] | CreateMiss>;
  newItemsVault?: () => string | null;
  writeEnvFile?: (directory: string, valuesByName: Readonly<Record<string, string>>) => Promise<EnvFileWrite>;
  readEnvValues?: (directory: string) => Promise<Readonly<Record<string, string>>>;
  now?: () => number;
  telemetry?: Pick<Telemetry, 'capture'> | null;
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
const CREATE_MISS_REFUSALS: Readonly<Record<CreateMiss, string>> = Object.freeze({
  offline: 'The vault companion is not connected, so the pasted values cannot go into the vault; run glimmervoid vault, or give a reference instead.',
  outdated: 'The running vault companion predates pasting values; restart glimmervoid vault, or give a reference instead.',
  invalid: 'The pasted values or vault name are too long for a vault item; give a reference instead.',
  'no-answer': 'The vault companion did not answer in time, so the items may or may not exist; check the vault for them, then give their references instead of pasting again.',
});
const COMPANION_LOST_NOTE = 'the vault companion did not answer, so ask again once glimmervoid vault is running';

function createSecretsBroker({ readSecrets, writeSecrets, isCompanionOnline = () => false, readVault = async () => null, createInVault = async () => 'offline', newItemsVault = () => null, writeEnvFile = async () => ({ ok: false, reason: 'no env file writer' }), readEnvValues = async () => ({}), now = Date.now, telemetry = null }: SecretsBrokerOptions) {
  const events = new EventEmitter();
  const deniedUntilMsByProject = new Map<string, Record<string, number>>();
  const cardsBySession = new Map<string, PendingCard>();
  const decidingSessionIds = new Set<string>();
  const deliveriesBySession = new Map<string, Map<string, { source: string; envFile: string }>>();
  const deliveredValuesBySession = new Map<string, Set<string>>();

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

  function rememberDelivery(session: NeedingSession, items: readonly { name: string; reference: string }[], envFile: string, valuesByName: Readonly<Record<string, string>>): void {
    const deliveries = deliveriesBySession.get(session.id) ?? new Map<string, { source: string; envFile: string }>();
    for (const { name, reference } of items) deliveries.set(name, { source: deliverySource(session, reference), envFile });
    deliveriesBySession.set(session.id, deliveries);
    addDeliveredValues(session.id, Object.values(valuesByName));
  }

  function addDeliveredValues(sessionId: string, values: readonly string[]): void {
    deliveredValuesBySession.set(sessionId, new Set([...deliveredValuesOf(sessionId), ...values]));
    events.emit('delivered', sessionId);
  }

  async function seedMasks(session: NeedingSession): Promise<string | null> {
    if (session.isRemote) return null;
    const approvedNames = Object.entries(approvalsOf(readSecrets(), session.project)).filter(([, approval]) => approval.isAllowed).map(([name]) => name);
    if (approvedNames.length === 0) return null;
    try {
      const envValues = await readEnvValues(session.cwd);
      const approvedValues = approvedNames.map((name) => envValues[name] ?? '').filter((value) => value !== '');
      if (approvedValues.length > 0) addDeliveredValues(session.id, approvedValues);
      return null;
    } catch (error) {
      return `could not read the env file of session ${session.id} to mask its secrets: ${error instanceof Error ? error.message : String(error)}`;
    }
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
    rememberDelivery(session, items.filter((item) => deliveredNames.includes(item.name)), written.envFile, valuesByName);
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
    reportAnswer(results.map((result) => result.status));
    return { ok: true, results, envFile: delivery?.envFile ?? null };
  }

  function reportAnswer(statuses: readonly NeedStatus[]): void {
    const countOf = (status: NeedStatus) => statuses.filter((answeredStatus) => answeredStatus === status).length;
    telemetry?.capture('vault_secret_answered', {
      delivered_count: countOf('delivered'),
      pending_count: countOf('pending'),
      denied_count: countOf('denied'),
      companion_offline_count: countOf('companion-offline'),
      failed_count: countOf('failed'),
    });
  }

  function emitCard(sessionId: string, newNames: readonly string[]): void {
    events.emit('card-changed', { sessionId, names: cardsBySession.get(sessionId)?.names ?? [], newItemsVault: newItemsVault(), newNames });
  }

  function closeCard(sessionId: string): void {
    if (!cardsBySession.delete(sessionId)) return;
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
    if (decidingSessionIds.has(decision.id)) return 'This secret request is already being answered.';
    if (!decision.isAllowed) {
      holdDenial(card.project, card.names);
      closeCard(decision.id);
      return null;
    }
    const decidedNames = [...card.names];
    const referenceByName = Object.fromEntries(decidedNames.map((name) => [name, decision.referenceByName[name] ?? '']));
    const pastedNames = decidedNames.filter((name) => !referenceByName[name] && decision.valueByName[name]);
    const missingNames = missingReferenceNames(decidedNames, referenceByName).filter((name) => !pastedNames.includes(name));
    if (missingNames.length > 0) return `Give a vault reference or paste the value for ${missingNames.join(', ')} before allowing.`;
    decidingSessionIds.add(decision.id);
    try {
      return await allow(decision, card.project, referenceByName, pastedNames);
    } finally {
      decidingSessionIds.delete(decision.id);
    }
  }

  async function allow(decision: SecretDecision, project: string, referenceByName: Record<string, string>, pastedNames: readonly string[]): Promise<string | null> {
    const creation = await createPastedItems(project, pastedNames, decision);
    if (typeof creation === 'string') return creation;
    const referencesToSave = Object.fromEntries(Object.entries({ ...referenceByName, ...creation.referenceByName }).filter(([, reference]) => reference !== ''));
    const isSaved = await writeSecrets((rawSecrets) => withApprovals(rawSecrets, project, referencesToSave));
    if (!isSaved) return 'Glimmervoid could not save the approval to config.json.';
    const savedNames = Object.keys(referencesToSave);
    releaseDenial(project, savedNames);
    dropFromCard(decision.id, savedNames);
    events.emit('approvals-changed');
    if (creation.failures.length === 0) return null;
    return `The vault could not create ${creation.failures.map((failure) => `${failure.name} (${failure.message})`).join(', ')}.`;
  }

  function dropFromCard(sessionId: string, names: readonly string[]): void {
    const card = cardsBySession.get(sessionId);
    if (!card) return;
    card.names = card.names.filter((name) => !names.includes(name));
    if (card.names.length === 0) cardsBySession.delete(sessionId);
    emitCard(sessionId, []);
  }

  function vaultItemTitle(name: string, project: string): string {
    const projectRoom = MAX_VAULT_NAME_LENGTH - name.length - ' ()'.length;
    return `${name} (${path.basename(project).slice(0, projectRoom)})`;
  }

  async function createPastedItems(project: string, pastedNames: readonly string[], decision: SecretDecision): Promise<string | { referenceByName: Record<string, string>; failures: { name: string; message: string }[] }> {
    if (pastedNames.length === 0) return { referenceByName: {}, failures: [] };
    const createdItems = await createInVault(pastedNames.map((name) => ({ name, title: vaultItemTitle(name, project), value: decision.valueByName[name] ?? '', vaultName: decision.newItemsVault })));
    if (typeof createdItems === 'string') return CREATE_MISS_REFUSALS[createdItems];
    const referenceByName: Record<string, string> = {};
    const failures: { name: string; message: string }[] = [];
    for (const item of createdItems) {
      if (!pastedNames.includes(item.name)) continue;
      if ('reference' in item) {
        referenceByName[item.name] = item.reference;
        continue;
      }
      failures.push({ name: item.name, message: item.failure.message });
    }
    const unansweredNames = pastedNames.filter((name) => !Object.hasOwn(referenceByName, name) && !failures.some((failure) => failure.name === name));
    return { referenceByName, failures: [...failures, ...unansweredNames.map((name) => ({ name, message: 'the companion did not answer' }))] };
  }

  function refreshCards(): void {
    for (const sessionId of cardsBySession.keys()) emitCard(sessionId, []);
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

  function deliveredValuesOf(sessionId: string): string[] {
    return [...(deliveredValuesBySession.get(sessionId) ?? [])];
  }

  function forgetSession(sessionId: string): void {
    deliveriesBySession.delete(sessionId);
    deliveredValuesBySession.delete(sessionId);
    closeCard(sessionId);
  }

  return { events, need, decide, revoke, requestsSnapshot, approvalRows, forgetSession, refreshCards, newItemsVault, deliveredValuesOf, seedMasks };
}

type SecretsBroker = ReturnType<typeof createSecretsBroker>;

export { createSecretsBroker };
export type { SecretsBroker };
