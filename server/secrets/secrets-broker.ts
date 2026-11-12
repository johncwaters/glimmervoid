import { EventEmitter } from 'node:events';

import type { AgentNeedReply, NeedStatus, ProjectApprovals, SecretDecision, SecretRequestCard, SecretRevoke, SecretSource } from '../../shared/contracts/secrets.ts';
import type { Telemetry } from '../telemetry.ts';
import type { EnvFileWrite } from './env-file.ts';
import type { ReadOutcome } from './core/fnox-core.ts';
import { unwritableEnvNames } from './core/env-file-core.ts';
import { approvalRowsOf, approvalsOf, decideNeed, denialEndsAtMs, sourceLabel, withAllowedNames, withoutApproval } from './core/secrets-broker-core.ts';
import type { ProjectSecretState } from './core/secrets-broker-core.ts';
import { clock } from '../../shared/clock.ts';

interface NeedingSession {
  id: string;
  project: string;
  cwd: string;
}

type CardFailure = NonNullable<SecretRequestCard['failure']>;

interface RequestCard {
  session: NeedingSession;
  names: string[];
  reason: string | null;
  phase: 'asking' | 'reading' | 'failed';
  readingName: string | null;
  failure: CardFailure | null;
}

interface Delivery {
  statusByName: Record<string, NeedStatus>;
  noteByName: Record<string, string>;
  envFile: string | null;
}

interface DeliveredName {
  cwd: string;
  envFile: string;
}

interface SecretsBrokerOptions {
  readSecrets: () => unknown;
  writeSecrets: (mutate: (rawSecrets: unknown) => Record<string, unknown> | null) => Promise<boolean>;
  currentSource: () => SecretSource | null;
  readSecret: (source: SecretSource, name: string) => Promise<ReadOutcome>;
  writeEnvFile?: (directory: string, valuesByName: Readonly<Record<string, string>>) => Promise<EnvFileWrite>;
  readEnvValues?: (directory: string) => Promise<Readonly<Record<string, string>>>;
  writtenNames?: { remember(directory: string, names: readonly string[]): Promise<void>; namesIn(directory: string): Promise<readonly string[]> };
  now?: () => number;
  telemetry?: Pick<Telemetry, 'capture'> | null;
}

function deliveredNote(envFile: string): string {
  return `written to ${envFile}; load it, do not read it (your framework's env loading, or node --env-file=${envFile})`;
}

const NOTE_BY_STATUS: Readonly<Record<NeedStatus, string>> = Object.freeze({
  delivered: deliveredNote('the env file'),
  pending: "waiting on the operator's approval card in Glimmervoid; ask again later or pass --wait",
  denied: 'the operator denied it; do not ask again today',
  'no-source': "no password manager is chosen in Glimmervoid yet; the operator was asked to pick one on this session's card, so ask again later",
  failed: 'the password manager could not read it',
});

const READER_CRASHED_MESSAGE = 'Glimmervoid could not run its password manager reader';

