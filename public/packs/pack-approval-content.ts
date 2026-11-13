import type { PackRow } from '#shared/contracts/control/pack-messages.ts';
import { SESSIONS_ACT_GRANT_TEXT } from '#shared/contracts/pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { capitalized, packGrants } from '#shared/pack-approval.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { createModalOverlay } from '../session-card/modal.ts';
import { buildChip } from '../settings/settings-readouts.ts';
import { button } from '../ui/button.ts';
import { openFirstPackPanel } from './pack-views.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';
import './pack-approval-content.css';

type PackApprovalControls = { close: () => void; repaint: () => void };

const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Pending', approved: 'Approved', invalid: 'Not loaded' };
const approvalStatusByPackName = new Map<string, { tone: ActionStatusTone; text: string }>();

function statusLine(packName: string): HTMLElement {
  const status = approvalStatusByPackName.get(packName);
  const line = el('span', 'pack-approval-status');
  line.setAttribute('role', 'status');
  paintActionStatus(line, status?.tone ?? null, status?.text ?? '');
  return line;
}

async function requestPackApproval(fingerprint: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await sendControlRequest('pack-approve', { fingerprint }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-approve-result') return { ok: false, error: 'Unexpected pack approval reply.' };
    return response.ok ? { ok: true } : { ok: false, error: response.error ?? 'Could not approve this pack.' };
  } catch (error) {
    return { ok: false, error: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

async function requestDismissal(packName: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await sendControlRequest('pack-request-dismiss', { pack: packName }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-request-dismiss-result') return { ok: false, error: 'Unexpected dismiss reply.' };
    return response.ok ? { ok: true } : { ok: false, error: response.error ?? 'Could not dismiss this request.' };
  } catch (error) {
    return { ok: false, error: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

async function runPackRequest(packName: string, busyText: string, request: () => Promise<{ ok: true } | { ok: false; error: string }>, controls: PackApprovalControls): Promise<boolean> {
  approvalStatusByPackName.set(packName, { tone: 'busy', text: busyText });
  controls.repaint();
  const outcome = await request();
  if (!outcome.ok) {
    approvalStatusByPackName.set(packName, { tone: 'error', text: outcome.error });
    controls.repaint();
    return false;
  }
  approvalStatusByPackName.delete(packName);
  controls.close();
  return true;
}

async function approve(row: PackRow, fingerprint: string, controls: PackApprovalControls): Promise<void> {
  const isApproved = await runPackRequest(row.name, `Approving ${row.name}`, () => requestPackApproval(fingerprint), controls);
  if (isApproved) openFirstPackPanel(row.name);
}

function dismiss(row: PackRow, controls: PackApprovalControls): Promise<boolean> {
  return runPackRequest(row.name, `Dismissing the request for ${row.name}`, () => requestDismissal(row.name), controls);
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
  const startsSessions = row.panels.some((panel) => panel.acts.includes('sessions'));
  if (!startsSessions) return [];
  const readsReviews = row.panels.some((panel) => panel.reads.includes('reviews'));
  const readsProviders = row.statusUrls.length > 0 && row.panels.some((panel) => panel.reads.includes('providers'));
  const outsideTexts = [...(readsReviews ? ['pull request text other people wrote'] : []), ...(readsProviders ? ['incident text the status pages write'] : [])];
  if (outsideTexts.length === 0) return [];
  return [el('p', 'settings-view-warning', `This pack reads ${outsideTexts.join(' and ')} and can start agents, and its panels share one store, so that text could steer what it runs`)];
}

function launcherLines(row: PackRow): HTMLElement[] {
  return row.launchers.flatMap((launcher) => {
    const setup = [launcher.model, launcher.effort].filter((choice): choice is string => choice !== null);
    const heading = `Launcher: ${launcher.label} starts ${launcher.agent}${setup.length === 0 ? '' : ` (${setup.join(', ')})`} in ${launcher.project}${launcher.schedule === null ? '' : `, and also on the cron schedule ${launcher.schedule} in your timezone,`} with this prompt:`;
    return [el('p', 'settings-view-setting-description', heading), el('pre', 'settings-view-pack-prompt', launcher.prompt)];
  });
}

const PACK_AGENT_GRANT_TEXT = "Every session's agent follows these skills and reads this file.";

function agentLines(row: PackRow): HTMLElement[] {
  const agent = row.agent;
  if (agent === null || (agent.context === null && agent.skills.length === 0)) return [];
  return [
    el('p', 'settings-view-warning', PACK_AGENT_GRANT_TEXT),
    ...(agent.context === null ? [] : [el('p', 'settings-view-setting-description', `Context file ${agent.context.path}:`), el('pre', 'settings-view-pack-prompt', agent.context.text)]),
    ...agent.skills.flatMap((skill) => [el('p', 'settings-view-setting-description', `Skill ${skill.name} (${skill.path}/SKILL.md):`), el('pre', 'settings-view-pack-prompt', skill.text)]),
  ];
}

function packLines(row: PackRow): HTMLElement[] {
  const sessionsText = sessionsLine(row.sessions);
  const lines = [
    ...(row.description ? [row.description] : []),
    `Folder: ${row.dir}`,
    ...(row.statusUrls.length === 0 ? [] : [`Status pages it reads every five minutes for its panels: ${row.statusUrls.join(', ')}`]),
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
    ...agentLines(row),
    ...(sessionsText === null ? [] : [el('p', 'settings-view-warning', sessionsText)]),
    ...row.errors.map((error) => el('p', 'settings-view-warning', error)),
    ...(row.prFlows ? approvalDetails(row.prFlows) : []),
  ];
}

function everythingItAdds(row: PackRow): HTMLElement {
  const details = el('details', 'pack-approval-details');
  details.append(el('summary', 'pack-approval-details-summary', 'Show everything it adds'), ...packLines(row));
  return details;
}

function approvedBody(row: PackRow): HTMLElement[] {
  const hasPanel = packsSnapshot()?.panels.some((panel) => panel.pack === row.name) ?? false;
  const footer = el('div', 'pack-approval-actions');
  if (hasPanel) footer.append(button({ variant: 'secondary', size: 'small', label: 'Open panel', onClick: () => openFirstPackPanel(row.name) }));
  return [el('p', 'pack-approval-note', `${row.name} is approved and in use.`), everythingItAdds(row), footer];
}

function pendingBody(row: PackRow, controls: PackApprovalControls): HTMLElement[] {
  const fingerprint = row.fingerprint;
  const isBusy = approvalStatusByPackName.get(row.name)?.tone === 'busy';
  const canApprove = fingerprint !== null && row.state === 'pending' && row.errors.length === 0 && !isBusy;
  const actions = el('div', 'pack-approval-actions');
  actions.append(
    button({ variant: 'secondary', size: 'small', label: 'Dismiss', disabled: isBusy, onClick: () => { void dismiss(row, controls); } }),
    button({ variant: 'primary', size: 'small', label: 'Approve', action: 'pack-approve', disabled: !canApprove, onClick: () => { if (fingerprint !== null) void approve(row, fingerprint, controls); } }),
  );
  return [
    ...packGrants(row).map((grant) => el('p', 'pack-approval-grant', capitalized(grant))),
    ...row.errors.map((error) => el('p', 'pack-approval-error', error)),
    everythingItAdds(row),
    statusLine(row.name),
    actions,
  ];
}

export function buildPackApprovalContent(packName: string, controls: PackApprovalControls): HTMLElement {
  const content = el('div', 'pack-approval');
  content.setAttribute('role', 'group');
  content.setAttribute('aria-label', `Approve the pack ${packName}`);
  const row = packsSnapshot()?.packs.find((candidate) => candidate.name === packName);
  if (!row) {
    content.append(el('p', 'pack-approval-note', `No pack named ${packName} is loaded here.`));
    return content;
  }
  content.append(packHeading(row));
  if (row.description) content.append(el('p', 'pack-approval-description', row.description));
  content.append(...(row.state === 'approved' ? approvedBody(row) : pendingBody(row, controls)));
  return content;
}

export function openPackDetail(packName: string): void {
  const { dialog, close } = createModalOverlay({ dialogClass: 'dialog packs-detail-dialog' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `Pack ${packName}`);
  const unsubscribe = subscribePacks(() => repaint());
  const closeDetail = () => {
    unsubscribe();
    close();
  };
  function repaint(): void {
    if (!dialog.isConnected) {
      unsubscribe();
      return;
    }
    dialog.replaceChildren(buildPackApprovalContent(packName, { close: closeDetail, repaint }));
  }
  repaint();
}
