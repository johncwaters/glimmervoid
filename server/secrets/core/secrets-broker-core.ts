import type { NeedStatus, SecretApproval } from '../../../shared/contracts/secrets.ts';

interface ProjectSecretState {
  approvals: Readonly<Record<string, SecretApproval>>;
  deniedUntilMs: Readonly<Record<string, number>>;
}

interface NeedDecision {
  statusByName: Record<string, NeedStatus>;
  namesToRead: string[];
  namesNeedingCard: string[];
}

type NeedExitCode = 0 | 10 | 20 | 30 | 1;

const EXIT_CODE_BY_STATUS: Readonly<Record<NeedStatus, NeedExitCode>> = Object.freeze({
  delivered: 0,
  pending: 10,
  denied: 20,
  'companion-offline': 30,
  failed: 1,
});

const STATUS_SEVERITY: readonly NeedStatus[] = ['failed', 'companion-offline', 'denied', 'pending', 'delivered'];

function isDenied(state: ProjectSecretState, name: string, nowMs: number): boolean {
  if (state.approvals[name]?.isAllowed === false) return true;
  return (state.deniedUntilMs[name] ?? 0) > nowMs;
}

function statusOfName(state: ProjectSecretState, name: string, isCompanionOnline: boolean, nowMs: number): NeedStatus | 'read' | 'card' {
  if (isDenied(state, name, nowMs)) return 'denied';
  const approval = state.approvals[name];
  if (!approval?.isAllowed || approval.reference === null) return 'card';
  if (!isCompanionOnline) return 'companion-offline';
  return 'read';
}

function decideNeed(state: ProjectSecretState, names: readonly string[], isCompanionOnline: boolean, nowMs: number): NeedDecision {
  const decision: NeedDecision = { statusByName: {}, namesToRead: [], namesNeedingCard: [] };
  for (const name of new Set(names)) {
    const outcome = statusOfName(state, name, isCompanionOnline, nowMs);
    decision.statusByName[name] = outcome === 'read' || outcome === 'card' ? 'pending' : outcome;
    if (outcome === 'read') decision.namesToRead.push(name);
    if (outcome === 'card') decision.namesNeedingCard.push(name);
  }
  return decision;
}

function needExitCode(statusByName: Readonly<Record<string, NeedStatus>>): NeedExitCode {
  const statuses = new Set(Object.values(statusByName));
  const worstStatus = STATUS_SEVERITY.find((status) => statuses.has(status)) ?? 'delivered';
  return EXIT_CODE_BY_STATUS[worstStatus];
}

export { decideNeed, needExitCode };
export type { NeedDecision, NeedExitCode, ProjectSecretState };
