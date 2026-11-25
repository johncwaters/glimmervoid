import type { PackRow } from '#shared/contracts/control/pack-messages.ts';
import { SESSIONS_ACT_GRANT_TEXT } from '#shared/contracts/pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { packGrantSections, packKindLabels } from '#shared/pack-approval.ts';
import type { PackGrantSection } from '#shared/pack-approval.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { createModalOverlay } from '../session-card/modal.ts';
import { COMMUNITY_ICON_PATH, createLineIcon, TERMINAL_ICON_PATH } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { tag } from '../ui/tag.ts';
import { openFirstPackPanel } from './pack-views.ts';
import { createPackSettingsView } from './pack-settings-view.ts';
import type { PackSettingsSection } from './pack-settings-view.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';
import './pack-approval-content.css';

type PackApprovalControls = { close: () => void; repaint: () => void; settingsView?: (row: PackRow) => HTMLElement };

const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Needs approval', approved: 'Approved', invalid: 'Not loaded' };
const STATE_TONES = { pending: 'warning', approved: 'accent', invalid: 'failed' } as const;
const THEME_GLYPH_PATH = 'M8 2.5a5.5 5.5 0 1 0 0 11z M8 2.5a5.5 5.5 0 0 1 0 11';
const PANEL_GLYPH_PATH = 'M2.5 3.5h11v9h-11z M2.5 6h11 M6 6v6.5';

export function kindGlyphPath(kinds: readonly string[]): string {
  if (kinds.includes('Panel')) return PANEL_GLYPH_PATH;
  if (kinds.some((kind) => kind.endsWith('theme') || kind.endsWith('themes'))) return THEME_GLYPH_PATH;
  if (kinds.includes('Community sources')) return COMMUNITY_ICON_PATH;
  return TERMINAL_ICON_PATH;
}
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

async function runPackRequest(packName: string, busyText: string, request: () => Promise<{ ok: true } | { ok: false; error: string }>, controls: PackApprovalControls, closesOnSuccess = true): Promise<boolean> {
  approvalStatusByPackName.set(packName, { tone: 'busy', text: busyText });
  controls.repaint();
  const outcome = await request();
  if (!outcome.ok) {
    approvalStatusByPackName.set(packName, { tone: 'error', text: outcome.error });
    controls.repaint();
    return false;
  }
  approvalStatusByPackName.delete(packName);
  if (closesOnSuccess) controls.close();
  if (!closesOnSuccess) controls.repaint();
  return true;
}

async function approve(row: PackRow, fingerprint: string, controls: PackApprovalControls): Promise<void> {
  const staysOnSetup = row.settings.length > 0 && controls.settingsView !== undefined;
  const isApproved = await runPackRequest(row.name, `Approving ${row.name}`, () => requestPackApproval(fingerprint), controls, !staysOnSetup);
  if (isApproved && !staysOnSetup) openFirstPackPanel(row.name);
}

function dismiss(row: PackRow, controls: PackApprovalControls): Promise<boolean> {
  return runPackRequest(row.name, `Dismissing the request for ${row.name}`, () => requestDismissal(row.name), controls);
}

