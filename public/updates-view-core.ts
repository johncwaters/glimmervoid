import type { UpdateStatus } from '#shared/contracts/control-messages.ts';
import type { UpdateJournal, UpdateRunState, UpdateStepStatus } from '#shared/contracts/update-journal.ts';
import { shortSha, versionLabel } from './radar-core.ts';
import { textOr } from './coerce-core.ts';

export type UpdateStatusView = Partial<UpdateStatus>;

export interface UpdateActionDecision {
  enabled: boolean;
  reason: string | null;
}

export interface UpdateActionAvailability {
  update: UpdateActionDecision;
  restart: UpdateActionDecision;
}

export interface UpdateProgressStep {
  id: string;
  label: string;
  status: UpdateStepStatus;
}

export interface UpdateProgressProjection {
  state: UpdateRunState;
  terminalLine: string | null;
  steps: UpdateProgressStep[];
  outputTail: string[];
  outputStepId: string | null;
  outputStepLabel: string | null;
}

export interface UpdateRequestState {
  requested: boolean;
  failure: string | null;
}

export type UpdateRequestEvent = 'request-sent' | 'request-unsent' | 'status-frame' | 'progress-frame' | 'error-frame';

const UPDATE_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fetch: 'Fetch',
  stage: 'Stage',
  install: 'Install dependencies',
  'link-deps': 'Link dependencies',
  build: 'Build',
});

const CHECK_FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'branch-count-unavailable': 'The last check could not compare the checked-out branch with its upstream.',
  'branch-diverged': 'The checked-out branch has diverged from its upstream.',
  'fetch-failed': 'The last update check could not fetch the upstream branch.',
  'main-channel-requires-clone': 'The main channel requires a clone install.',
  'no-branch': 'The last update check found no checked-out branch.',
  'no-upstream': 'The checked-out branch has no upstream.',
  'release-already-checked-out': 'The checkout already contains the latest release. Restart to run it.',
  'release-check-failed': 'The last release check failed.',
  'remote-tip-unavailable': 'The last update check could not resolve the upstream branch tip.',
  'update-check-failed': 'The last update check failed.',
});

const INSTALL_SHAPE_REFUSALS: readonly string[] = Object.freeze(['unsupported-flavor', 'unsupported-platform']);
const NOT_CONNECTED_TEXT = 'Not connected to the server. Reconnecting.';

export const IDLE_UPDATE_REQUEST: UpdateRequestState = Object.freeze({ requested: false, failure: null });

export function reduceUpdateRequest(state: UpdateRequestState, event: UpdateRequestEvent): UpdateRequestState {
  if (event === 'request-sent') return { requested: true, failure: null };
  if (event === 'request-unsent') return { requested: false, failure: NOT_CONNECTED_TEXT };
  if (event === 'progress-frame') return IDLE_UPDATE_REQUEST;
  if (event === 'error-frame') return state.requested ? IDLE_UPDATE_REQUEST : state;
  if (state.failure === null) return state;
  return { requested: state.requested, failure: null };
}

function updateRunState(
  status: UpdateStatusView | null | undefined,
  journal: UpdateJournal | null | undefined,
): unknown {
  if (journal?.state) return journal.state;
  return status?.journalSummary?.state;
}

function unavailable(reason: string): UpdateActionDecision {
  return { enabled: false, reason };
}

function available(): UpdateActionDecision {
  return { enabled: true, reason: null };
}

export function updateActionAvailability({
  status,
  journal,
  request = IDLE_UPDATE_REQUEST,
}: {
  status?: UpdateStatusView | null;
  journal?: UpdateJournal | null;
  request?: UpdateRequestState;
}): UpdateActionAvailability {
  const runState = updateRunState(status, journal);
  const isLaneInFlight = runState === 'running' || request.requested;
  const restart = isLaneInFlight
    ? unavailable('Wait for update staging to finish.')
    : available();
  if (request.failure) return { update: unavailable(request.failure), restart };
  if (isLaneInFlight) return { update: unavailable('Wait for the current update to finish.'), restart };
  if (!status) return { update: unavailable('Update status unavailable. Check for updates.'), restart };
  const refusal = status.applyRefusal;
  if (refusal) return { update: unavailable(refusal.message), restart };
  return { update: available(), restart };
}

export function updateBannerMode(status: UpdateStatusView | null | undefined): 'link' | 'command' {
  const refusal = status?.applyRefusal;
  if (refusal === undefined) return 'command';
  if (refusal === null) return 'link';
  if (INSTALL_SHAPE_REFUSALS.includes(refusal.reason)) return 'command';
  return 'link';
}

function reasonSuffix(reason: unknown): string {
  const text = textOr(reason, '');
  if (!text) return '';
  return `: ${text}`;
}

function terminalProgressLine(journal: UpdateJournal): string | null {
  if (journal.state === 'staged') return `Update staged. Restart to hand it off${reasonSuffix(journal.reason)}.`;
  if (journal.state === 'succeeded') return `Update succeeded at restart${reasonSuffix(journal.reason)}.`;
  if (journal.state === 'failed') return `Update failed${reasonSuffix(journal.reason)}.`;
  if (journal.state === 'discarded') return `Update discarded${reasonSuffix(journal.reason)}.`;
  if (journal.state === 'interrupted') return `Update interrupted${reasonSuffix(journal.reason)}.`;
  return null;
}

