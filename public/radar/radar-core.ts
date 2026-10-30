import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { clockDurationText } from '#shared/display-text.ts';
import { numberOr, textOr } from '#shared/coerce.ts';
import { shortSha } from '#shared/git-text.ts';

import { attentionSignature } from '../attention-ack-core.ts';
import { lanePlaceholder } from '../lane-placeholder-core.ts';

export interface RadarIssue {
  issueId?: unknown;
  title?: unknown;
  change?: string;
  verdict?: string;
  users?: unknown;
  occurrences?: unknown;
  history?: unknown;
  summaryLine?: unknown;
  inFlight?: unknown;
  startedAt?: unknown;
  trail?: unknown;
  url?: unknown;
  lastSeen?: unknown;
  status?: unknown;
}

interface TrailToolRow {
  at: number;
  tool: string;
  detail: string;
}

interface TrailNoteRow {
  at: number;
  note: string;
}

type TrailStepRow = TrailToolRow | TrailNoteRow;

type TrailTimelineRow =
  | { kind: 'note'; at: number; text: string }
  | { kind: 'work'; at: number; stepCount: number };

type InvestigationActivityFrame = Partial<Pick<ServerMessageOf<'radar-investigation-activity'>, 'projectId' | 'issueId' | 'inFlight' | 'startedAt' | 'trail'>>;

export type InvestigationFinishedFrame = Partial<Pick<ServerMessageOf<'radar-investigation-finished'>, 'projectId' | 'issueId' | 'startedAt' | 'trail' | 'verdict' | 'summaryLine'>>;

export interface InvestigationView {
  inFlight: boolean;
  startedAt: number | null;
  steps: TrailStepRow[];
  verdict: string;
  summaryLine: string;
}

export interface RadarProject {
  projectId?: unknown;
  name?: unknown;
  host?: unknown;
  error?: unknown;
  lastTickAt?: unknown;
  issues?: RadarIssue[];
  dailyVolumeByIssueId?: unknown;
}

interface RadarInvestigation {
  id?: unknown;
  issueId?: unknown;
  projectId?: unknown;
  projectName?: unknown;
  title?: unknown;
  summaryLine?: unknown;
  url?: unknown;
  verdict?: unknown;
  mode?: unknown;
  prUrl?: unknown;
  pendingFix?: unknown;
  at?: unknown;
  archived?: unknown;
}

function pendingFixOf(value: unknown): { branch: string; agentPrTitle: string; expiresAt: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const fix = value as Record<string, unknown>;
  const branch = textOr(fix.branch, '');
  if (!branch) return null;
  return { branch, agentPrTitle: textOr(fix.agentPrTitle, ''), expiresAt: Number.isFinite(Number(fix.expiresAt)) ? Number(fix.expiresAt) : 0 };
}

export interface RadarSnapshot {
  type?: string;
  ts?: number;
  projects?: RadarProject[];
  investigations?: unknown[];
  configured?: boolean;
  reason?: unknown;
  intervalMs?: unknown;
  intervalMinutes?: unknown;
}

type RadarLoadPhase = 'pending' | 'placeholder' | 'ready';

interface RadarUpdateFeed {
  updateAvailable?: unknown;
  command?: unknown;
  current?: unknown;
  latest?: unknown;
  currentSha?: unknown;
  latestSha?: unknown;
  [key: string]: unknown;
}

interface RadarProjectAlert {
  loud: boolean;
  counts: { active: number; spiking: number; needsHuman: number };
  error: string;
  staleMs: number;
}

export const UPDATES_SECTION_ID = 'machine-updates';
export const UPDATES_ACTIONS_SETTING_ID = 'update-actions';

const CHANGE_RANK: Record<string, number> = {
  spiking: 0,
  regressed: 1,
  worsened: 2,
  new: 3,
  quiet: 4,
};

const UNKNOWN_RANK = 99;

const VERDICT_LABEL: Record<string, string> = {
  ROOT_CAUSE: 'root cause',
  NEEDS_HUMAN: 'needs you',
  TRANSIENT: 'transient',
  FIXED: 'fixed',
  ERROR: 'error',
};

