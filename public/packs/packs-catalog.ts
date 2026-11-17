import type { PackRow, PackSourceRow, PackThemeSwatch } from '#shared/contracts/control/pack-messages.ts';
import { packKindLabels } from '#shared/pack-approval.ts';
import { paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { createLineIcon, TERMINAL_ICON_PATH } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { tag } from '../ui/tag.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { openPackDetail } from './pack-approval-content.ts';
import { openFirstPackPanel, packTabIcon } from './pack-views.ts';
import { PACKS_TAB_HASH, packsSnapshot, subscribePacks } from './packs-store.ts';
import './packs-catalog.css';

const PACKS_TRUST_LINE = 'An approved pack runs its commands on this machine; any change to its files asks again.';
const SOURCE_REPLY_TIMEOUT_MS = 5 * 60_000;
const THEME_GLYPH_PATH = 'M8 2.5a5.5 5.5 0 1 0 0 11z M8 2.5a5.5 5.5 0 0 1 0 11';
const PANEL_GLYPH_PATH = 'M2.5 3.5h11v9h-11z M2.5 6h11 M6 6v6.5';
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

function nameWithVersion(packName: string, version: number | null): string {
  return version === null ? packName : `${packName} v${version}`;
}

type CardPreview = { previewDataUrl: string | null; swatches: readonly PackThemeSwatch[]; iconUrl: string | null; kinds: readonly string[] };

function kindGlyphPath(kinds: readonly string[]): string {
  if (kinds.includes('Panel')) return PANEL_GLYPH_PATH;
  if (kinds.some((kind) => kind.endsWith('theme') || kind.endsWith('themes'))) return THEME_GLYPH_PATH;
  return TERMINAL_ICON_PATH;
}

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
  const kinds = packKindLabels(row);
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
  if (cards.length === 0) return el('p', 'packs-empty', emptyText);
  const cardGrid = el('div', 'packs-grid');
  cardGrid.append(...cards);
  return cardGrid;
}

function sourcesSection(sources: readonly PackSourceRow[]): HTMLElement {
  if (sources.some((source) => source.error !== null)) isSourcesOpen = true;
  const section = el('details', 'packs-sources');
  section.open = isSourcesOpen;
  section.addEventListener('toggle', () => { isSourcesOpen = section.open; });
  const summary = el('summary', 'packs-sources-summary');
  summary.append(el('h2', 'packs-section-title', 'Sources'), el('span', 'packs-section-count', String(sources.length)));
  const sourcesBody = el('div', 'packs-sources-body');
  sourcesBody.append(addSourceForm(), ...sources.map(sourceArticle));
  section.append(summary, sourcesBody);
  return section;
}

function packsContent(): HTMLElement[] {
  const status = packsSnapshot();
  if (!status) return [el('p', 'packs-empty', 'Waiting for the server to list packs.')];
  const warnings = status.warnings.map((warning) => el('p', 'settings-view-warning', warning));
  const installedRows = status.packs.filter((row) => matchesSearch(row.name, row.description));
  const installedNames = new Set(status.packs.map((row) => row.name));
  const discoverCards = status.sources.flatMap((source) => source.packs
    .filter((pack) => !installedNames.has(pack.name) && matchesSearch(pack.name, pack.description, sourceLabel(source)))
    .map((pack) => discoverCard(source, pack)));
  const installedEmptyText = status.packs.length === 0 ? 'No packs yet. Enable one under Discover, or copy a pack folder into ~/.glimmervoid/packs/.' : 'No installed pack matches.';
  return [
    ...warnings,
    packsSectionHeading('Installed', installedRows.length),
    grid(installedRows.map((row) => installedCard(row, status)), installedEmptyText),
    packsSectionHeading('Discover', discoverCards.length),
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
