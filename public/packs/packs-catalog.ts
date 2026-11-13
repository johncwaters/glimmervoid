import type { PackRow, PackSourceRow } from '#shared/contracts/control/pack-messages.ts';
import { SESSIONS_ACT_GRANT_TEXT } from '#shared/contracts/pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { buildChip } from '../settings/settings-readouts.ts';
import { createModalOverlay, openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { buildPackApprovalContent } from './pack-approval-content.ts';
import { openFirstPackPanel, packTabIcon } from './pack-views.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';
import './packs-catalog.css';

export const PACKS_TAB_HASH = '#packs';
const PACKS_TRUST_NOTE = 'Approving a pack lets its commands run on this machine and its panels show what they read. Panels cannot reach the network, but they are trusted not to leak what they read. Any change to a file in a pack asks again.';
const PACK_SOURCES_NOTE = 'A pack source is a git repository of shared packs, cloned with git hooks and symlinks off. Enable installs one of its packs, which then waits for approval under Installed; Update pulls the repository and reinstalls the enabled packs, and any changed pack asks again.';
const SOURCE_REPLY_TIMEOUT_MS = 5 * 60_000;
const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Pending', approved: 'Approved', invalid: 'Not loaded' };

const EXAMPLES_SOURCE_NOTE = 'Example packs that ship with Glimmervoid. Enable installs one, which then waits for approval under Installed; when a Glimmervoid update changes an enabled example, it is reinstalled while Glimmervoid runs and asks for approval again.';
const SOURCES_STATUS_KEY = 'add-source';
const sourceStatusByKey = new Map<string, { tone: ActionStatusTone; text: string }>();
let draftSourceUrl = '';
let packsBody: HTMLElement | null = null;
let searchText = '';

export async function requestPackApproval(fingerprint: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await sendControlRequest('pack-approve', { fingerprint }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-approve-result') return { ok: false, error: 'Unexpected pack approval reply.' };
    return response.ok ? { ok: true } : { ok: false, error: response.error ?? 'Could not approve this pack.' };
  } catch (error) {
    return { ok: false, error: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

type SourceRequest =
  | { type: 'pack-source-add'; url: string }
  | { type: 'pack-source-update'; slug: string }
  | { type: 'pack-source-remove'; slug: string }
  | { type: 'pack-source-enable'; slug: string; pack: string; isEnabled: boolean }
  | { type: 'pack-folder-remove'; dir: string };

async function changeSource(statusKey: string, request: SourceRequest): Promise<void> {
  sourceStatusByKey.set(statusKey, { tone: 'busy', text: 'Working' });
  repaintPacks();
  try {
    const { type, ...fields } = request;
    const response = await sendControlRequest(type, fields, { timeoutMs: SOURCE_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-source-result') throw new Error('Unexpected pack source reply.');
    sourceStatusByKey.set(statusKey, response.ok ? { tone: 'ok', text: response.text ?? 'Done' } : { tone: 'error', text: response.error ?? 'The pack source did not change.' });
    if (response.ok && type === 'pack-source-enable') sourceStatusByKey.delete(statusKey);
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

function sourceControls(source: PackSourceRow): HTMLElement[] {
  if (source.isBuiltIn) return [];
  const isBusy = isSourceBusy(source.slug);
  return [
    button({ variant: 'secondary', size: 'small', label: 'Update', action: 'pack-source-update', disabled: isBusy, onClick: () => { void changeSource(source.slug, { type: 'pack-source-update', slug: source.slug }); } }),
    button({ variant: 'secondary', size: 'small', label: 'Remove source', action: 'pack-source-remove', disabled: isBusy, onClick: () => { void changeSource(source.slug, { type: 'pack-source-remove', slug: source.slug }); } }),
    statusLine(source.slug),
  ];
}

function sourcePacksText(source: PackSourceRow): string {
  if (source.packs.length === 0) return 'It holds no pack folders.';
  const installedCount = source.packs.filter((pack) => pack.isEnabled).length;
  return `${source.packs.length === 1 ? '1 pack' : `${source.packs.length} packs`}, ${installedCount} installed: ${source.packs.map((pack) => pack.name).join(', ')}`;
}

function sourceArticle(source: PackSourceRow): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', source.isBuiltIn ? 'Glimmervoid examples' : source.url));
  text.append(
    heading,
    el('p', 'settings-view-setting-description', source.isBuiltIn ? EXAMPLES_SOURCE_NOTE : `Clone: ${source.dir}`),
    el('p', 'settings-view-setting-description', sourcePacksText(source)),
    ...(source.error === null ? [] : [el('p', 'settings-view-warning', source.error)]),
  );
  const control = el('div', 'settings-view-setting-control');
  control.append(...sourceControls(source));
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

export function packHeading(row: PackRow): HTMLElement {
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

export function packLines(row: PackRow): HTMLElement[] {
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

function removeFolderControls(row: PackRow): HTMLElement[] {
  if (!row.isPlacedByHand) return [];
  const statusKey = `folder:${row.dir}`;
  const confirmRemoval = () => openConfirmDialog({
    title: `Remove ${row.name}?`,
    message: `This deletes ${row.dir} and every file in it. Glimmervoid did not install this folder, so nothing can put it back.`,
    confirmLabel: 'Remove folder', danger: true,
    onConfirm: () => { void changeSource(statusKey, { type: 'pack-folder-remove', dir: row.dir }); },
  });
  const remove = button({ variant: 'secondary', size: 'small', label: 'Remove folder', action: 'pack-folder-remove', disabled: isSourceBusy(statusKey), onClick: confirmRemoval });
  return [remove, statusLine(statusKey)];
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

function sourceLabel(source: PackSourceRow): string {
  if (source.isBuiltIn) return 'Glimmervoid examples';
  return source.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, '').replace(/\.git$/, '');
}

function installedFrom(row: PackRow, sources: readonly PackSourceRow[]): { source: PackSourceRow; pack: PackSourceRow['packs'][number] } | null {
  for (const source of sources) {
    const pack = source.packs.find((candidate) => candidate.name === row.name && candidate.isEnabled);
    if (pack) return { source, pack };
  }
  return null;
}

function packKinds(row: PackRow): string[] {
  const hasAgentFiles = row.agent !== null && (row.agent.context !== null || row.agent.skills.length > 0);
  return [
    ...(row.panels.length === 0 ? [] : ['Panel']),
    ...(row.launchers.length === 0 ? [] : ['Launcher']),
    ...(row.themes.length === 0 ? [] : [row.themes.length === 1 ? '1 theme' : `${row.themes.length} themes`]),
    ...(hasAgentFiles ? ['Agent skills'] : []),
    ...(row.prFlows ? ['PR commands'] : []),
  ];
}

function cardIcon(packName: string, iconUrl: string | null): HTMLElement {
  const frame = el('span', 'packs-card-icon');
  frame.setAttribute('aria-hidden', 'true');
  if (iconUrl !== null) {
    frame.append(packTabIcon(iconUrl));
    return frame;
  }
  frame.append(el('span', 'packs-card-glyph', packName.slice(0, 1).toUpperCase()));
  return frame;
}

function cardShell(packName: string, iconUrl: string | null, metaText: string, chip: HTMLElement | null): { card: HTMLElement; body: HTMLElement; actions: HTMLElement } {
  const card = el('article', 'packs-card');
  const head = el('div', 'packs-card-head');
  const titles = el('div', 'packs-card-titles');
  const nameLine = el('div', 'packs-card-name-line');
  nameLine.append(el('h3', 'packs-card-name', packName), ...(chip === null ? [] : [chip]));
  titles.append(nameLine, el('p', 'packs-card-meta', metaText));
  head.append(cardIcon(packName, iconUrl), titles);
  const body = el('div', 'packs-card-body');
  const actions = el('div', 'packs-card-actions');
  card.append(head, body, actions);
  return { card, body, actions };
}

const CHIP_TEXT_BY_STATE: { readonly [State in PackRow['state']]: string | null } = { pending: 'Needs approval', approved: null, invalid: 'Problem' };

function sourceRemoveControls(statusKey: string, slug: string, packName: string): HTMLElement[] {
  const remove = button({ variant: 'secondary', size: 'small', label: 'Remove', action: 'pack-source-disable', disabled: isSourceBusy(statusKey), onClick: () => { void changeSource(statusKey, { type: 'pack-source-enable', slug, pack: packName, isEnabled: false }); } });
  return [remove, statusLine(statusKey)];
}

function installedActions(row: PackRow, origin: ReturnType<typeof installedFrom>, hasPanel: boolean): HTMLElement[] {
  const approve = row.state === 'pending' ? [button({ variant: 'primary', size: 'small', label: 'Approve', action: 'pack-approve', onClick: () => openPackDetail(row.name) })] : [];
  const openPanel = row.state === 'approved' && hasPanel ? [button({ variant: 'secondary', size: 'small', label: 'Open panel', action: 'pack-open-panel', onClick: () => openFirstPackPanel(row.name) })] : [];
  const removeControls = origin === null ? removeFolderControls(row) : sourceRemoveControls(`${origin.source.slug}/${origin.pack.name}`, origin.source.slug, origin.pack.name);
  return [...approve, ...openPanel, ...removeControls];
}

function installedCard(row: PackRow, status: NonNullable<ReturnType<typeof packsSnapshot>>): HTMLElement {
  const origin = installedFrom(row, status.sources);
  const panelIconUrl = status.panels.find((panel) => panel.pack === row.name && panel.iconUrl !== null)?.iconUrl ?? null;
  const hasPanel = status.panels.some((panel) => panel.pack === row.name);
  const originText = origin === null ? (row.isPlacedByHand ? 'Placed by hand' : null) : sourceLabel(origin.source);
  const metaText = [...packKinds(row), ...(originText === null ? [] : [originText])].join(' . ');
  const chipText = CHIP_TEXT_BY_STATE[row.state];
  const chip = chipText === null ? null : buildChip(`pack-${row.state}`, chipText);
  const { card, body, actions } = cardShell(row.version === null ? row.name : `${row.name} v${row.version}`, panelIconUrl, metaText, chip);
  card.dataset.packState = row.state;
  const problemText = row.errors[0] ?? (row.missingRequires.length === 0 ? null : `Missing here: ${row.missingRequires.join(', ')}`);
  if (problemText !== null) body.append(el('p', 'packs-card-problem', problemText));
  if (problemText === null && row.description) body.append(el('p', 'packs-card-description', row.description));
  actions.append(button({ variant: 'quiet', size: 'small', label: 'Details', action: 'pack-details', onClick: () => openPackDetail(row.name) }), ...installedActions(row, origin, hasPanel));
  return card;
}

function discoverCard(source: PackSourceRow, pack: PackSourceRow['packs'][number]): HTMLElement {
  const metaText = pack.isEnabled ? `${sourceLabel(source)} . enabled, but its installed folder is missing` : sourceLabel(source);
  const { card, actions } = cardShell(pack.name, null, metaText, null);
  const statusKey = `${source.slug}/${pack.name}`;
  if (pack.isEnabled) {
    actions.append(...sourceRemoveControls(statusKey, source.slug, pack.name));
    return card;
  }
  const enable = button({ variant: 'secondary', size: 'small', label: 'Enable', action: 'pack-source-enable', disabled: isSourceBusy(statusKey), onClick: () => { void changeSource(statusKey, { type: 'pack-source-enable', slug: source.slug, pack: pack.name, isEnabled: true }); } });
  actions.append(enable, statusLine(statusKey));
  return card;
}

function matchesSearch(...texts: (string | null)[]): boolean {
  const needle = searchText.trim().toLowerCase();
  if (needle === '') return true;
  return texts.some((text) => text?.toLowerCase().includes(needle) ?? false);
}

function sectionHeading(title: string, count: number, extra: HTMLElement[] = []): HTMLElement {
  const heading = el('div', 'packs-section-heading');
  heading.append(el('h2', 'packs-section-title', title), el('span', 'packs-section-count', String(count)), el('span', 'packs-section-spacer'), ...extra);
  return heading;
}

function grid(cards: HTMLElement[], emptyText: string): HTMLElement {
  if (cards.length === 0) return el('p', 'packs-empty', emptyText);
  const cardGrid = el('div', 'packs-grid');
  cardGrid.append(...cards);
  return cardGrid;
}

function sourcesSection(sources: readonly PackSourceRow[]): HTMLElement {
  const section = el('section', 'packs-sources');
  section.id = 'packs-sources';
  section.append(sectionHeading('Sources', sources.length), el('p', 'packs-note', PACK_SOURCES_NOTE), addSourceForm(), ...sources.map(sourceArticle));
  return section;
}

function packsContent(): HTMLElement[] {
  const status = packsSnapshot();
  if (!status) return [el('p', 'packs-empty', 'Waiting for the server to list packs.')];
  const warnings = status.warnings.map((warning) => el('p', 'settings-view-warning', warning));
  const installedRows = status.packs.filter((row) => matchesSearch(row.name, row.description));
  const installedNames = new Set(status.packs.map((row) => row.name));
  const discoverCards = status.sources.flatMap((source) => source.packs
    .filter((pack) => !installedNames.has(pack.name) && matchesSearch(pack.name, sourceLabel(source)))
    .map((pack) => discoverCard(source, pack)));
  const jumpToSources = button({ variant: 'secondary', size: 'small', label: 'Sources', action: 'packs-sources', onClick: () => document.getElementById('packs-sources')?.scrollIntoView({ block: 'start' }) });
  const installedEmptyText = status.packs.length === 0 ? 'No packs yet. Enable one under Discover, or copy a pack folder into ~/.glimmervoid/packs/.' : 'No installed pack matches.';
  return [
    ...warnings,
    sectionHeading('Installed', installedRows.length),
    grid(installedRows.map((row) => installedCard(row, status)), installedEmptyText),
    sectionHeading('Discover', discoverCards.length, [jumpToSources]),
    grid(discoverCards, status.sources.length === 0 ? 'No pack sources yet. Add one under Sources.' : 'Every pack from your sources is installed.'),
    sourcesSection(status.sources),
  ];
}

function repaintPacks(): void {
  if (!packsBody?.isConnected) return;
  packsBody.replaceChildren(...packsContent());
}

subscribePacks(repaintPacks);

function mountPacksView(parent: HTMLElement): void {
  if (packsBody) return;
  const root = el('div', 'packs-content');
  const header = el('div', 'packs-header');
  const search = markAsNotCredential(el('input', 'settings-view-input packs-search'));
  search.type = 'search';
  search.placeholder = 'Search packs';
  search.setAttribute('aria-label', 'Search packs');
  search.addEventListener('input', () => {
    searchText = search.value;
    repaintPacks();
  });
  header.append(el('h1', 'packs-title', 'Packs'), el('span', 'packs-section-spacer'), search);
  packsBody = el('div', 'packs-body');
  root.append(header, el('p', 'packs-note', PACKS_TRUST_NOTE), packsBody);
  parent.append(root);
  repaintPacks();
}

export const view: ViewModule<HTMLElement> = { mount: mountPacksView };

export function renderPacksTabLink(container: HTMLElement): void {
  const note = el('p', 'settings-view-section-description', 'Install, approve and remove packs in the ');
  const link = el('a', '', 'Packs tab');
  link.href = PACKS_TAB_HASH;
  note.append(link, '. Below are the extra folders Glimmervoid loads packs from.');
  container.appendChild(note);
}