function trailStepRows(trail: unknown): TrailStepRow[] {
  if (!Array.isArray(trail)) return [];
  return (trail as unknown[]).flatMap((entry): TrailStepRow[] => {
    const record = entry as { at?: unknown; tool?: unknown; detail?: unknown; note?: unknown } | null | undefined;
    const at = numberOr(record?.at, 0);
    const note = textOr(record?.note, '');
    if (note) return [{ at, note }];
    const tool = textOr(record?.tool, '');
    if (!tool) return [];
    return [{ at, tool, detail: textOr(record?.detail, '') }];
  });
}

function toolSteps(steps: TrailStepRow[]): TrailToolRow[] {
  return steps.filter((step): step is TrailToolRow => 'tool' in step);
}

function trailStepLabel(step: TrailToolRow) {
  if (!step.detail) return step.tool;
  return `${step.tool} ${step.detail}`;
}

function latestTrailLabel(issue: RadarIssue | null | undefined) {
  const steps = trailStepRows(issue?.trail);
  const latestNote = steps.findLast((step): step is TrailNoteRow => 'note' in step);
  if (latestNote) return latestNote.note;
  const lastTool = toolSteps(steps).at(-1);
  if (!lastTool) return '';
  return trailStepLabel(lastTool);
}

export function trailTimelineRows(steps: TrailStepRow[]): TrailTimelineRow[] {
  const rows: TrailTimelineRow[] = [];
  for (const step of steps) {
    if ('note' in step) {
      rows.push({ kind: 'note', at: step.at, text: step.note });
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === 'work') {
      previous.stepCount += 1;
      continue;
    }
    rows.push({ kind: 'work', at: step.at, stepCount: 1 });
  }
  return rows;
}

export function issueSummaryText(issue: RadarIssue | null | undefined) {
  const summaryLine = textOr(issue?.summaryLine, '');
  if (issue?.inFlight === true) return latestTrailLabel(issue) || summaryLine;
  return summaryLine;
}

export function investigationViewOf(issue: RadarIssue | null | undefined): InvestigationView {
  return {
    inFlight: issue?.inFlight === true,
    startedAt: numberOr(issue?.startedAt, null),
    steps: trailStepRows(issue?.trail),
    verdict: textOr(issue?.verdict, ''),
    summaryLine: textOr(issue?.summaryLine, ''),
  };
}

export function findIssueInSnapshot(
  snapshot: RadarSnapshot | null | undefined,
  projectId: unknown,
  issueId: unknown,
): RadarIssue | null {
  const wantedProject = String(projectId ?? '');
  const wantedIssue = String(issueId ?? '');
  if (!wantedProject || !wantedIssue) return null;
  for (const project of Array.isArray(snapshot?.projects) ? snapshot.projects : []) {
    if (String(project?.projectId ?? '') !== wantedProject) continue;
    for (const issue of Array.isArray(project.issues) ? project.issues : []) {
      if (String(issue?.issueId ?? '') === wantedIssue) return issue;
    }
  }
  return null;
}

export function applyInvestigationActivity(snapshot: RadarSnapshot | null | undefined, frame: InvestigationActivityFrame | null | undefined) {
  const issue = findIssueInSnapshot(snapshot, frame?.projectId, frame?.issueId);
  if (!issue) return false;
  issue.inFlight = true;
  issue.startedAt = numberOr(frame?.startedAt, null);
  issue.trail = trailStepRows(frame?.trail);
  return true;
}

export function finishedViewOf(frame: InvestigationFinishedFrame | null | undefined): InvestigationView {
  return {
    inFlight: false,
    startedAt: numberOr(frame?.startedAt, null),
    steps: trailStepRows(frame?.trail),
    verdict: textOr(frame?.verdict, ''),
    summaryLine: textOr(frame?.summaryLine, ''),
  };
}

export function isOpenInvestigationFrame(
  open: { projectId: string; issueId: string } | null | undefined,
  frame: { projectId?: unknown; issueId?: unknown } | null | undefined,
) {
  if (!open || !frame) return false;
  return String(frame.projectId ?? '') === open.projectId && String(frame.issueId ?? '') === open.issueId;
}

