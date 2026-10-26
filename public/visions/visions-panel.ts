import { createActionStatus } from '../action-status.ts';
import { el, isPanelHidden } from '../dom-helpers.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { setVisionsLookingProbe, subscribeVisions, visionsSnapshot } from './visions-store.ts';
import type { VisionsChange } from './visions-store.ts';
import {
  INGEST_EMPTY_TEXT,
  VISIONS_EMPTY_TEXT,
  VISIONS_FIXES_EMPTY_TEXT,
  activityAgeText,
  activityCountText,
  activityOverflowText,
  activityScopeText,
  activitySourceLabel,
  basenameOfUri,
  commentLineLabel,
  findingLineLabel,
  fixCountText,
  fixLineLabel,
  fixOutcomeText,
  intentRows,
  visionsHandText,
  visionsSections,
  sectionCountText,
} from './visions-view-core.ts';
import type { ActivityEvent, IntentRow, VisionsComment, VisionsFinding, VisionsFixEntry, VisionsSection } from './visions-view-core.ts';

let _root: HTMLDivElement | null = null;
let _feed: HTMLDivElement | null = null;
let _intentUI: { list: HTMLDivElement } | null = null;
let _activityUI: { count: HTMLSpanElement; list: HTMLDivElement; overflow: HTMLParagraphElement } | null = null;
let _fixUI: { count: HTMLSpanElement; list: HTMLDivElement } | null = null;

function buildIntentBlock() {
  const section = el('section', 'visions-intent');
  section.append(el('h2', 'visions-intent-title', 'Intent'));
  const list = el('div', 'visions-intent-list');
  section.append(list);
  _intentUI = { list };
  return section;
}

function buildIntentRow(row: IntentRow) {
  const item = el('div', 'visions-intent-item');
  const head = el('div', 'visions-intent-head');

  head.append(el('span', 'visions-intent-scope', row.label), el('span', 'visions-intent-meta', row.meta));
  const statement = el('p', 'visions-intent-text', row.text);
  statement.classList.toggle('visions-intent-none', !row.hasText);
  item.classList.toggle('visions-intent-active', row.active === true);
  item.append(head, statement);
  return item;
}

function renderIntent() {
  if (!_intentUI) return;
  const { intent, projectNamesById } = visionsSnapshot();
  _intentUI.list.replaceChildren(...intentRows(intent, projectNamesById).map(buildIntentRow));
}

function buildSection(section: VisionsSection) {
  const wrap = el('section', 'visions-doc');
  const head = el('div', 'visions-doc-head');

  const name = el('h2', 'visions-doc-name');
  name.textContent = section.name;
  name.title = section.uri;
  head.append(name, el('span', 'visions-doc-count', sectionCountText(section)));
  wrap.append(head);

  if (section.hand) wrap.append(buildHandBanner(section.hand));
  if (section.findings.length > 0) {
    const list = el('div', 'visions-findings');
    for (const finding of section.findings) list.append(buildFindingRow(finding));
    wrap.append(list);
  }
  if (section.comments.length > 0) {
    const cards = el('div', 'visions-comments');
    for (const comment of section.comments) cards.append(buildCommentCard(comment));
    wrap.append(cards);
  }
  return wrap;
}

function buildHandBanner(hand: string) {
  const banner = el('div', 'visions-hand');
  banner.textContent = visionsHandText(hand);
  return banner;
}

function buildCommentCard(comment: VisionsComment) {
  const card = el('div', 'visions-comment');
  const head = el('div', 'visions-comment-head');
  head.append(el('span', 'visions-comment-chip', 'visions'));
  head.append(el('span', 'visions-comment-line', commentLineLabel(comment)));
  card.append(head);

  const message = el('p', 'visions-comment-message');
  message.textContent = comment?.message == null ? '' : String(comment.message);
  card.append(message);
  return card;
}

function buildFindingRow(finding: VisionsFinding) {
  const row = el('div', 'visions-finding');
  row.append(el('span', 'visions-finding-line', findingLineLabel(finding)));
  const code = finding?.code == null ? '' : String(finding.code);
  if (code) row.append(el('span', 'visions-finding-code', code));

  const message = el('span', 'visions-finding-message');
  message.textContent = finding?.message == null ? '' : String(finding.message);
  row.append(message);
  return row;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_feed) return;
  if (!force && isPanelHidden(_root)) return;
  _feed.textContent = '';
  const { findingsByUri, commentsByUri, handsByUri, isEnabled } = visionsSnapshot();
  const sections = visionsSections(findingsByUri, commentsByUri, handsByUri);

  if (sections.length === 0) {
    const empty = el('p', 'visions-empty', VISIONS_EMPTY_TEXT);
    if (isEnabled === false) {
      const link = createSettingsLink('lanes-visions', 'visions-enabled', 'Enable Visions');
      empty.append(document.createTextNode(' '), link);
    }
    _feed.append(empty);
    return;
  }
  for (const section of sections) _feed.append(buildSection(section));
}

