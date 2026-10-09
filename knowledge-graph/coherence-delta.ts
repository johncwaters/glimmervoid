export type CoherenceRecordKind = 'work' | 'decision';

export type WorkOrderSummary = {
  id: string;
  objective: string;
  state: string;
  readiness: string;
  lastEventAt: string | null;
};

export type DecisionSummary = {
  id: string;
  chose: string;
  because: string;
  at: string;
  workId: string | null;
  isRetracted: boolean;
};

export type RepoSnapshot =
  | { isAvailable: true; heading: string; headingReasons: string[]; workOrders: WorkOrderSummary[]; unverifiedCompletedWorkIds: string[]; decisions: DecisionSummary[] }
  | { isAvailable: false; reason: string };

export type TrackedRecord = {
  trackingNodeId: string;
  trackingKind: string;
  trackingStatus: string | undefined;
  recordNodeId: string;
  repo: string;
  record: CoherenceRecordKind;
  recordId: string;
};

export type FindingKind = 'missing' | 'unverified' | 'status-diverges' | 'retracted' | 'moved-since';

export type TrackedRecordReport = {
  tracked: TrackedRecord;
  label: string;
  state: string;
  findings: { kind: FindingKind; detail: string }[];
  decisions: DecisionSummary[];
};

export type RepoReport =
  | { repo: string; isAvailable: true; heading: string; headingReasons: string[]; records: TrackedRecordReport[] }
  | { repo: string; isAvailable: false; reason: string; records: TrackedRecord[] };

const openWorkStates = new Set(['open', 'active', 'blocked']);
const closedTaskStatuses = new Set(['done', 'dropped']);
const openTaskStatuses = new Set(['todo', 'doing', 'waiting']);

export function inferRecordKind(recordId: string): CoherenceRecordKind | null {
  if (/^wrk-[0-9a-f]{16}$/.test(recordId)) return 'work';
  if (/^d-[0-9a-f]{8,}$/.test(recordId)) return 'decision';
  return null;
}

function findStatusDivergence(trackingStatus: string | undefined, workState: string): string | null {
  if (trackingStatus === undefined) return null;
  if (closedTaskStatuses.has(trackingStatus) && openWorkStates.has(workState)) {
    return `kg says ${trackingStatus}, ledger says ${workState}`;
  }
  if (openTaskStatuses.has(trackingStatus) && workState === 'completed') {
    return `ledger says completed, kg still ${trackingStatus}`;
  }
  if (trackingStatus !== 'dropped' && workState === 'cancelled') {
    return `ledger says cancelled, kg still ${trackingStatus}`;
  }
  return null;
}

function isAfter(timestamp: string | null, since: string | undefined): boolean {
  return since !== undefined && timestamp !== null && timestamp > since;
}

function reportWorkRecord(tracked: TrackedRecord, snapshot: Extract<RepoSnapshot, { isAvailable: true }>, since: string | undefined): TrackedRecordReport {
  const workOrder = snapshot.workOrders.find((candidate) => candidate.id === tracked.recordId);
  if (!workOrder) {
    return { tracked, label: tracked.recordId, state: 'missing', findings: [{ kind: 'missing', detail: 'not in this repo\'s work ledger' }], decisions: [] };
  }
  const findings: TrackedRecordReport['findings'] = [];
  if (snapshot.unverifiedCompletedWorkIds.includes(workOrder.id)) {
    findings.push({ kind: 'unverified', detail: 'completed with no verification on record' });
  }
  const divergence = tracked.trackingKind === 'task' ? findStatusDivergence(tracked.trackingStatus, workOrder.state) : null;
  if (divergence) findings.push({ kind: 'status-diverges', detail: divergence });
  if (isAfter(workOrder.lastEventAt, since)) findings.push({ kind: 'moved-since', detail: `last event ${workOrder.lastEventAt}` });
  const decisions = snapshot.decisions.filter((decision) => decision.workId === workOrder.id && (since === undefined || decision.at > since));
  return { tracked, label: workOrder.objective, state: `${workOrder.state}/${workOrder.readiness}`, findings, decisions };
}

function reportDecisionRecord(tracked: TrackedRecord, snapshot: Extract<RepoSnapshot, { isAvailable: true }>): TrackedRecordReport {
  const decision = snapshot.decisions.find((candidate) => candidate.id === tracked.recordId);
  if (!decision) {
    return { tracked, label: tracked.recordId, state: 'missing', findings: [{ kind: 'missing', detail: 'not in this repo\'s decision journal' }], decisions: [] };
  }
  const findings: TrackedRecordReport['findings'] = decision.isRetracted ? [{ kind: 'retracted', detail: 'withdrawn in the journal; kg notes relying on it need a look' }] : [];
  return { tracked, label: decision.chose, state: decision.isRetracted ? 'retracted' : 'standing', findings, decisions: [] };
}

export function buildCoherenceDelta(trackedRecords: readonly TrackedRecord[], snapshotsByRepo: ReadonlyMap<string, RepoSnapshot>, since?: string): RepoReport[] {
  const repos = [...new Set(trackedRecords.map((tracked) => tracked.repo))].toSorted();
  return repos.map((repo): RepoReport => {
    const repoRecords = trackedRecords.filter((tracked) => tracked.repo === repo);
    const snapshot = snapshotsByRepo.get(repo) ?? { isAvailable: false, reason: 'not read' };
    if (!snapshot.isAvailable) return { repo, isAvailable: false, reason: snapshot.reason, records: repoRecords };
    const records = repoRecords.map((tracked) =>
      tracked.record === 'work' ? reportWorkRecord(tracked, snapshot, since) : reportDecisionRecord(tracked, snapshot));
    return { repo, isAvailable: true, heading: snapshot.heading, headingReasons: snapshot.headingReasons, records };
  });
}