export function applyInvestigationFinished(snapshot: RadarSnapshot | null | undefined, frame: InvestigationFinishedFrame | null | undefined) {
  const issue = findIssueInSnapshot(snapshot, frame?.projectId, frame?.issueId);
  if (!issue) return false;
  const view = finishedViewOf(frame);
  issue.inFlight = false;
  issue.startedAt = view.startedAt;
  issue.trail = view.steps;
  issue.verdict = view.verdict;
  issue.summaryLine = view.summaryLine;
  return true;
}

export function verdictLabel(verdict: unknown) {
  const key = typeof verdict === 'string' ? verdict.toUpperCase() : '';
  return VERDICT_LABEL[key] || String(verdict ?? '').toLowerCase();
}

export function formatClockOffset(elapsedMs: number) {
  return clockDurationText(elapsedMs, { rounding: 'round', showsHours: false });
}

export function formatTrailOffset(startedAt: number | null, at: number) {
  if (startedAt == null) return '';
  return `+${formatClockOffset(at - startedAt)}`;
}

export function trailContentKey(view: InvestigationView) {
  const last = view.steps.at(-1);
  const lastLabel = last && 'tool' in last ? last.tool : last?.note ?? '';
  return [view.steps.length, last?.at ?? 0, lastLabel].join('::');
}

export function trailStatusText(view: InvestigationView, startedAgoText: string) {
  if (view.inFlight) {
    const toolStepCount = toolSteps(view.steps).length;
    const stepsText = `${toolStepCount} ${toolStepCount === 1 ? 'step' : 'steps'}`;
    const startedText = view.startedAt ? `started ${startedAgoText}` : 'starting';
    return `investigating, ${startedText}, ${stepsText}`;
  }
  if (!view.verdict) return 'finished';
  return `finished: ${verdictLabel(view.verdict)}`;
}

export function radarPlaceholder(status: RadarSnapshot | null | undefined) {
  return lanePlaceholder(status, { label: 'PostHog monitoring' });
}

function isCompletedTickSnapshot(snapshot: RadarSnapshot) {
  return numberOr(snapshot.intervalMinutes, null) !== null;
}

export function radarLoadPhase(
  snapshot: RadarSnapshot | null | undefined,
  projectCount: number,
): RadarLoadPhase {
  if (snapshot == null) return 'placeholder';
  if (snapshot.configured === false) return 'placeholder';
  if (projectCount > 0) return 'ready';
  if (isCompletedTickSnapshot(snapshot)) return 'placeholder';
  return 'pending';
}

function issueLastSeenAtMs(issue: RadarIssue | null | undefined): number | null {
  if (typeof issue?.lastSeen !== 'string') return null;
  const lastSeenAtMs = Date.parse(issue.lastSeen);
  if (!Number.isFinite(lastSeenAtMs) || lastSeenAtMs <= 0) return null;
  return lastSeenAtMs;
}

function finiteNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function summarizeIssues(issues: unknown) {
  const list: RadarIssue[] = Array.isArray(issues) ? issues : [];
  let spiking = 0;
  let needsHuman = 0;
  for (const issue of list) {
    if (issue?.change === 'spiking') spiking += 1;
    if (issue?.verdict === 'NEEDS_HUMAN') needsHuman += 1;
  }
  return { active: list.length, spiking, needsHuman };
}

const DEFAULT_STALE_MS = 5 * 60 * 1000;

function staleThresholdMs(intervalMs: unknown) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return DEFAULT_STALE_MS;
  return interval * 2;
}

