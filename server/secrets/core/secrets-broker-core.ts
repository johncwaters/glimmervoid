import { SecretApproval, SecretName } from '../../../shared/contracts/secrets.ts';
import type { NeedStatus, ProjectApprovals } from '../../../shared/contracts/secrets.ts';

const DENIAL_HOLD_MS = 24 * 60 * 60 * 1000;

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretsRecordOf(rawSecrets: unknown): Record<string, unknown> | null {
  if (rawSecrets === undefined || rawSecrets === null) return {};
  return isPlainRecord(rawSecrets) ? rawSecrets : null;
}

function byProjectOf(rawSecrets: unknown): Record<string, unknown> | null {
  const byProject = secretsRecordOf(rawSecrets)?.byProject ?? {};
  return isPlainRecord(byProject) ? byProject : null;
}

function projectEntriesOf(rawSecrets: unknown, project: string): Record<string, unknown> {
  const entries = byProjectOf(rawSecrets)?.[project];
  return isPlainRecord(entries) ? entries : {};
}

function approvalsOf(rawSecrets: unknown, project: string): Record<string, SecretApproval> {
  const approvals: Record<string, SecretApproval> = {};
  for (const [name, entry] of Object.entries(projectEntriesOf(rawSecrets, project))) {
    const approval = SecretApproval.safeParse(entry);
    if (SecretName.safeParse(name).success && approval.success) approvals[name] = approval.data;
  }
  return approvals;
}

function approvalRowsOf(rawSecrets: unknown): ProjectApprovals[] {
  return Object.keys(byProjectOf(rawSecrets) ?? {}).sort().map((project) => ({
    project,
    approvals: Object.entries(approvalsOf(rawSecrets, project))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, approval]) => ({ name, reference: approval.reference, isAllowed: approval.isAllowed })),
  })).filter((row) => row.approvals.length > 0);
}

function packLinksOf(rawSecrets: unknown): Record<string, string> {
  const links = secretsRecordOf(rawSecrets)?.packs;
  if (!isPlainRecord(links)) return {};
  const referenceByName: Record<string, string> = {};
  for (const [name, entry] of Object.entries(links)) {
    const approval = SecretApproval.safeParse(entry);
    if (SecretName.safeParse(name).success && approval.success && approval.data.reference !== null) referenceByName[name] = approval.data.reference;
  }
  return referenceByName;
}

function withPackLink(rawSecrets: unknown, name: string, reference: string): Record<string, unknown> | null {
  const secretsRecord = secretsRecordOf(rawSecrets);
  if (!secretsRecord) return null;
  const links = isPlainRecord(secretsRecord.packs) ? secretsRecord.packs : {};
  const { [name]: _replaced, ...otherLinks } = links;
  const nextLinks = reference === '' ? otherLinks : { ...otherLinks, [name]: { reference, isAllowed: true } };
  return { ...secretsRecord, packs: nextLinks };
}

function withProjectEntries(rawSecrets: unknown, project: string, entries: Record<string, unknown>): Record<string, unknown> | null {
  const secretsRecord = secretsRecordOf(rawSecrets);
  const byProject = byProjectOf(rawSecrets);
  if (!secretsRecord || !byProject) return null;
  const { [project]: _replaced, ...otherProjects } = byProject;
  const nextByProject = Object.keys(entries).length === 0 ? otherProjects : { ...otherProjects, [project]: entries };
  return { ...secretsRecord, byProject: nextByProject };
}

function withApprovals(rawSecrets: unknown, project: string, referenceByName: Readonly<Record<string, string>>): Record<string, unknown> | null {
  const entries = { ...projectEntriesOf(rawSecrets, project) };
  for (const [name, reference] of Object.entries(referenceByName)) entries[name] = { reference, isAllowed: true };
  return withProjectEntries(rawSecrets, project, entries);
}

function withoutApprovals(rawSecrets: unknown, project: string, names: readonly string[]): Record<string, unknown> | null {
  const remaining = Object.fromEntries(Object.entries(projectEntriesOf(rawSecrets, project)).filter(([name]) => !names.includes(name)));
  return withProjectEntries(rawSecrets, project, remaining);
}

function namesStillSavedAt(rawSecrets: unknown, project: string, referenceByName: Readonly<Record<string, string>>): string[] {
  const approvals = approvalsOf(rawSecrets, project);
  return Object.entries(referenceByName).filter(([name, reference]) => approvals[name]?.reference === reference).map(([name]) => name);
}

function withoutApproval(rawSecrets: unknown, project: string, name: string): Record<string, unknown> | null {
  return withoutApprovals(rawSecrets, project, [name]);
}

function missingReferenceNames(names: readonly string[], referenceByName: Readonly<Record<string, string>>): string[] {
  return names.filter((name) => !referenceByName[name]);
}

function denialEndsAtMs(nowMs: number): number {
  return nowMs + DENIAL_HOLD_MS;
}

export { approvalRowsOf, approvalsOf, packLinksOf, withPackLink, decideNeed, denialEndsAtMs, missingReferenceNames, namesStillSavedAt, needExitCode, withApprovals, withoutApproval, withoutApprovals };
export type { ProjectSecretState };
