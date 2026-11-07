import { EventEmitter } from 'node:events';

import { SecretApproval, SecretName, SecretsConfig } from '../../shared/contracts/secrets.ts';
import type { AgentNeedReply, NeedResult, NeedStatus } from '../../shared/contracts/secrets.ts';
import { decideNeed } from './core/secrets-broker-core.ts';
import type { ProjectSecretState } from './core/secrets-broker-core.ts';

interface NeedingSession {
  id: string;
  project: string;
}

interface SecretRequestEvent {
  sessionId: string;
  project: string;
  names: string[];
}

interface SecretsBrokerOptions {
  readConfig: () => unknown;
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

function createSecretsBroker({ readConfig, isCompanionOnline = () => false, now = Date.now }: SecretsBrokerOptions) {
  const events = new EventEmitter();
  const deniedUntilMsByProject = new Map<string, Record<string, number>>();
  const cardNamesBySession = new Map<string, Set<string>>();

  function projectApprovals(project: string): Record<string, SecretApproval> {
    const parsed = SecretsConfig.safeParse(readConfig() ?? {});
    if (!parsed.success) return {};
    const approvals: Record<string, SecretApproval> = {};
    for (const [name, entry] of Object.entries(parsed.data.byProject[project] ?? {})) {
      const approval = SecretApproval.safeParse(entry);
      if (SecretName.safeParse(name).success && approval.success) approvals[name] = approval.data;
    }
    return approvals;
  }

  function projectState(project: string): ProjectSecretState {
    return { approvals: projectApprovals(project), deniedUntilMs: deniedUntilMsByProject.get(project) ?? {} };
  }

  function raiseCard(session: NeedingSession, names: readonly string[]): void {
    const shownNames = cardNamesBySession.get(session.id) ?? new Set<string>();
    const newNames = names.filter((name) => !shownNames.has(name));
    for (const name of newNames) shownNames.add(name);
    cardNamesBySession.set(session.id, shownNames);
    if (newNames.length === 0) return;
    const request: SecretRequestEvent = { sessionId: session.id, project: session.project, names: newNames };
    events.emit('request', request);
  }

  function need(session: NeedingSession, names: readonly string[]): AgentNeedReply {
    const decision = decideNeed(projectState(session.project), names, isCompanionOnline(), now());
    raiseCard(session, decision.namesNeedingCard);
    const results: NeedResult[] = Object.entries(decision.statusByName).map(([name, status]) => ({ name, status, note: NOTE_BY_STATUS[status] }));
    return { ok: true, results, envFile: null };
  }

  return { events, need };
}

type SecretsBroker = ReturnType<typeof createSecretsBroker>;

export { createSecretsBroker };
export type { NeedingSession, SecretRequestEvent, SecretsBroker };