function lastPathSegment(value: string) {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

function radarDisplayName(project: RadarProject | null | undefined) {
  const configured = lastPathSegment(textOr(project?.name, ''));
  if (configured) return configured;
  const projectId = project?.projectId;
  return projectId == null || projectId === '' ? 'project' : String(projectId);
}

function radarProjectAlert(
  project: RadarProject | null | undefined,
  nowTs: unknown,
  opts: { intervalMs?: unknown } = {}
): RadarProjectAlert {
  const counts = summarizeIssues(project?.issues);
  const error = textOr(project?.error, '').slice(0, 200);
  const now = Number(nowTs);
  const lastTickAt = Number(project?.lastTickAt);
  const age = Number.isFinite(now) && Number.isFinite(lastTickAt) && lastTickAt > 0 ? now - lastTickAt : 0;
  const threshold = staleThresholdMs(opts.intervalMs);
  const staleMs = age > threshold ? age : 0;
  return { loud: counts.active > 0 || counts.spiking > 0 || !!error || staleMs > 0, counts, error, staleMs };
}

function partitionRadarProjects(projects: unknown, nowTs: unknown, opts: { intervalMs?: unknown } = {}) {
  const loud: (RadarProjectAlert & { project: RadarProject })[] = [];
  const quiet: (RadarProjectAlert & { project: RadarProject })[] = [];
  const list: RadarProject[] = Array.isArray(projects) ? projects : [];
  for (const project of list) {
    const alert = radarProjectAlert(project, nowTs, opts);
    const entry = { project, ...alert };
    if (alert.loud) {
      loud.push(entry);
      continue;
    }
    quiet.push(entry);
  }
  return { loud, quiet };
}

function investigationRows(snapshot: RadarSnapshot | null | undefined, locallyArchivedIds: Set<string> | null = null) {
  const list: unknown[] = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  return list
    .filter((record): record is RadarInvestigation => typeof record === 'object' && record !== null)
    .filter((record): record is RadarInvestigation & { id: string } => typeof record.id === 'string' && record.id !== '')
    .filter((record) => record.archived !== true)
    .filter((record) => !locallyArchivedIds?.has(record.id))
    .map((record) => ({
      id: record.id,
      issueId: textOr(record.issueId, ''),
      projectId: record.projectId ?? null,
      projectLabel: textOr(record.projectName, ''),
      title: textOr(record.title, 'Untitled issue'),
      summaryLine: textOr(record.summaryLine, ''),
      url: textOr(record.url, ''),
      verdict: textOr(record.verdict, 'ERROR').toUpperCase(),
      mode: textOr(record.mode, 'investigate'),
      prUrl: /^https:\/\/[^\s"'<>]{1,300}$/.test(textOr(record.prUrl, '')) ? textOr(record.prUrl, '') : '',
      pendingFix: pendingFixOf(record.pendingFix),
      at: Number.isFinite(Number(record.at)) ? Number(record.at) : 0,
    }))
    .sort((a, b) => b.at - a.at);
}

export function retainKnownInvestigationIds(snapshot: RadarSnapshot | null | undefined, ids: Set<string> | null) {
  if (!ids || ids.size === 0) return ids;
  const list: unknown[] = Array.isArray(snapshot?.investigations) ? snapshot.investigations : [];
  const present = new Set<string>();
  for (const record of list) {
    if (typeof record !== 'object' || record === null) continue;
    const { id } = record as { id?: unknown };
    if (typeof id === 'string') present.add(id);
  }
  for (const id of [...ids]) {
    if (present.has(id)) continue;
    ids.delete(id);
  }
  return ids;
}

export function versionLabel(version: unknown, sha: unknown) {
  const labelled = textOr(version, '');
  if (labelled) return /^\d/.test(labelled) ? `v${labelled}` : labelled;
  const short = shortSha(sha, { validate: true });
  return short ? `commit ${short}` : '';
}

export function updateBannerText(update: RadarUpdateFeed | null | undefined) {
  const current = versionLabel(update?.current, update?.currentSha);
  const latest = versionLabel(update?.latest, update?.latestSha);
  return `Update available: ${current} to ${latest}`;
}

function radarAttentionParts({ posthog }: { posthog?: RadarSnapshot | null } = {}) {
  const parts: string[] = [];
  const projects: RadarProject[] = Array.isArray(posthog?.projects) ? posthog.projects : [];
  for (const project of projects) {
    const projectId = textOr(project?.projectId, textOr(project?.name, 'project'));
    const issues: RadarIssue[] = Array.isArray(project?.issues) ? project.issues : [];
    for (let index = 0; index < issues.length; index++) {
      const issue = issues[index];
      const issueId = textOr(issue?.issueId, textOr(issue?.title, `#${index}`));
      if (issue?.change === 'spiking') parts.push(`issue:${projectId}/${issueId}:spiking`);
      if (issue?.verdict === 'NEEDS_HUMAN') parts.push(`issue:${projectId}/${issueId}:needs-human`);
    }
  }
  return parts;
}

export function radarAttentionSignature(input: { posthog?: RadarSnapshot | null } = {}) {
  return attentionSignature(radarAttentionParts(input));
}

function rankFor(change: string | undefined) {
  const rank = CHANGE_RANK[change ?? ''];
  return rank == null ? UNKNOWN_RANK : rank;
}

function sortIssuesByAttention(issues: unknown): RadarIssue[] {
  if (!Array.isArray(issues)) return [];
  return (issues as RadarIssue[])
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.issue?.change) - rankFor(b.issue?.change);
      if (byRank !== 0) return byRank;
      const byUsers = numberOr(b.issue?.users, 0) - numberOr(a.issue?.users, 0);
      if (byUsers !== 0) return byUsers;
      const byOccurrences = numberOr(b.issue?.occurrences, 0) - numberOr(a.issue?.occurrences, 0);
      if (byOccurrences !== 0) return byOccurrences;
      return a.index - b.index;
    })
    .map((entry) => entry.issue);
}

