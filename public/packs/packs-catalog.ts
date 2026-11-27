import type { PackRow, PackSourceRow, PackThemeSwatch } from '#shared/contracts/control/pack-messages.ts';
import { packKindLabels } from '#shared/pack-approval.ts';
import { paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { emptyState } from '../ui/empty-state.ts';
import { el } from '../dom-helpers.ts';
import { textInput } from '../ui/text-input.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { tag } from '../ui/tag.ts';
import { disclosure } from '../ui/disclosure.ts';
import type { ViewModule } from '../view-registry-core.ts';
import packFolderRemoveAction from '../state/actions/pack-folder-remove.ts';
import packSourceEnableAction from '../state/actions/pack-source-enable.ts';
import packSourceRemoveAction from '../state/actions/pack-source-remove.ts';
import { PACKS_TAB_HASH, packsSnapshot, watchPacksCollection } from '../state/collections/packs.ts';
import type { ActionResult } from '../state/define-action.ts';
import { PACK_SOURCE_REPLY_TIMEOUT_MS } from '../state/packs-core.ts';
import { kindGlyphPath, openPackDetail } from './pack-approval-content.ts';
import { openFirstPackPanel, packTabIcon } from './pack-views.ts';
import './packs-catalog.css';

const PACKS_TRUST_LINE = 'An approved pack runs its commands on this machine; any change to its files asks again.';
const MAX_PREVIEW_SWATCHES = 4;
const SOURCES_STATUS_KEY = 'add-source';
const sourceStatusByKey = new Map<string, { tone: ActionStatusTone; text: string }>();
let draftSourceUrl = '';
let packsBody: HTMLElement | null = null;
let searchText = '';
let isSourcesOpen = false;

type SourceRequest =
  | { type: 'pack-source-add'; url: string }
  | { type: 'pack-source-update'; slug: string }
  | { type: 'pack-source-remove'; slug: string }
  | { type: 'pack-source-enable'; slug: string; pack: string; isEnabled: boolean }
  | { type: 'pack-folder-remove'; dir: string; packName: string };

async function runSourceRequest(request: SourceRequest): Promise<ActionResult> {
  if (request.type === 'pack-folder-remove') return packFolderRemoveAction({ dir: request.dir, packName: request.packName });
  if (request.type === 'pack-source-remove') return packSourceRemoveAction({ slug: request.slug });
  if (request.type === 'pack-source-enable') return packSourceEnableAction({ slug: request.slug, pack: request.pack, isEnabled: request.isEnabled });
  try {
    const { type, ...fields } = request;
    const response = await sendControlRequest(type, fields, { timeoutMs: PACK_SOURCE_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-source-result') return { ok: false, error: new Error('Unexpected pack source reply.') };
    if (!response.ok) return { ok: false, error: new Error(response.error ?? 'The pack source did not change.') };
    return { ok: true, reply: response };
  } catch (error) {
    return { ok: false, error: new Error(requestFailureText(error, PACK_SOURCE_REPLY_TIMEOUT_MS)) };
  }
}

async function changeSource(statusKey: string, request: SourceRequest): Promise<void> {
  sourceStatusByKey.set(statusKey, { tone: 'busy', text: 'Working' });
  repaintPacks();
  try {
    const outcome = await runSourceRequest(request);
    if (!outcome.ok) {
      sourceStatusByKey.set(statusKey, { tone: 'error', text: outcome.error.message });
      return;
    }
    const replyText = outcome.reply.type === 'pack-source-result' ? outcome.reply.text : undefined;
    sourceStatusByKey.set(statusKey, { tone: 'ok', text: replyText ?? 'Done' });
    if (request.type === 'pack-source-enable') sourceStatusByKey.delete(statusKey);
    if (request.type === 'pack-source-add') draftSourceUrl = '';
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

function sourceArticle(source: PackSourceRow): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', source.isBuiltIn ? 'Glimmervoid examples' : source.url));
  text.append(
    heading,
    el('p', 'settings-view-setting-description', source.isBuiltIn ? 'Ships with Glimmervoid.' : `Clone: ${source.dir}`),
    ...(source.error === null ? [] : [el('p', 'settings-view-warning', source.error)]),
  );
  const control = el('div', 'settings-view-setting-control');
  control.append(...sourceControls(source));
  article.append(text, control);
  return article;
}

function addSourceForm(): HTMLElement {
  const form = el('div', 'settings-view-pack-source-add');
  const input = textInput({ type: 'url', value: draftSourceUrl, placeholder: 'https://github.com/owner/packs', label: 'Git URL of a pack source', onInput: (value) => { draftSourceUrl = value; } });
  const addSource = () => {
    if (draftSourceUrl.trim() === '' || isSourceBusy(SOURCES_STATUS_KEY)) return;
    void changeSource(SOURCES_STATUS_KEY, { type: 'pack-source-add', url: draftSourceUrl.trim() });
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') addSource(); });
  const addButton = button({ variant: 'secondary', label: 'Add source', action: 'pack-source-add', disabled: isSourceBusy(SOURCES_STATUS_KEY), onClick: addSource });
  form.append(input, addButton, statusLine(SOURCES_STATUS_KEY));
  return form;
}

function removeFolderControls(row: PackRow): HTMLElement[] {
  if (!row.isPlacedByHand) return [];
  const statusKey = `folder:${row.dir}`;
  const confirmRemoval = () => openConfirmDialog({
    title: `Remove ${row.name}?`,
    message: `This deletes ${row.dir} and every file in it. Glimmervoid did not install this folder, so nothing can put it back.`,
    confirmLabel: 'Remove folder', danger: true,
    onConfirm: () => { void changeSource(statusKey, { type: 'pack-folder-remove', dir: row.dir, packName: row.name }); },
  });
  const remove = button({ variant: 'secondary', size: 'small', label: 'Remove folder', action: 'pack-folder-remove', disabled: isSourceBusy(statusKey), onClick: confirmRemoval });
  return [remove, statusLine(statusKey)];
}

function sourceLabel(source: PackSourceRow): string {
  if (source.isBuiltIn) return 'Glimmervoid examples';
  return source.url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, '').replace(/\.git$/, '');
}

type PackOrigin = { source: PackSourceRow; pack: PackSourceRow['packs'][number] };
type PackPanelInfo = { hasPanel: boolean; iconUrl: string | null };

function buildOriginByPackName(sources: readonly PackSourceRow[]): Map<string, PackOrigin> {
  const originByPackName = new Map<string, PackOrigin>();
  for (const source of sources) {
    for (const pack of source.packs) {
      if (!pack.isEnabled || originByPackName.has(pack.name)) continue;
      originByPackName.set(pack.name, { source, pack });
    }
  }
  return originByPackName;
}

function buildPanelInfoByPackName(panels: NonNullable<ReturnType<typeof packsSnapshot>>['panels']): Map<string, PackPanelInfo> {
  const panelInfoByPackName = new Map<string, PackPanelInfo>();
  for (const panel of panels) {
    const existing = panelInfoByPackName.get(panel.pack);
    if (!existing) {
      panelInfoByPackName.set(panel.pack, { hasPanel: true, iconUrl: panel.iconUrl });
      continue;
    }
    if (existing.iconUrl === null && panel.iconUrl !== null) existing.iconUrl = panel.iconUrl;
  }
  return panelInfoByPackName;
}

function nameWithVersion(packName: string, version: number | null): string {
  return version === null ? packName : `${packName} v${version}`;
}

type CardPreview = { previewDataUrl: string | null; swatches: readonly PackThemeSwatch[]; iconUrl: string | null; kinds: readonly string[] };

function themeSwatch(swatch: PackThemeSwatch): HTMLElement {
  const half = el('span', 'packs-swatch');
  half.style.background = swatch.bg;
  const lines = [{ color: swatch.accent, widthPercent: 40 }, { color: swatch.card, widthPercent: 80 }, { color: swatch.card, widthPercent: 65 }, { color: swatch.text, widthPercent: 30 }];
  half.append(...lines.map(({ color, widthPercent }) => {
    const line = el('span', 'packs-swatch-line');
    line.style.background = color;
    line.style.width = `${widthPercent}%`;
    return line;
  }));
  return half;
}

function previewContent(preview: CardPreview): HTMLElement {
  if (preview.previewDataUrl !== null) {
    const image = el('img', 'packs-preview-image');
    image.src = preview.previewDataUrl;
    image.alt = '';
    return image;
  }
  if (preview.swatches.length > 0) {
    const swatches = el('span', 'packs-preview-swatches');
    swatches.append(...preview.swatches.slice(0, MAX_PREVIEW_SWATCHES).map(themeSwatch));
    return swatches;
  }
  const glyph = el('span', 'packs-preview-glyph');
  glyph.append(preview.iconUrl === null ? createLineIcon(kindGlyphPath(preview.kinds), '1.5') : packTabIcon(preview.iconUrl, 'packs-preview-icon'));
  return glyph;
}

function cardPreview(preview: CardPreview): HTMLElement {
  const frame = el('div', 'packs-preview');
  frame.setAttribute('aria-hidden', 'true');
  frame.append(previewContent(preview));
  return frame;
}

function cardShell(packName: string, preview: CardPreview, metaText: string, chip: HTMLElement | null): { card: HTMLElement; body: HTMLElement; actions: HTMLElement } {
  const card = el('article', 'packs-card');
  const titles = el('div', 'packs-card-titles');
  const nameLine = el('div', 'packs-card-name-line');
  nameLine.append(el('h3', 'packs-card-name', packName), ...(chip === null ? [] : [chip]));
  titles.append(nameLine, el('p', 'packs-card-meta', metaText));
  const body = el('div', 'packs-card-body');
  const actions = el('div', 'packs-card-actions');
  card.append(cardPreview(preview), titles, body, actions);
  return { card, body, actions };
}

const CHIP_TEXT_BY_STATE: { readonly [State in PackRow['state']]: string | null } = { pending: 'Needs approval', approved: null, invalid: 'Problem' };

function sourceRemoveControls(statusKey: string, slug: string, packName: string): HTMLElement[] {
  const remove = button({ variant: 'secondary', size: 'small', label: 'Remove', action: 'pack-source-disable', disabled: isSourceBusy(statusKey), onClick: () => { void changeSource(statusKey, { type: 'pack-source-enable', slug, pack: packName, isEnabled: false }); } });
  return [remove, statusLine(statusKey)];
}

function installedActions(row: PackRow, origin: PackOrigin | null, hasPanel: boolean): HTMLElement[] {
  const approve = row.state === 'pending' ? [button({ variant: 'primary', size: 'small', label: 'Approve', action: 'pack-approve', onClick: () => openPackDetail(row.name) })] : [];
  const openPanel = row.state === 'approved' && hasPanel ? [button({ variant: 'secondary', size: 'small', label: 'Open panel', action: 'pack-open-panel', onClick: () => openFirstPackPanel(row.name) })] : [];
  const removeControls = origin === null ? removeFolderControls(row) : sourceRemoveControls(`${origin.source.slug}/${origin.pack.name}`, origin.source.slug, origin.pack.name);
  return [...approve, ...openPanel, ...removeControls];
}

function installedCard(row: PackRow, origin: PackOrigin | null, panelInfo: PackPanelInfo | null): HTMLElement {
  const panelIconUrl = panelInfo?.iconUrl ?? null;
  const hasPanel = panelInfo?.hasPanel ?? false;
  const originText = origin === null ? (row.isPlacedByHand ? 'Placed by hand' : null) : sourceLabel(origin.source);
  const kinds = packKindLabels({ ...row, communitySources: row.community?.sources ?? [] });
  const metaText = [...kinds, ...(originText === null ? [] : [originText])].join(' . ');
  const chipText = CHIP_TEXT_BY_STATE[row.state];
  const chip = chipText === null ? null : tag({ text: chipText, tone: row.state === 'invalid' ? 'failed' : 'warning', shape: 'pill' });
  const preview = { previewDataUrl: row.previewDataUrl, swatches: row.themes.map((theme) => theme.swatch), iconUrl: panelIconUrl, kinds };
  const { card, body, actions } = cardShell(nameWithVersion(row.name, row.version), preview, metaText, chip);
  card.dataset.packState = row.state;
  const problemText = row.errors[0] ?? (row.missingRequires.length === 0 ? null : `Missing here: ${row.missingRequires.join(', ')}`);
  if (problemText !== null) body.append(el('p', 'packs-card-problem', problemText));
  if (problemText === null && row.description) body.append(el('p', 'packs-card-description', row.description));
  actions.append(button({ variant: 'quiet', size: 'small', label: 'Details', action: 'pack-details', onClick: () => openPackDetail(row.name) }), ...installedActions(row, origin, hasPanel));
  return card;
}

function discoverCard(source: PackSourceRow, pack: PackSourceRow['packs'][number]): HTMLElement {
  const originText = pack.isEnabled ? `${sourceLabel(source)} . enabled, but its installed folder is missing` : sourceLabel(source);
  const metaText = [...pack.kinds, originText].join(' . ');
  const preview = { previewDataUrl: pack.previewDataUrl, swatches: pack.themeSwatches, iconUrl: pack.iconDataUrl, kinds: pack.kinds };
  const { card, body, actions } = cardShell(nameWithVersion(pack.name, pack.version), preview, metaText, null);
  if (pack.description) body.append(el('p', 'packs-card-description', pack.description));
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

function packsSectionHeading(title: string, count: number): HTMLElement {
  const heading = sectionHeading({ title, level: 2, count }).element;
  heading.classList.add('packs-section-heading');
  return heading;
}

function grid(cards: HTMLElement[], emptyText: string): HTMLElement {
  if (cards.length === 0) return emptyState({ text: emptyText });
  const cardGrid = el('div', 'packs-grid');
  cardGrid.append(...cards);
  return cardGrid;
}

function sourcesSection(sources: readonly PackSourceRow[]): HTMLElement {
  if (sources.some((source) => source.error !== null)) isSourcesOpen = true;
  const section = disclosure({
    summary: [el('h2', 'packs-section-title', 'Sources'), el('span', 'packs-section-count', String(sources.length))],
    body: [addSourceForm(), ...sources.map(sourceArticle)],
    open: isSourcesOpen,
    marker: 'chevron',
    onToggle: (isOpen) => { isSourcesOpen = isOpen; },
  });
  section.element.classList.add('packs-sources');
  section.summary.classList.add('packs-sources-summary');
  section.body.classList.add('packs-sources-body');
  return section.element;
}

function packsContent(): HTMLElement[] {
  const status = packsSnapshot();
  if (!status) return [el('p', 'packs-empty', 'Waiting for the server to list packs.')];
  const warnings = status.warnings.map((warning) => el('p', 'settings-view-warning', warning));
  const installedRows = status.packs.filter((row) => matchesSearch(row.name, row.description));
  const installedNames = new Set(status.packs.map((row) => row.name));
  const originByPackName = buildOriginByPackName(status.sources);
  const panelInfoByPackName = buildPanelInfoByPackName(status.panels);
  const discoverCards = status.sources.flatMap((source) => source.packs
    .filter((pack) => !installedNames.has(pack.name) && matchesSearch(pack.name, pack.description, sourceLabel(source)))
    .map((pack) => discoverCard(source, pack)));
  const installedEmptyText = status.packs.length === 0 ? 'No packs yet. Enable one under Discover, or copy a pack folder into ~/.glimmervoid/packs/.' : 'No installed pack matches.';
  return [
    ...warnings,
    packsSectionHeading('Installed', installedRows.length),
    grid(installedRows.map((row) => installedCard(row, originByPackName.get(row.name) ?? null, panelInfoByPackName.get(row.name) ?? null)), installedEmptyText),
    packsSectionHeading('Discover', discoverCards.length),
    grid(discoverCards, status.sources.length === 0 ? 'No pack sources yet. Add one under Sources.' : 'Every pack from your sources is installed.'),
    sourcesSection(status.sources),
  ];
}

function repaintPacks(): void {
  if (!packsBody?.isConnected) return;
  packsBody.replaceChildren(...packsContent());
}

watchPacksCollection(repaintPacks);

function mountPacksView(parent: HTMLElement): void {
  if (packsBody) return;
  const root = el('div', 'packs-content');
  const header = el('div', 'packs-header');
  const search = textInput({ type: 'search', size: 'small', placeholder: 'Search packs', label: 'Search packs', onInput: (value) => {
    searchText = value;
    repaintPacks();
  } });
  search.classList.add('packs-search');
  header.append(el('h1', 'packs-title', 'Packs'), el('span', 'packs-section-spacer'), search);
  packsBody = el('div', 'packs-body');
  root.append(header, el('p', 'packs-note', PACKS_TRUST_LINE), packsBody);
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