function stepLabel(stepId: string): string {
  return UPDATE_STEP_LABELS[stepId] ?? stepId;
}

function visibleOutputTail(journal: UpdateJournal): { stepId: string | null; lines: string[] } {
  const active = journal.steps.find((step) => step.id === journal.activeStep);
  if (active && active.outputTail.length > 0) return { stepId: active.id, lines: active.outputTail };
  const spoken = journal.steps.findLast((step) => step.outputTail.length > 0);
  if (!spoken) return { stepId: null, lines: [] };
  return { stepId: spoken.id, lines: spoken.outputTail };
}

export function projectUpdateProgress(journal: UpdateJournal | null | undefined): UpdateProgressProjection | null {
  if (!journal || journal.state === 'idle') return null;
  const output = visibleOutputTail(journal);
  const borrowedStepId = output.stepId !== null && output.stepId !== journal.activeStep ? output.stepId : null;
  return {
    state: journal.state,
    terminalLine: terminalProgressLine(journal),
    steps: journal.steps.map((step) => ({
      id: step.id,
      label: stepLabel(step.id),
      status: step.status,
    })),
    outputTail: output.lines,
    outputStepId: output.stepId,
    outputStepLabel: borrowedStepId === null ? null : stepLabel(borrowedStepId),
  };
}

const AUTO_CHECK_STALE_MS = 10 * 60_000;

export type UpdateSummaryTone = 'unknown' | 'current' | 'available' | 'running' | 'staged';

export interface UpdateSummary {
  tone: UpdateSummaryTone;
  headline: string;
}

function behindText(status: UpdateStatusView): string {
  if (status.channel !== 'main' || !Number.isInteger(status.behindCount)) return '';
  return `${status.behindCount} ${status.behindCount === 1 ? 'commit' : 'commits'} behind`;
}

export function updateSummary(
  status: UpdateStatusView | null | undefined,
  journal: UpdateJournal | null | undefined,
): UpdateSummary {
  const runState = updateRunState(status, journal);
  const target = versionLabel(journal?.toVersion, journal?.toSha)
    || versionLabel(status?.latest, status?.latestSha)
    || 'the update';
  if (runState === 'running') return { tone: 'running', headline: `Updating to ${target}. Glimmervoid keeps running until the restart.` };
  if (runState === 'staged') return { tone: 'staged', headline: `${target} is staged. Restart to finish updating.` };
  if (!status) return { tone: 'unknown', headline: 'No update check has run yet.' };
  const current = versionLabel(status.current, status.currentSha) || 'an unknown version';
  if (status.updateAvailable) {
    const latest = versionLabel(status.latest, status.latestSha) || 'a newer build';
    const behind = behindText(status);
    return { tone: 'available', headline: `Update available: ${current} to ${latest}${behind ? ` (${behind})` : ''}.` };
  }
  if (textOr(status.reason, '')) return { tone: 'unknown', headline: `Running ${current}. The last check did not finish.` };
  return { tone: 'current', headline: `Up to date. Running ${current}.` };
}

export function installedUpdateText(status: UpdateStatusView | null | undefined): string {
  if (!status) return 'Update status unavailable.';
  const version = versionLabel(status.current, null) || 'Unknown version';
  const sha = shortSha(status.currentSha);
  const branch = textOr(status.installedBranch, '');
  const location = [sha ? `commit ${sha}` : '', branch ? `on ${branch}` : ''].filter(Boolean).join(' ');
  const treeState = status.isTreeClean === true ? 'clean checkout' : status.isTreeClean === false ? 'uncommitted local changes' : '';
  return [version, location, treeState].filter(Boolean).join(', ');
}

export function latestUpdateDetails(status: UpdateStatusView | null | undefined): {
  label: string;
  behind: string;
  releaseUrl: string;
} {
  if (!status) return { label: 'Update status unavailable.', behind: '', releaseUrl: '' };
  const label = versionLabel(status.latest, status.latestSha) || 'Latest target unknown';
  return { label, behind: behindText(status), releaseUrl: textOr(status.releaseUrl, '') };
}

export function shouldAutoCheckUpdates({
  status,
  checkForUpdates,
  now,
  lastAutoCheckAt,
}: {
  status?: UpdateStatusView | null;
  checkForUpdates?: unknown;
  now: number;
  lastAutoCheckAt: number | null;
}): boolean {
  if (checkForUpdates === false) return false;
  if (lastAutoCheckAt !== null && now - lastAutoCheckAt < AUTO_CHECK_STALE_MS) return false;
  const lastCheckAt = typeof status?.lastCheckAt === 'number' ? status.lastCheckAt : null;
  return lastCheckAt === null || now - lastCheckAt >= AUTO_CHECK_STALE_MS;
}

export function lastUpdateCheckText({
  status,
  checkForUpdates,
  relativeTime,
}: {
  status?: UpdateStatusView | null;
  checkForUpdates?: unknown;
  relativeTime: string;
}): string {
  if (checkForUpdates === false) return 'Update checks are off.';
  if (!status) return 'No update check has run.';
  const reason = textOr(status.reason, '');
  if (reason) return CHECK_FAILURE_TEXT[reason] ?? `The last update check failed: ${reason}.`;
  if (status.flavor === 'unknown') return 'The install flavor is unknown.';
  return relativeTime;
}