type QueueTierName = 'NOW' | 'NEXT' | 'LATER';

export type QueueStage = 1 | 2 | 3 | 4;

export type QueuePrimaryAction = 'approve-fix' | 'view-investigation' | 'open-report' | 'open-session' | 'archive';

export type QueueInvestigation = ReturnType<typeof investigationRows>[number];

export interface QueueItem {
  key: string;
  tier: QueueTierName;
  stage: QueueStage;
  headline: string;
  issueTitle: string;
  issueId: string;
  projectId: unknown;
  projectLabel: string;
  issue: RadarIssue | null;
  investigations: QueueInvestigation[];
  verdict: string;
  change: string;
  atMs: number;
  dailyVolume: number[] | null;
  primary: QueuePrimaryAction;
}

export interface QueueTier {
  name: QueueTierName;
  items: QueueItem[];
}

interface QueueProjectAlert {
  projectLabel: string;
  error: string;
  staleMs: number;
}

export interface RadarQueue {
  tiers: QueueTier[];
  quietProjectLabels: string[];
  projectAlerts: QueueProjectAlert[];
}

const DAILY_VOLUME_DAYS = 14;

const QUEUE_TIER_NAMES: readonly QueueTierName[] = ['NOW', 'NEXT', 'LATER'];

const NEXT_TIER_CHANGES = new Set(['spiking', 'regressed', 'worsened', 'new']);

const DAY_MS = 24 * 60 * 60 * 1000;

export function queueRowKey(projectId: unknown, issueId: unknown) {
  return [String(projectId ?? ''), String(issueId ?? '')].join('::');
}

function dailyVolumeOf(project: RadarProject | undefined, issueId: string): number[] | null {
  const volumeByIssueId = project?.dailyVolumeByIssueId;
  if (typeof volumeByIssueId !== 'object' || volumeByIssueId === null) return null;
  const series = (volumeByIssueId as Record<string, unknown>)[issueId];
  if (!Array.isArray(series) || series.length !== DAILY_VOLUME_DAYS) return null;
  const counts = finiteNumbers(series);
  return counts.length === DAILY_VOLUME_DAYS ? counts : null;
}

function hasPendingFix(investigations: QueueInvestigation[]) {
  return investigations.some((investigation) => investigation.pendingFix !== null);
}

function tierOf(item: Pick<QueueItem, 'investigations' | 'verdict' | 'change'>, isInFlight: boolean): QueueTierName {
  if (hasPendingFix(item.investigations) || item.verdict === 'NEEDS_HUMAN') return 'NOW';
  if (isInFlight || item.verdict === 'ERROR') return 'NEXT';
  if (!item.verdict && NEXT_TIER_CHANGES.has(item.change)) return 'NEXT';
  return 'LATER';
}

function stageOf(item: Pick<QueueItem, 'investigations' | 'verdict'>, isInFlight: boolean): QueueStage {
  if (hasPendingFix(item.investigations)) return 4;
  if (isInFlight) return 2;
  if (item.verdict) return 3;
  return 1;
}