function buildActivityBlock() {
  const section = el('section', 'visions-activity');
  const head = el('div', 'visions-activity-head');
  head.append(el('h2', 'visions-activity-title', 'Activity'));
  const count = el('span', 'visions-activity-count');
  head.append(count);
  section.append(head);
  const list = el('div', 'visions-activity-list');
  section.append(list);
  const overflow = el('p', 'visions-activity-overflow');
  section.append(overflow);
  _activityUI = { count, list, overflow };
  return section;
}

function buildActivityRow(event: ActivityEvent, now: number) {
  const row = el('div', 'visions-activity-row');
  row.append(el('span', 'visions-activity-source', activitySourceLabel(event.source)));
  row.append(el('span', 'visions-activity-age', activityAgeText(event.ts, now)));
  row.append(el('span', 'visions-activity-scope', activityScopeText(event)));

  const summary = el('span', 'visions-activity-summary');
  summary.textContent = event.summary;
  row.append(summary);
  return row;
}

function renderActivity({ force = false }: { force?: boolean } = {}) {
  if (!_activityUI) return;
  if (!force && isPanelHidden(_root)) return;
  const { count, list, overflow } = _activityUI;
  const { activityEvents, activityOverflow } = visionsSnapshot();
  count.textContent = activityCountText(activityEvents.length);
  list.textContent = '';
  if (activityEvents.length === 0) {
    list.append(el('p', 'visions-empty', INGEST_EMPTY_TEXT));
    overflow.textContent = '';
    return;
  }
  const now = Date.now();
  for (const event of activityEvents) list.append(buildActivityRow(event, now));
  overflow.textContent = activityOverflowText(activityOverflow);
}

function buildFixesBlock() {
  const section = el('section', 'visions-fixes');
  const head = el('div', 'visions-fixes-head');
  head.append(el('h2', 'visions-fixes-title', 'Fixes'));
  const count = el('span', 'visions-fixes-count');
  head.append(count);
  section.append(head);
  const list = el('div', 'visions-fixes-list');
  section.append(list);
  _fixUI = { count, list };
  return section;
}

function buildFixRow(entry: VisionsFixEntry) {
  const row = el('div', 'visions-fix-row');
  row.dataset.applied = entry.applied ? 'yes' : 'no';

  const file = el('span', 'visions-fix-file');
  file.textContent = basenameOfUri(entry.uri) || entry.uri;
  file.title = entry.uri;
  row.append(file);
  row.append(el('span', 'visions-fix-line', fixLineLabel(entry)));
  row.append(el('span', 'visions-fix-outcome', fixOutcomeText(entry)));
  row.append(el('span', 'visions-fix-code', entry.code || ''));

  const message = el('span', 'visions-fix-message');
  message.textContent = entry.message;
  row.append(message);
  return row;
}

function renderFixes({ force = false }: { force?: boolean } = {}) {
  if (!_fixUI) return;
  if (!force && isPanelHidden(_root)) return;
  const { count, list } = _fixUI;
  const { fixEntries } = visionsSnapshot();
  count.textContent = fixCountText(fixEntries.length);
  list.textContent = '';
  if (fixEntries.length === 0) {
    list.append(el('p', 'visions-empty', VISIONS_FIXES_EMPTY_TEXT));
    return;
  }
  for (const entry of fixEntries) list.append(buildFixRow(entry));
}

const _connectionStatus = createActionStatus('visions-connection-status');

function renderConnection() {
  if (visionsSnapshot().isConnected) {
    _connectionStatus.clear();
    return;
  }
  _connectionStatus.show('error', `${NOT_CONNECTED_TEXT} What you see below is from before the connection dropped.`);
}

const RENDER_BY_CHANGE: Record<VisionsChange, () => void> = {
  intent: renderIntent,
  feed: () => render(),
  fixes: () => renderFixes(),
  activity: () => renderActivity(),
  connection: renderConnection,
};

function refreshVisionsView() {
  renderIntent();
  render({ force: true });
  renderFixes({ force: true });
  renderActivity({ force: true });
}

function mountVisionsView(parent: HTMLElement) {
  if (_root) return;
  const root = el('div', 'visions-content');
  root.append(_connectionStatus.element, buildIntentBlock());
  const feed = el('div', 'visions-feed');
  root.append(feed);
  root.append(buildFixesBlock());
  root.append(buildActivityBlock());
  parent.appendChild(root);
  _root = root;
  _feed = feed;
  setVisionsLookingProbe(() => !isPanelHidden(_root));
  subscribeVisions((changes) => {
    for (const change of changes) RENDER_BY_CHANGE[change]();
  });
  renderConnection();
  refreshVisionsView();
}

export const view: ViewModule<HTMLElement> = { mount: mountVisionsView, refresh: refreshVisionsView };
