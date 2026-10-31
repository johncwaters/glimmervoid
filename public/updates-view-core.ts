import type { UpdateStatus } from '#shared/contracts/control-messages.ts';
import type { UpdateJournal, UpdateRunState, UpdateStepStatus } from '#shared/contracts/update-journal.ts';
import { textOr } from '#shared/coerce.ts';
import { shortSha } from '#shared/git-text.ts';
import { updateBannerText, versionLabel } from './radar/radar-core.ts';

export type UpdateStatusView = Partial<UpdateStatus>;

export type UpdateActionId = 'update' | 'restart' | 'check';

interface UpdateControls {
  actions: UpdateActionId[];
  note: string | null;
  command: string | null;
}

type UpdateBannerMode = 'restart' | 'link' | 'command';

type UpdateBannerTone = 'update' | 'security';

interface UpdateBanner {
  mode: UpdateBannerMode;
  tone: UpdateBannerTone;
  text: string;
}

interface UpdateProgressStep {
  id: string;
  label: string;
  status: UpdateStepStatus;
}

interface UpdateProgressProjection {
  state: UpdateRunState;
  terminalLine: string | null;
  failureDetail: string | null;
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

const UPDATE_FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'handoff-preflight-failed': 'The checkout changed after the update downloaded.',
  'handoff-queue-admission-timed-out': 'Git stayed busy too long to install it.',
  'staging-head-mismatch': 'The download did not match the release.',
});

const CHECK_FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'release-check-failed': 'The last release check failed.',
  'update-check-failed': 'The last update check failed.',
});

const INSTALL_SHAPE_REFUSALS: readonly string[] = Object.freeze(['unsupported-flavor', 'unsupported-platform', 'install-not-writable']);
export const NOT_CONNECTED_TEXT = 'Not connected to the server. Reconnecting.';

export const IDLE_UPDATE_REQUEST: UpdateRequestState = Object.freeze({ requested: false, failure: null });

export function updateErrorText(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, '');
}