function primaryActionOf(item: Pick<QueueItem, 'investigations' | 'verdict' | 'issue' | 'issueId'>, isInFlight: boolean): QueuePrimaryAction {
  if (hasPendingFix(item.investigations)) return 'approve-fix';
  if (isInFlight) return 'view-investigation';
  if (item.verdict === 'TRANSIENT' && item.investigations.length > 0) return 'archive';
  const isReportOpenable = item.verdict !== '' && item.issueId !== '';
  if (item.verdict === 'ROOT_CAUSE' || item.verdict === 'FIXED' || item.verdict === 'TRANSIENT') return isReportOpenable ? 'open-report' : 'archive';
  if (item.issue) return 'open-session';
  return isReportOpenable ? 'open-report' : 'archive';
}

export function isQueueItemInFlight(item: QueueItem) {
  return item.issue?.inFlight === true;
}

function completeItem(draft: Omit<QueueItem, 'tier' | 'stage' | 'primary'>): QueueItem {
  const isInFlight = draft.issue?.inFlight === true;
  return { ...draft, tier: tierOf(draft, isInFlight), stage: stageOf(draft, isInFlight), primary: primaryActionOf(draft, isInFlight) };
}

function headlineOf(summaryLine: string, verdict: string, title: string) {
  if (verdict && summaryLine) return summaryLine;
  return title;
}

function issueItemDraft(issue: RadarIssue, project: RadarProject, investigations: QueueInvestigation[]) {
  const issueId = textOr(issue.issueId, '');
  const newestInvestigation = investigations[0] ?? null;
  const verdict = textOr(issue.verdict, '').toUpperCase() || (issue.inFlight === true ? '' : newestInvestigation?.verdict ?? '');
  const summaryLine = textOr(issue.summaryLine, '') || newestInvestigation?.summaryLine || '';
  const issueTitle = textOr(issue.title, 'Untitled issue');
  return {
    key: queueRowKey(project.projectId, issueId),
    headline: headlineOf(summaryLine, verdict, issueTitle),
    issueTitle,
    issueId,
    projectId: project.projectId,
    projectLabel: radarDisplayName(project),
    issue,
    investigations,
    verdict,
    change: textOr(issue.change, ''),
    atMs: newestInvestigation?.at || issueLastSeenAtMs(issue) || 0,
    dailyVolume: dailyVolumeOf(project, issueId),
  };
}

function investigationItemDraft(investigations: QueueInvestigation[], project: RadarProject | undefined) {
  const newest = investigations[0];
  return {
    key: newest.issueId ? queueRowKey(newest.projectId, newest.issueId) : `investigation::${newest.id}`,
    headline: headlineOf(newest.summaryLine, newest.verdict, newest.title),
    issueTitle: newest.title,
    issueId: newest.issueId,
    projectId: newest.projectId,
    projectLabel: newest.projectLabel || (project ? radarDisplayName(project) : ''),
    issue: null,
    investigations,
    verdict: newest.verdict,
    change: '',
    atMs: newest.at,
    dailyVolume: newest.issueId ? dailyVolumeOf(project, newest.issueId) : null,
  };
}

function groupInvestigationsByKey(investigations: QueueInvestigation[]) {
  const investigationsByKey = new Map<string, QueueInvestigation[]>();
  for (const investigation of investigations) {
    const key = investigation.issueId ? queueRowKey(investigation.projectId, investigation.issueId) : `investigation::${investigation.id}`;
    const group = investigationsByKey.get(key) ?? [];
    group.push(investigation);
    investigationsByKey.set(key, group);
  }
  return investigationsByKey;
}

function compareNowItems(a: QueueItem, b: QueueItem) {
  const byStagedFix = Number(b.stage === 4) - Number(a.stage === 4);
  if (byStagedFix !== 0) return byStagedFix;
  return b.atMs - a.atMs;
}

function nextItemComparator(attentionIndexByIssue: Map<RadarIssue, number>) {
  return (a: QueueItem, b: QueueItem) => {
    const byInFlight = Number(isQueueItemInFlight(b)) - Number(isQueueItemInFlight(a));
    if (byInFlight !== 0) return byInFlight;
    const aIndex = a.issue ? attentionIndexByIssue.get(a.issue) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const bIndex = b.issue ? attentionIndexByIssue.get(b.issue) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return b.atMs - a.atMs;
  };
}

