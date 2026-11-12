import { SECRET_MANAGER_LABELS, SecretApproval, SecretName } from '../../../shared/contracts/secrets.ts';
import type { NeedStatus, ProjectApprovals, SecretSource } from '../../../shared/contracts/secrets.ts';

const DENIAL_HOLD_MS = 24 * 60 * 60 * 1000;

interface ProjectSecretState {
  approvals: Readonly<Record<string, SecretApproval>>;
  deniedUntilMs: Readonly<Record<string, number>>;
  allowedOnceNames: ReadonlySet<string>;
  deliveredNames: ReadonlySet<string>;
  hasSource: boolean;
}

interface NeedDecision {
  statusByName: Record<string, NeedStatus>;
  namesToRead: string[];
  namesNeedingCard: string[];
  namesNeedingSource: string[];
}

type NeedExitCode = 0 | 10 | 20 | 30 | 1;

const EXIT_CODE_BY_STATUS: Readonly<Record<NeedStatus, NeedExitCode>> = Object.freeze({
  delivered: 0,
  pending: 10,
  denied: 20,
  'no-source': 30,
  failed: 1,
});

const STATUS_SEVERITY: readonly NeedStatus[] = ['failed', 'no-source', 'denied', 'pending', 'delivered'];

type NameOutcome = 'delivered' | 'denied' | 'no-source' | 'read' | 'card';

function outcomeOfName(state: ProjectSecretState, name: string, nowMs: number): NameOutcome {
  if (state.deliveredNames.has(name)) return 'delivered';
  if (state.approvals[name]?.isAllowed === false || (state.deniedUntilMs[name] ?? 0) > nowMs) return 'denied';
  if (!state.hasSource) return 'no-source';
  if (state.approvals[name]?.isAllowed || state.allowedOnceNames.has(name)) return 'read';
  return 'card';
}

const STATUS_BY_OUTCOME: Readonly<Record<NameOutcome, NeedStatus>> = Object.freeze({
  delivered: 'delivered',
  denied: 'denied',
  'no-source': 'no-source',
  read: 'pending',
  card: 'pending',
});

function decideNeed(state: ProjectSecretState, names: readonly string[], nowMs: number): NeedDecision {
  const decision: NeedDecision = { statusByName: {}, namesToRead: [], namesNeedingCard: [], namesNeedingSource: [] };
  for (const name of new Set(names)) {
    const outcome = outcomeOfName(state, name, nowMs);
    decision.statusByName[name] = STATUS_BY_OUTCOME[outcome];
    if (outcome === 'read') decision.namesToRead.push(name);
    if (outcome === 'card') decision.namesNeedingCard.push(name);
    if (outcome === 'no-source') decision.namesNeedingSource.push(name);
  }
  return decision;
}

function needExitCode(statusByName: Readonly<Record<string, NeedStatus>>): NeedExitCode {
  const statuses = new Set(Object.values(statusByName));
  const worstStatus = STATUS_SEVERITY.find((status) => statuses.has(status)) ?? 'delivered';
  return EXIT_CODE_BY_STATUS[worstStatus];
}

function sourceLabel(source: SecretSource): string {
  return `${SECRET_MANAGER_LABELS[source.manager]}, vault ${source.lookIn}`;
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
      .map(([name, approval]) => ({ name, isAllowed: approval.isAllowed })),
  })).filter((row) => row.approvals.length > 0);
}

function withProjectEntries(rawSecrets: unknown, project: string, entries: Record<string, unknown>): Record<string, unknown> | null {
  const secretsRecord = secretsRecordOf(rawSecrets);
  const byProject = byProjectOf(rawSecrets);
  if (!secretsRecord || !byProject) return null;
  const { [project]: _replaced, ...otherProjects } = byProject;
  const nextByProject = Object.keys(entries).length === 0 ? otherProjects : { ...otherProjects, [project]: entries };
  return { ...secretsRecord, byProject: nextByProject };
}

function withAllowedNames(rawSecrets: unknown, project: string, names: readonly string[]): Record<string, unknown> | null {
  const entries = { ...projectEntriesOf(rawSecrets, project) };
  for (const name of names) entries[name] = { isAllowed: true };
  return withProjectEntries(rawSecrets, project, entries);
}

function withoutApproval(rawSecrets: unknown, project: string, name: string): Record<string, unknown> | null {
  const remaining = Object.fromEntries(Object.entries(projectEntriesOf(rawSecrets, project)).filter(([savedName]) => savedName !== name));
  return withProjectEntries(rawSecrets, project, remaining);
}

function denialEndsAtMs(nowMs: number): number {
  return nowMs + DENIAL_HOLD_MS;
}

export { approvalRowsOf, approvalsOf, decideNeed, denialEndsAtMs, needExitCode, sourceLabel, withAllowedNames, withoutApproval };
export type { ProjectSecretState };
