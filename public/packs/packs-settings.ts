import type { PackRow } from '#shared/contracts/control/pack-messages.ts';
import { SESSIONS_ACT_GRANT_TEXT } from '#shared/contracts/pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { buildChip } from '../settings/settings-readouts.ts';
import { button } from '../ui/button.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

const PACKS_TRUST_NOTE = 'Approving a pack lets its commands run on this machine and its panels show what they read. Panels cannot reach the network, but they are trusted not to leak what they read. Any change to a file in a pack asks again.';
const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Pending', approved: 'Approved', invalid: 'Not loaded' };

const approveStatusByFingerprint = new Map<string, { tone: ActionStatusTone; text: string }>();
let packsContainer: HTMLElement | null = null;

async function approvePack(fingerprint: string): Promise<void> {
  approveStatusByFingerprint.set(fingerprint, { tone: 'busy', text: 'Approving' });
  repaintPacks();
  try {
    const response = await sendControlRequest('pack-approve', { fingerprint }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-approve-result') throw new Error('Unexpected pack approval reply.');
    if (!response.ok) {
      approveStatusByFingerprint.set(fingerprint, { tone: 'error', text: response.error ?? 'Could not approve this pack.' });
      return;
    }
    approveStatusByFingerprint.delete(fingerprint);
  } catch (error) {
    approveStatusByFingerprint.set(fingerprint, { tone: 'error', text: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) });
  } finally {
    repaintPacks();
  }
}

function packHeading(row: PackRow): HTMLElement {
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', row.version === null ? row.name : `${row.name} v${row.version}`), ' ', buildChip('pack-state', STATE_LABELS[row.state]));
  return heading;
}

function sessionsLine(sessions: PackRow['sessions']): string | null {
  if (!sessions?.dangerouslySkipPermissions) return null;
  const guardrails = sessions.saneYolo === undefined ? 'Sane YOLO as in your settings' : `Sane YOLO ${sessions.saneYolo ? 'on' : 'off'}`;
  return `Sessions its launchers and panels start skip permission prompts (${guardrails})`;
}

const ACT_GRANT_TEXT_BY_ACT: { readonly [Act in PackRow['panels'][number]['acts'][number]]: string } = {
  reviews: `acts as you in Reviews without asking: may ${REVIEW_ACTIONS_GRANT_TEXT}`,
  sessions: `may ${SESSIONS_ACT_GRANT_TEXT} without asking`,
};

function panelLines(row: PackRow): HTMLElement[] {
  return row.panels.flatMap((panel) => {
    const readsText = panel.reads.length === 0 ? ', reads nothing from the dashboard' : `, reads ${panel.reads.join(', ')}`;
    const actsText = panel.acts.map((act) => `; ${ACT_GRANT_TEXT_BY_ACT[act]}`).join('');
    return [el('p', 'settings-view-setting-description', `Panel: ${panel.label}${readsText}${actsText}`)];
  });
}

function steeringWarning(row: PackRow): HTMLElement[] {
  const readsReviews = row.panels.some((panel) => panel.reads.includes('reviews'));
  const startsSessions = row.panels.some((panel) => panel.acts.includes('sessions'));
  if (!readsReviews || !startsSessions) return [];
  return [el('p', 'settings-view-warning', 'This pack reads pull request text other people wrote and can start agents, and its panels share one store, so that text could steer what it runs')];
}

function launcherLines(row: PackRow): HTMLElement[] {
  return row.launchers.flatMap((launcher) => {
    const setup = [launcher.model, launcher.effort].filter((choice): choice is string => choice !== null);
    const heading = `Launcher: ${launcher.label} starts ${launcher.agent}${setup.length === 0 ? '' : ` (${setup.join(', ')})`} in ${launcher.project}${launcher.schedule === null ? '' : `, and also on the cron schedule ${launcher.schedule} in your timezone,`} with this prompt:`;
    return [el('p', 'settings-view-setting-description', heading), el('pre', 'settings-view-pack-prompt', launcher.prompt)];
  });
}

function packLines(row: PackRow): HTMLElement[] {
  const sessionsText = sessionsLine(row.sessions);
  const lines = [
    ...(row.description ? [row.description] : []),
    `Folder: ${row.dir}`,
    ...(row.themes.length === 0 ? [] : [`Themes: ${row.themes.map((theme) => `${theme.label} (${theme.mode})`).join(', ')}`]),
    ...(row.files.length === 0 ? [] : [`Files: ${row.files.join(', ')}`]),
    ...(row.needs.length === 0 ? [] : [`Needs: ${row.needs.join(', ')}`]),
    ...(row.missingRequires.length === 0 ? [] : [`Missing here: ${row.missingRequires.join(', ')}; the pack stays off until this machine has them`]),
  ];
  return [
    ...lines.map((line) => el('p', 'settings-view-setting-description', line)),
    ...panelLines(row),
    ...steeringWarning(row),
    ...launcherLines(row),
    ...(sessionsText === null ? [] : [el('p', 'settings-view-warning', sessionsText)]),
    ...row.errors.map((error) => el('p', 'settings-view-warning', error)),
    ...(row.prFlows ? approvalDetails(row.prFlows) : []),
  ];
}

function packControl(row: PackRow): HTMLElement {
  const control = el('div', 'settings-view-setting-control');
  const fingerprint = row.fingerprint;
  if (fingerprint === null) return control;
  const status = approveStatusByFingerprint.get(fingerprint);
  const approve = button({
    variant: 'secondary', label: 'Approve', action: 'pack-approve',
    disabled: row.state !== 'pending' || row.errors.length > 0 || status?.tone === 'busy',
    onClick: () => { void approvePack(fingerprint); },
  });
  const statusText = el('span', 'settings-view-pack-status');
  statusText.setAttribute('role', 'status');
  paintActionStatus(statusText, status?.tone ?? null, status?.text ?? '');
  control.append(approve, statusText);
  return control;
}

function packArticle(row: PackRow): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  article.dataset.packState = row.state;
  const text = el('div', 'settings-view-setting-text');
  text.append(packHeading(row), ...packLines(row));
  article.append(text, packControl(row));
  return article;
}

function packsContent(): HTMLElement[] {
  const status = packsSnapshot();
  const intro = el('p', 'settings-view-section-description', PACKS_TRUST_NOTE);
  if (!status) return [intro, el('p', 'settings-view-setting-description', 'Waiting for the server to list packs.')];
  const warnings = status.warnings.map((warning) => el('p', 'settings-view-warning', warning));
  if (status.packs.length === 0) return [intro, ...warnings, el('p', 'settings-view-setting-description', 'No packs yet. Copy a pack folder into ~/.glimmervoid/packs/ or list its path in packs in config.json.')];
  return [intro, ...warnings, ...status.packs.map(packArticle)];
}

function repaintPacks(): void {
  if (!packsContainer?.isConnected) return;
  packsContainer.replaceChildren(...packsContent());
}

subscribePacks(repaintPacks);

export function renderPacksPage(container: HTMLElement): void {
  packsContainer = el('div', 'settings-view-stack');
  container.appendChild(packsContainer);
  repaintPacks();
}