export function buildRadarQueue(
  snapshot: RadarSnapshot | null | undefined,
  { archivedLocally = null, nowMs, intervalMs }: { archivedLocally?: Set<string> | null; nowMs: number; intervalMs: number },
): RadarQueue {
  const projects: RadarProject[] = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const projectById = new Map(projects.map((project) => [String(project.projectId ?? ''), project]));
  const investigationsByKey = groupInvestigationsByKey(investigationRows(snapshot, archivedLocally));
  const items: QueueItem[] = [];
  const allIssues: RadarIssue[] = [];
  for (const project of projects) {
    for (const issue of Array.isArray(project.issues) ? project.issues : []) {
      if (!textOr(issue?.issueId, '')) continue;
      allIssues.push(issue);
      const key = queueRowKey(project.projectId, issue.issueId);
      items.push(completeItem(issueItemDraft(issue, project, investigationsByKey.get(key) ?? [])));
      investigationsByKey.delete(key);
    }
  }
  for (const investigations of investigationsByKey.values()) {
    items.push(completeItem(investigationItemDraft(investigations, projectById.get(String(investigations[0].projectId ?? '')))));
  }
  const attentionIndexByIssue = new Map(sortIssuesByAttention(allIssues).map((issue, index) => [issue, index]));
  const compareByTier: Record<QueueTierName, (a: QueueItem, b: QueueItem) => number> = {
    NOW: compareNowItems,
    NEXT: nextItemComparator(attentionIndexByIssue),
    LATER: (a, b) => b.atMs - a.atMs,
  };
  const tiers = QUEUE_TIER_NAMES.map((name) => ({
    name,
    items: items.filter((item) => item.tier === name).sort(compareByTier[name]),
  }));
  const { loud, quiet } = partitionRadarProjects(projects, nowMs, { intervalMs });
  return {
    tiers,
    quietProjectLabels: quiet.map((entry) => radarDisplayName(entry.project)),
    projectAlerts: loud
      .filter((entry) => entry.error || entry.staleMs > 0)
      .map((entry) => ({ projectLabel: radarDisplayName(entry.project), error: entry.error, staleMs: entry.staleMs })),
  };
}

export function queueItemKeys(queue: RadarQueue) {
  return queue.tiers.flatMap((tier) => tier.items.map((item) => item.key));
}

export function selectionAfterRefresh(keys: readonly string[], previousKey: string | null) {
  if (previousKey !== null && keys.includes(previousKey)) return previousKey;
  return keys[0] ?? null;
}

export function transientArchiveIds(queue: RadarQueue) {
  const later = queue.tiers.find((tier) => tier.name === 'LATER')?.items ?? [];
  return later.flatMap((item) =>
    item.investigations.filter((investigation) => investigation.verdict === 'TRANSIENT').map((investigation) => investigation.id),
  );
}

interface DailyStripCell {
  occurrences: number;
  level: 0 | 1 | 2 | 3;
  dayStartMs: number;
  hasInvestigation: boolean;
}

export function dailyStripCells(
  dailyVolume: readonly number[],
  { todayStartMs, investigationAts, isHot }: { todayStartMs: number; investigationAts: readonly number[]; isHot: boolean },
): DailyStripCell[] {
  const peak = Math.max(0, ...dailyVolume);
  const maxLevel = isHot ? 3 : 2;
  return dailyVolume.map((occurrences, index) => {
    const dayStartMs = todayStartMs - (dailyVolume.length - 1 - index) * DAY_MS;
    const scaledLevel = peak === 0 || occurrences === 0 ? 0 : Math.max(1, Math.ceil((occurrences / peak) * 3));
    return {
      occurrences,
      level: Math.min(scaledLevel, maxLevel) as DailyStripCell['level'],
      dayStartMs,
      hasInvestigation: investigationAts.some((at) => at >= dayStartMs && at < dayStartMs + DAY_MS),
    };
  });
}