export function reduceUpdateRequest(state: UpdateRequestState, event: UpdateRequestEvent, errorText: string | null = null): UpdateRequestState {
  if (event === 'request-sent') return { requested: true, failure: null };
  if (event === 'request-unsent') return { requested: false, failure: NOT_CONNECTED_TEXT };
  if (event === 'progress-frame') return IDLE_UPDATE_REQUEST;
  if (event === 'error-frame') return state.requested ? { requested: false, failure: errorText } : state;
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

function controls(actions: UpdateActionId[], note: string | null = null, command: string | null = null): UpdateControls {
  return { actions, note, command };
}

function isInstallShapeRefusal(status: UpdateStatusView | null | undefined): boolean {
  const refusal = status?.applyRefusal;
  if (!refusal) return false;
  return INSTALL_SHAPE_REFUSALS.includes(refusal.reason);
}

export function updateControls({
  status,
  journal,
  request = IDLE_UPDATE_REQUEST,
}: {
  status?: UpdateStatusView | null;
  journal?: UpdateJournal | null;
  request?: UpdateRequestState;
}): UpdateControls {
  if (request.failure === NOT_CONNECTED_TEXT) return controls([], NOT_CONNECTED_TEXT);
  const decided = statusControls(updateRunState(status, journal), status, request.requested);
  if (!request.failure) return decided;
  return { ...decided, note: request.failure };
}

function statusControls(runState: unknown, status: UpdateStatusView | null | undefined, isRequestInFlight: boolean): UpdateControls {
  if (runState === 'running' || isRequestInFlight) return controls([]);
  if (runState === 'staged') return controls(['restart']);
  if (isTargetCheckedOut(status)) return controls(['restart']);
  if (!status?.updateAvailable) return controls(['check']);
  const refusal = status.applyRefusal;
  if (!refusal) return controls(['update']);
  if (isInstallShapeRefusal(status)) return controls(['check'], refusal.message, textOr(status.command, null));
  return controls(['check'], refusal.message);
}

function isTargetCheckedOut(status: UpdateStatusView | null | undefined): boolean {
  return status?.applyRefusal?.reason === 'target-already-checked-out';
}

function isUpdateReady(status: UpdateStatusView | null | undefined): boolean {
  return status?.journalSummary?.state === 'staged' || isTargetCheckedOut(status);
}

function checkFailureText(reason: string): string {
  return CHECK_FAILURE_TEXT[reason] ?? `The last update check failed: ${reason}.`;
}

function securityNoticeText(status: UpdateStatusView | null | undefined): string | null {
  const deprecation = textOr(status?.deprecation, null);
  if (!deprecation) return null;
  const current = versionLabel(status?.current, status?.currentSha) || 'This version';
  return `Security notice: ${current} is marked unsafe. ${deprecation}`;
}

function plainUpdateBanner(status: UpdateStatusView | null | undefined): Omit<UpdateBanner, 'tone'> {
  const latest = versionLabel(status?.latest, status?.latestSha) || 'A new version';
  if (isUpdateReady(status)) return { mode: 'restart', text: `${latest} is ready. Restart to update, or it installs on the next start.` };
  if (status?.journalSummary?.state === 'running') return { mode: 'link', text: `Downloading ${latest} in the background.` };
  const text = updateBannerText(status);
  if (!status || status.applyRefusal === undefined || isInstallShapeRefusal(status)) return { mode: 'command', text };
  return { mode: 'link', text };
}

export function updateBanner(status: UpdateStatusView | null | undefined): UpdateBanner {
  const plain = plainUpdateBanner(status);
  const securityText = securityNoticeText(status);
  if (!securityText) return { ...plain, tone: 'update' };
  if (isUpdateReady(status) || status?.journalSummary?.state === 'running') {
    return { mode: plain.mode, tone: 'security', text: `${securityText} ${plain.text}` };
  }
  return { mode: 'command', tone: 'security', text: securityText };
}

function reasonSuffix(reason: unknown): string {
  const text = textOr(reason, '');
  if (!text) return '';
  return `: ${text}`;
}

const QUIET_PROGRESS_STATES: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>(['idle', 'staged', 'succeeded', 'discarded']);

function failureReasonKey(reason: string | null): string {
  return (reason ?? '').split(/[:;]/, 1)[0] ?? '';
}

function failedProgressLine(journal: UpdateJournal): string {
  const knownCause = UPDATE_FAILURE_TEXT[failureReasonKey(journal.reason)];
  const failedStep = journal.steps.find((step) => step.status === 'failed');
  const isHandOffFailure = journal.failedAtHandOff === true;
  const handOffCause = isHandOffFailure ? 'It stopped while switching to the new version.' : null;
  const cause = knownCause ?? (failedStep ? `It stopped at ${stepLabel(failedStep.id)}.` : handOffCause);
  const isCurrentVersionUntouched = knownCause !== undefined || !isHandOffFailure;
  return ['Update failed.', cause, isCurrentVersionUntouched ? 'Your current version is still running.' : null]
    .filter((part) => part !== null)
    .join(' ');
}

function terminalProgressLine(journal: UpdateJournal): string | null {
  if (journal.state === 'failed') return failedProgressLine(journal);
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
  if (!journal || QUIET_PROGRESS_STATES.has(journal.state)) return null;
  const output = visibleOutputTail(journal);
  const borrowedStepId = output.stepId !== null && output.stepId !== journal.activeStep ? output.stepId : null;
  return {
    state: journal.state,
    terminalLine: terminalProgressLine(journal),
    failureDetail: journal.state === 'failed' ? textOr(journal.reason, null) : null,
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

type UpdateSummaryTone = 'unknown' | 'current' | 'available' | 'running' | 'staged' | 'security' | 'failed';

interface UpdateSummary {
  tone: UpdateSummaryTone;
  headline: string;
}

export function updateSummary(
  status: UpdateStatusView | null | undefined,
  journal: UpdateJournal | null | undefined,
): UpdateSummary {
  const runState = updateRunState(status, journal);
  const target = versionLabel(journal?.toVersion, journal?.toSha)
    || versionLabel(status?.latest, status?.latestSha)
    || 'the update';
  if (runState === 'running') return { tone: 'running', headline: `Downloading ${target} in the background. Glimmervoid keeps running.` };
  if (runState === 'staged') return { tone: 'staged', headline: `${target} is ready. Restart to update now, or it installs on the next start.` };
  if (!status) return { tone: 'unknown', headline: 'No update check has run yet.' };
  const securityText = securityNoticeText(status);
  if (securityText) return { tone: 'security', headline: securityText };
  if (isTargetCheckedOut(status)) {
    const checkedOut = versionLabel(status.latest, status.latestSha) || 'The latest release';
    return { tone: 'staged', headline: `${checkedOut} is already checked out. Restart to run it.` };
  }
  if (status.updateAvailable && runState === 'failed') return { tone: 'failed', headline: `${target} did not install.` };
  if (status.updateAvailable) return { tone: 'available', headline: 'Update available.' };
  const reason = textOr(status.reason, '');
  if (reason) return { tone: 'unknown', headline: checkFailureText(reason) };
  return { tone: 'current', headline: 'Up to date.' };
}

export function shouldShowLatestUpdate(status: UpdateStatusView | null | undefined): boolean {
  return status?.updateAvailable === true || isTargetCheckedOut(status);
}

export function installedUpdateText(status: UpdateStatusView | null | undefined): string {
  if (!status) return 'Update status unavailable.';
  const version = versionLabel(status.current, null) || 'Unknown version';
  const sha = shortSha(status.currentSha, { validate: true });
  const branch = textOr(status.installedBranch, '');
  const location = [sha ? `commit ${sha}` : '', branch ? `on ${branch}` : ''].filter(Boolean).join(' ');
  const treeState = status.isTreeClean === true ? 'clean checkout' : status.isTreeClean === false ? 'uncommitted local changes' : '';
  return [version, location, treeState].filter(Boolean).join(', ');
}

export function latestUpdateDetails(status: UpdateStatusView | null | undefined): {
  label: string;
  releaseUrl: string;
} {
  if (!status) return { label: 'Update status unavailable.', releaseUrl: '' };
  const label = versionLabel(status.latest, status.latestSha) || 'Latest target unknown';
  return { label, releaseUrl: textOr(status.releaseUrl, '') };
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
  if (status.flavor === 'unknown') return 'The install flavor is unknown.';
  return relativeTime;
}
