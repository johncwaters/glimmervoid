import type { PackRow, PackSourceRow } from '#shared/contracts/control/pack-messages.ts';
import { SESSIONS_ACT_GRANT_TEXT } from '#shared/contracts/pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { buildChip } from '../settings/settings-readouts.ts';
import { button } from '../ui/button.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

const PACKS_TRUST_NOTE = 'Approving a pack lets its commands run on this machine and its panels show what they read. Panels cannot reach the network, but they are trusted not to leak what they read. Any change to a file in a pack asks again.';
const PACK_SOURCES_NOTE = 'A pack source is a git repository of shared packs, cloned with git hooks and symlinks off. Enable installs one of its packs, which then waits for approval above; Update pulls the repository and reinstalls the enabled packs, and any changed pack asks again.';
const SOURCE_REPLY_TIMEOUT_MS = 5 * 60_000;
const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Pending', approved: 'Approved', invalid: 'Not loaded' };

const approveStatusByFingerprint = new Map<string, { tone: ActionStatusTone; text: string }>();
const SOURCES_STATUS_KEY = 'add-source';
const sourceStatusByKey = new Map<string, { tone: ActionStatusTone; text: string }>();
let draftSourceUrl = '';
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

type SourceRequest =
  | { type: 'pack-source-add'; url: string }
  | { type: 'pack-source-update'; slug: string }
  | { type: 'pack-source-remove'; slug: string }
  | { type: 'pack-source-enable'; slug: string; pack: string; isEnabled: boolean };

async function changeSource(statusKey: string, request: SourceRequest): Promise<void> {
  sourceStatusByKey.set(statusKey, { tone: 'busy', text: 'Working' });
  repaintPacks();
  try {
    const { type, ...fields } = request;
    const response = await sendControlRequest(type, fields, { timeoutMs: SOURCE_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-source-result') throw new Error('Unexpected pack source reply.');
    sourceStatusByKey.set(statusKey, response.ok ? { tone: 'ok', text: response.text ?? 'Done' } : { tone: 'error', text: response.error ?? 'The pack source did not change.' });
    if (response.ok && type === 'pack-source-add') draftSourceUrl = '';
  } catch (error) {
    sourceStatusByKey.set(statusKey, { tone: 'error', text: requestFailureText(error, SOURCE_REPLY_TIMEOUT_MS) });
  } finally {
    repaintPacks();
  }
}

function statusLine(statusKey: string): HTMLElement {
  const status = sourceStatusByKey.get(statusKey);
  const statusText = el('span', 'settings-view-pack-status');
  statusText.setAttribute('role', 'status');
  paintActionStatus(statusText, status?.tone ?? null, status?.text ?? '');
  return statusText;
}

function isSourceBusy(statusKey: string): boolean {
  return sourceStatusByKey.get(statusKey)?.tone === 'busy';
}

function sourcePackLine(source: PackSourceRow, pack: PackSourceRow['packs'][number]): HTMLElement {
  const line = el('div', 'settings-view-pack-source-pack');
  const statusKey = `${source.slug}/${pack.name}`;
  const isBusy = isSourceBusy(statusKey);
  const setEnabled = (isEnabled: boolean) => { void changeSource(statusKey, { type: 'pack-source-enable', slug: source.slug, pack: pack.name, isEnabled }); };
  const enable = button({ variant: 'secondary', label: 'Enable', action: 'pack-source-enable', disabled: isBusy || pack.isEnabled, onClick: () => setEnabled(true) });
  const remove = button({ variant: 'secondary', label: 'Remove', action: 'pack-source-disable', disabled: isBusy || !pack.isEnabled, onClick: () => setEnabled(false) });
  line.append(el('span', 'settings-view-setting-description', `${pack.name}: ${pack.isEnabled ? 'installed' : 'off'}`), enable, remove, statusLine(statusKey));
  return line;
}

function sourceArticle(source: PackSourceRow): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', source.url));
  text.append(
    heading,
    el('p', 'settings-view-setting-description', `Clone: ${source.dir}`),
    ...(source.packs.length === 0 ? [el('p', 'settings-view-setting-description', 'It holds no pack folders.')] : source.packs.map((pack) => sourcePackLine(source, pack))),
    ...(source.error === null ? [] : [el('p', 'settings-view-warning', source.error)]),
  );
  const control = el('div', 'settings-view-setting-control');
  const isBusy = isSourceBusy(source.slug);
  control.append(
    button({ variant: 'secondary', label: 'Update', action: 'pack-source-update', disabled: isBusy, onClick: () => { void changeSource(source.slug, { type: 'pack-source-update', slug: source.slug }); } }),
    button({ variant: 'secondary', label: 'Remove source', action: 'pack-source-remove', disabled: isBusy, onClick: () => { void changeSource(source.slug, { type: 'pack-source-remove', slug: source.slug }); } }),
    statusLine(source.slug),
  );
  article.append(text, control);
  return article;
}

function addSourceForm(): HTMLElement {
  const form = el('div', 'settings-view-pack-source-add');
  const input = markAsNotCredential(el('input', 'settings-view-input'));
  input.type = 'url';
  input.placeholder = 'https://github.com/owner/packs';
  input.value = draftSourceUrl;
  input.setAttribute('aria-label', 'Git URL of a pack source');
  const addSource = () => {
    if (draftSourceUrl.trim() === '' || isSourceBusy(SOURCES_STATUS_KEY)) return;
    void changeSource(SOURCES_STATUS_KEY, { type: 'pack-source-add', url: draftSourceUrl.trim() });
  };
  input.addEventListener('input', () => { draftSourceUrl = input.value; });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') addSource(); });
  const addButton = button({ variant: 'secondary', label: 'Add source', action: 'pack-source-add', disabled: isSourceBusy(SOURCES_STATUS_KEY), onClick: addSource });
  form.append(input, addButton, statusLine(SOURCES_STATUS_KEY));
  return form;
}

function sourcesContent(sources: readonly PackSourceRow[]): HTMLElement[] {
  return [
    el('h3', 'settings-view-section-title', 'Pack sources'),
    el('p', 'settings-view-section-description', PACK_SOURCES_NOTE),
    addSourceForm(),
    ...sources.map(sourceArticle),
  ];
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
  const sources = sourcesContent(status.sources);
  if (status.packs.length === 0) return [intro, ...warnings, el('p', 'settings-view-setting-description', 'No packs yet. Copy a pack folder into ~/.glimmervoid/packs/ or list its path in packs in config.json.'), ...sources];
  return [intro, ...warnings, ...status.packs.map(packArticle), ...sources];
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