function writtenSummary(deliveredNames: readonly string[]): string {
  if (deliveredNames.length === 0) return 'Nothing was written.';
  return `${deliveredNames.join(', ')} ${deliveredNames.length === 1 ? 'was' : 'were'} written to the env file; the rest were not.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSecretsBroker({ readSecrets, writeSecrets, currentSource, readSecret, writeEnvFile = async () => ({ ok: false, reason: 'no env file writer' }), readEnvValues = async () => ({}), writtenNames = { remember: async () => undefined, namesIn: async () => [] }, now = clock.nowMs, telemetry = null }: SecretsBrokerOptions) {
  const events = new EventEmitter();
  const deniedUntilMsByProject = new Map<string, Record<string, number>>();
  const cardsBySession = new Map<string, RequestCard>();
  const decidingSessionIds = new Set<string>();
  const allowedOnceNamesBySession = new Map<string, Set<string>>();
  const deliveriesBySession = new Map<string, Map<string, DeliveredName>>();
  const deliveredValuesBySession = new Map<string, Set<string>>();

  function deliveredNamesFor(session: NeedingSession): Map<string, string> {
    const deliveries = deliveriesBySession.get(session.id) ?? new Map<string, DeliveredName>();
    return new Map([...deliveries].filter(([, delivery]) => delivery.cwd === session.cwd).map(([name, delivery]) => [name, delivery.envFile]));
  }

  function projectState(session: NeedingSession, hasSource: boolean): ProjectSecretState {
    return {
      approvals: approvalsOf(readSecrets(), session.project),
      deniedUntilMs: deniedUntilMsByProject.get(session.project) ?? {},
      allowedOnceNames: allowedOnceNamesBySession.get(session.id) ?? new Set(),
      deliveredNames: new Set(deliveredNamesFor(session).keys()),
      hasSource,
    };
  }

  function cardView(card: RequestCard): SecretRequestCard {
    const source = currentSource();
    const phase = card.phase === 'asking' && source === null ? 'needs-source' : card.phase;
    return { names: [...card.names], reason: card.reason, phase, readingName: card.readingName, from: source === null ? null : sourceLabel(source), failure: card.failure };
  }

  function emitCard(sessionId: string, newNames: readonly string[]): void {
    const card = cardsBySession.get(sessionId);
    events.emit('card-changed', { sessionId, card: card ? cardView(card) : null, newNames });
  }

  function raiseCard(session: NeedingSession, names: readonly string[], reason: string | null): void {
    const card = cardsBySession.get(session.id) ?? { session, names: [], reason: null, phase: 'asking', readingName: null, failure: null };
    const newNames = names.filter((name) => !card.names.includes(name));
    const isReasonNew = reason !== null && reason !== card.reason;
    if (newNames.length === 0 && !isReasonNew) return;
    card.names = [...card.names, ...newNames];
    card.reason = reason ?? card.reason;
    cardsBySession.set(session.id, card);
    emitCard(session.id, newNames);
  }

  function closeCard(sessionId: string): void {
    if (!cardsBySession.delete(sessionId)) return;
    emitCard(sessionId, []);
  }

  function addDeliveredValues(sessionId: string, values: readonly string[]): void {
    deliveredValuesBySession.set(sessionId, new Set([...deliveredValuesOf(sessionId), ...values]));
    events.emit('delivered', sessionId);
  }

  function rememberDelivery(session: NeedingSession, envFile: string, valuesByName: Readonly<Record<string, string>>): void {
    const deliveries = deliveriesBySession.get(session.id) ?? new Map<string, DeliveredName>();
    for (const name of Object.keys(valuesByName)) deliveries.set(name, { cwd: session.cwd, envFile });
    deliveriesBySession.set(session.id, deliveries);
    addDeliveredValues(session.id, Object.values(valuesByName));
  }

  async function seedMasks(session: NeedingSession): Promise<string | null> {
    const approvedNames = Object.entries(approvalsOf(readSecrets(), session.project)).filter(([, approval]) => approval.isAllowed).map(([name]) => name);
    try {
      const maskedNames = new Set([...approvedNames, ...await writtenNames.namesIn(session.cwd)]);
      if (maskedNames.size === 0) return null;
      const envValues = await readEnvValues(session.cwd);
      const maskedValues = [...maskedNames].map((name) => envValues[name] ?? '').filter((value) => value !== '');
      if (maskedValues.length > 0) addDeliveredValues(session.id, maskedValues);
      return null;
    } catch (error) {
      return `could not read the env file of session ${session.id} to mask its secrets: ${errorText(error)}`;
    }
  }

  function startReading(session: NeedingSession, names: readonly string[]): RequestCard {
    const card = cardsBySession.get(session.id) ?? { session, names: [], reason: null, phase: 'reading', readingName: null, failure: null };
    card.names = [...names, ...card.names.filter((name) => !names.includes(name))];
    card.phase = 'reading';
    card.failure = null;
    cardsBySession.set(session.id, card);
    return card;
  }

  function showReading(card: RequestCard, name: string): void {
    card.readingName = name;
    emitCard(card.session.id, []);
  }

  function finishReading(card: RequestCard, deliveredNames: readonly string[], failure: CardFailure | null): void {
    if (cardsBySession.get(card.session.id) !== card) return;
    card.names = card.names.filter((name) => !deliveredNames.includes(name));
    card.readingName = null;
    card.failure = failure;
    card.phase = failure === null ? 'asking' : 'failed';
    if (card.names.length === 0) {
      closeCard(card.session.id);
      return;
    }
    emitCard(card.session.id, []);
  }

  async function readValuesInOrder(card: RequestCard, source: SecretSource, names: readonly string[]): Promise<{ valuesByName: Record<string, string>; failedName: string | null; failure: CardFailure | null }> {
    const valuesByName: Record<string, string> = {};
    for (const name of names) {
      showReading(card, name);
      const outcome = await readSecret(source, name).catch((error: unknown): ReadOutcome => ({ failure: { kind: 'unavailable', message: READER_CRASHED_MESSAGE, detail: errorText(error) } }));
      if ('failure' in outcome) return { valuesByName, failedName: name, failure: { message: outcome.failure.message, detail: outcome.failure.detail } };
      if (unwritableEnvNames({ [name]: outcome.value }).length > 0) return { valuesByName, failedName: name, failure: { message: `${name} holds every kind of quote, so no env file reader would get it back unchanged`, detail: '' } };
      valuesByName[name] = outcome.value;
    }
    return { valuesByName, failedName: null, failure: null };
  }

  async function readAndDeliver(session: NeedingSession, names: readonly string[]): Promise<Delivery> {
    const source = currentSource();
    if (source === null) return { statusByName: Object.fromEntries(names.map((name) => [name, 'no-source'])), noteByName: {}, envFile: null };
    const card = startReading(session, names);
    const read = await readValuesInOrder(card, source, names);
    const readNames = Object.keys(read.valuesByName);
    const written = readNames.length === 0 ? null : await writeEnvFile(session.cwd, read.valuesByName);
    const writeFailure = written !== null && !written.ok ? { message: written.reason, detail: '' } : null;
    const deliveredNames = written?.ok ? readNames : [];
    if (written?.ok) await writtenNames.remember(session.cwd, readNames);
    if (written?.ok && cardsBySession.get(session.id) === card) rememberDelivery(session, written.envFile, read.valuesByName);
    const failure = writeFailure ?? read.failure;
    finishReading(card, deliveredNames, failure === null ? null : { ...failure, message: `${failure.message}. ${writtenSummary(deliveredNames)}` });
    const failedNames = writeFailure ? readNames : [read.failedName].filter((name) => name !== null);
    const statusByName: Record<string, NeedStatus> = {};
    const noteByName: Record<string, string> = {};
    for (const name of names) {
      statusByName[name] = deliveredNames.includes(name) ? 'delivered' : failedNames.includes(name) ? 'failed' : 'pending';
      if (statusByName[name] === 'delivered' && written?.ok) noteByName[name] = deliveredNote(written.envFile);
      if (statusByName[name] === 'failed' && failure !== null) noteByName[name] = `the password manager could not read it: ${failure.message}`;
    }
    return { statusByName, noteByName, envFile: written?.ok ? written.envFile : null };
  }

  function readOnDecision(session: NeedingSession, names: readonly string[]): void {
    void readAndDeliver(session, names).catch((error: unknown) => {
      const card = cardsBySession.get(session.id);
      if (card) finishReading(card, [], { message: READER_CRASHED_MESSAGE, detail: errorText(error) });
    });
  }

  async function need(session: NeedingSession, names: readonly string[], reason: string | null = null): Promise<AgentNeedReply> {
    const decision = decideNeed(projectState(session, currentSource() !== null), names, now());
    raiseCard(session, [...decision.namesNeedingSource, ...decision.namesNeedingCard], reason);
    const delivered = deliveredNamesFor(session);
    const notes: Record<string, string> = Object.fromEntries([...delivered].filter(([name]) => decision.statusByName[name] === 'delivered').map(([name, envFile]) => [name, deliveredNote(envFile)]));
    const isAlreadyReading = cardsBySession.get(session.id)?.phase === 'reading';
    const reading = decision.namesToRead.length === 0 || isAlreadyReading ? null : await readAndDeliver(session, decision.namesToRead);
    const results = Object.entries(decision.statusByName).map(([name, decidedStatus]) => {
      const status = reading?.statusByName[name] ?? decidedStatus;
      return { name, status, note: reading?.noteByName[name] ?? notes[name] ?? NOTE_BY_STATUS[status] };
    });
    reportAnswer(results.map((result) => result.status));
    const envFile = reading?.envFile ?? [...delivered.values()][0] ?? null;
    return { ok: true, results, envFile: results.some((result) => result.status === 'delivered') ? envFile : null };
  }

  function reportAnswer(statuses: readonly NeedStatus[]): void {
    const countOf = (status: NeedStatus) => statuses.filter((answeredStatus) => answeredStatus === status).length;
    telemetry?.capture('vault_secret_answered', {
      delivered_count: countOf('delivered'),
      pending_count: countOf('pending'),
      denied_count: countOf('denied'),
      no_source_count: countOf('no-source'),
      failed_count: countOf('failed'),
    });
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

  function allowOnce(sessionId: string, names: readonly string[]): void {
    allowedOnceNamesBySession.set(sessionId, new Set([...(allowedOnceNamesBySession.get(sessionId) ?? []), ...names]));
  }

  async function allowAlways(project: string, names: readonly string[]): Promise<string | null> {
    const isSaved = await writeSecrets((rawSecrets) => withAllowedNames(rawSecrets, project, names));
    if (!isSaved) return 'Glimmervoid could not save the approval to config.json.';
    events.emit('approvals-changed');
    return null;
  }

  function withoutCardNames(card: RequestCard, names: readonly string[]): void {
    card.names = card.names.filter((name) => !names.includes(name));
    if (card.names.length === 0) {
      closeCard(card.session.id);
      return;
    }
    emitCard(card.session.id, []);
  }

  async function decide({ id, choice, names: shownNames }: SecretDecision): Promise<string | null> {
    const card = cardsBySession.get(id);
    if (!card) return 'This secret request was already answered.';
    if (card.phase === 'reading' || decidingSessionIds.has(id)) return 'This secret request is already being read.';
    const names = card.names.filter((name) => shownNames.includes(name));
    if (names.length === 0) return 'This secret request changed. Look at the card again.';
    const { session } = card;
    if (choice === 'deny') {
      holdDenial(session.project, names);
      withoutCardNames(card, names);
      return null;
    }
    if (currentSource() === null) return 'Choose the vault Glimmervoid reads secrets from first: set vault.lookIn in config.json.';
    decidingSessionIds.add(id);
    try {
      if (choice === 'allow-once') allowOnce(id, names);
      const refusal = choice === 'allow-always' ? await allowAlways(session.project, names) : null;
      if (refusal !== null) return refusal;
      releaseDenial(session.project, names);
      readOnDecision(session, names);
      return null;
    } finally {
      decidingSessionIds.delete(id);
    }
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

  function requestsSnapshot(): Record<string, SecretRequestCard> {
    return Object.fromEntries([...cardsBySession].map(([sessionId, card]) => [sessionId, cardView(card)]));
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
    allowedOnceNamesBySession.delete(sessionId);
    closeCard(sessionId);
  }

  return { events, need, decide, revoke, requestsSnapshot, approvalRows, forgetSession, refreshCards, deliveredValuesOf, seedMasks };
}

type SecretsBroker = ReturnType<typeof createSecretsBroker>;

export { createSecretsBroker };
export type { SecretsBroker };