function packHeading(row: PackRow): HTMLElement {
  const heading = el('div', 'pack-approval-heading');
  const glyph = el('span', 'pack-approval-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.append(createLineIcon(kindGlyphPath(packKindLabels({ ...row, communitySources: row.community?.sources ?? [] })), '1.5'));
  heading.append(glyph, el('h2', 'pack-approval-title', row.version === null ? row.name : `${row.name} v${row.version}`), tag({ text: STATE_LABELS[row.state], tone: STATE_TONES[row.state], shape: 'pill' }));
  return heading;
}

function grantSection(section: PackGrantSection): HTMLElement {
  const block = el('section', 'pack-approval-section');
  const list = el('ul', 'pack-approval-grants');
  list.append(...section.items.map((item) => {
    const line = el('li', 'pack-approval-grant', item.text);
    if (item.detail !== null) line.append(' ', el('span', 'pack-approval-grant-detail', item.detail));
    return line;
  }));
  block.append(el('h3', 'pack-approval-section-title', section.title), list);
  return block;
}

function commandsText(row: PackRow): string | null {
  const commandLines = [
    ...(row.community?.sources ?? []).map((source) => `${source.label} source: ${source.command.join(' ')}`),
    ...row.jobs.map((job) => `Job ${job.label}: ${job.command.join(' ')}`),
    ...row.hooks.map((hook) => `Hook ${hook.id}: ${hook.command.join(' ')}`),
  ];
  return commandLines.length === 0 ? null : commandLines.join('\n');
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

function mcpServerLines(row: PackRow): HTMLElement[] {
  return row.mcpServers.flatMap((server) => [
    el('p', 'settings-view-setting-description', `MCP server: ${server.name} at ${server.url}, added to every session you start; with no secret the agent asks you to sign in`),
    ...server.notes.map((note) => el('p', 'settings-view-warning', note)),
  ]);
}

function packLines(row: PackRow): HTMLElement[] {
  const sessionsText = sessionsLine(row.sessions);
  const lines = [
    `Folder: ${row.dir}`,
    ...(row.statusUrls.length === 0 ? [] : [`Status pages it reads every five minutes for its panels: ${row.statusUrls.join(', ')}`]),
    ...(row.themes.length === 0 ? [] : [`Themes: ${row.themes.map((theme) => `${theme.label} (${theme.mode})`).join(', ')}`]),
    ...(row.files.length === 0 ? [] : [`Files: ${row.files.join(', ')}`]),
    ...(row.needs.length === 0 ? [] : [`Needs: ${row.needs.join(', ')}`]),
    ...(row.missingRequires.length === 0 ? [] : [`Missing here: ${row.missingRequires.join(', ')}; the pack stays off until this machine has them`]),
  ];
  const commands = commandsText(row);
  return [
    ...(commands === null ? [] : [el('pre', 'settings-view-pack-prompt', commands)]),
    ...lines.map((line) => el('p', 'settings-view-setting-description', line)),
    ...panelLines(row),
    ...steeringWarning(row),
    ...launcherLines(row),
    ...agentLines(row),
    ...mcpServerLines(row),
    ...(sessionsText === null ? [] : [el('p', 'settings-view-warning', sessionsText)]),
    ...row.errors.map((error) => el('p', 'settings-view-warning', error)),
    ...(row.prFlows ? approvalDetails(row.prFlows) : []),
  ];
}

function everythingItAdds(row: PackRow): HTMLElement {
  const details = el('details', 'pack-approval-details');
  details.append(el('summary', 'pack-approval-details-summary', 'Exact commands and files'), ...packLines(row));
  return details;
}

function approvedBody(row: PackRow, controls: PackApprovalControls): HTMLElement[] {
  const hasPanel = packsSnapshot()?.panels.some((panel) => panel.pack === row.name) ?? false;
  const footer = el('div', 'pack-approval-actions');
  if (hasPanel) footer.append(button({ variant: 'secondary', size: 'small', label: 'Open panel', onClick: () => openFirstPackPanel(row.name) }));
  const settings = row.settings.length > 0 && controls.settingsView ? [controls.settingsView(row)] : [];
  return [el('p', 'pack-approval-note', `${row.name} is approved and in use.`), ...settings, everythingItAdds(row), footer];
}

function pendingBody(row: PackRow, controls: PackApprovalControls): HTMLElement[] {
  const fingerprint = row.fingerprint;
  const isBusy = approvalStatusByPackName.get(row.name)?.tone === 'busy';
  const canApprove = fingerprint !== null && row.state === 'pending' && row.errors.length === 0 && !isBusy;
  const actions = el('div', 'pack-approval-actions');
  actions.append(
    el('span', 'pack-approval-trust', 'Any change to its files asks again.'),
    button({ variant: 'secondary', size: 'small', label: 'Dismiss', disabled: isBusy, onClick: () => { void dismiss(row, controls); } }),
    button({ variant: 'primary', size: 'small', label: 'Approve', action: 'pack-approve', disabled: !canApprove, onClick: () => { if (fingerprint !== null) void approve(row, fingerprint, controls); } }),
  );
  return [
    ...packGrantSections(row).map(grantSection),
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
  content.append(...(row.state === 'approved' ? approvedBody(row, controls) : pendingBody(row, controls)));
  return content;
}

export function openPackDetail(packName: string): void {
  const { dialog, close } = createModalOverlay({ dialogClass: 'dialog packs-detail-dialog' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `Pack ${packName}`);
  const unsubscribe = subscribePacks(() => repaint());
  let keptSettings: { fingerprint: string | null; section: PackSettingsSection } | null = null;
  const settingsView = (row: PackRow): HTMLElement => {
    if (keptSettings !== null && keptSettings.fingerprint === row.fingerprint) {
      keptSettings.section.readIfUnread();
      return keptSettings.section.element;
    }
    keptSettings = { fingerprint: row.fingerprint, section: createPackSettingsView(row) };
    return keptSettings.section.element;
  };
  const closeDetail = () => {
    unsubscribe();
    close();
  };
  function repaint(): void {
    if (!dialog.isConnected) {
      unsubscribe();
      return;
    }
    dialog.replaceChildren(buildPackApprovalContent(packName, { close: closeDetail, repaint, settingsView }));
  }
  repaint();
}
