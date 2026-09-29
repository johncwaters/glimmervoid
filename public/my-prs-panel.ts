import type { MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { el, externalLink } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { createStateGlyph } from './state-glyph.ts';
import { chooseSelectedKey, emptyStateText, groupMyPrs, parseMyPrsStatus, queueNotices, readinessRows, reviewRows, stageLabel, stageTone, threadRows } from './my-prs-view-core.ts';

let root: HTMLDivElement | null = null;
let scopeTabs: HTMLElement | null = null;
let queue: HTMLElement | null = null;
let detail: HTMLElement | null = null;
let latest: MyPrsStatus | null = null;
let selectedKey: string | null = null;

function stageChip(pr: MyPr, { hasGlyph }: { hasGlyph: boolean }): HTMLElement {
  const chip = el('span', 'my-pr-stage');
  chip.dataset.tone = stageTone(pr.stage);
  if (hasGlyph) chip.append(createStateGlyph(stageTone(pr.stage)));
  chip.append(stageLabel(pr.stage));
  return chip;
}

function createShell(): void {
  if (!root || !scopeTabs || queue?.isConnected) return;
  const shell = createPrQueueColumns({
    queueLabel: 'My pull requests',
    scopeTabs,
    resizerLabel: 'Resize pull request list',
  });
  queue = shell.queue;
  detail = shell.detail;
  root.replaceChildren(shell.columns);
}

function renderDetail(pr: MyPr | undefined): void {
  if (!detail) return;
  if (!pr) {
    detail.replaceChildren(el('p', 'pr-empty', emptyStateText(latest)));
    return;
  }
  const content = el('article', 'pr-detail');
  const heading = el('div', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(externalLink('pr-link', pr.key, pr.url), el('h2', null, pr.title));
  heading.append(title, stageChip(pr, { hasGlyph: true }));
  content.append(heading);
  const readiness = readinessRows(pr, latest?.viewer ?? null);
  if (readiness.length > 0) {
    const section = el('section', 'pr-readiness-section');
    section.append(el('h3', 'pr-section-heading', 'Merge readiness'));
    const list = el('ul', 'pr-readiness');
    for (const readinessRow of readiness) {
      const item = el('li', 'pr-readiness-row');
      item.append(createStateGlyph(readinessRow.tone), el('span', 'pr-readiness-label', readinessRow.label), el('span', 'pr-readiness-value', readinessRow.text));
      list.append(item);
    }
    section.append(list);
    content.append(section);
  }
  if (pr.checks.failing.length > 0) {
    const failed = el('section', 'my-pr-failures');
    failed.append(el('h3', 'pr-section-heading', 'Failing checks'));
    const list = el('ul', 'my-pr-facts');
    for (const name of pr.checks.failing) list.append(el('li', null, name));
    failed.append(list);
    content.append(failed);
  }
  const reviews = reviewRows(pr);
  if (reviews.length > 0) {
    const section = el('section', 'pr-readiness-section');
    section.append(el('h3', 'pr-section-heading', 'Reviews'));
    const list = el('ul', 'pr-readiness');
    for (const review of reviews) {
      const item = el('li', 'pr-readiness-row');
      const submittedAtMs = Date.parse(review.submittedAt ?? '');
      const when = Number.isFinite(submittedAtMs) ? `${review.text} ${formatAgo(submittedAtMs)}` : review.text;
      item.append(createStateGlyph(review.tone), el('span', 'pr-readiness-value', review.reviewer), el('span', 'pr-readiness-value', when));
      list.append(item);
    }
    section.append(list);
    content.append(section);
  }
  const threads = threadRows(pr, latest?.viewer ?? null);
  if (threads.length > 0) {
    const section = el('section', 'my-pr-threads-section');
    section.append(el('h3', 'pr-section-heading', 'Unresolved threads'));
    const list = el('ul', 'my-pr-threads');
    for (const thread of threads) {
      const item = el('li', 'my-pr-thread');
      const heading = el('div', 'my-pr-thread-heading');
      heading.append(externalLink('my-pr-thread-location', thread.location, thread.url));
      if (thread.waiting) {
        const badge = el('span', 'my-pr-stage');
        badge.dataset.tone = thread.waiting.tone;
        badge.append(createStateGlyph(thread.waiting.tone), thread.waiting.text);
        heading.append(badge);
      }
      const excerpt = el('p', 'my-pr-thread-excerpt');
      excerpt.append(el('strong', null, thread.author), ` ${thread.excerpt}`);
      const activity = Date.parse(thread.lastActivityAt);
      const meta = el('p', 'my-pr-thread-meta', Number.isFinite(activity) ? `${thread.replySummary}, ${formatAgo(activity)}` : thread.replySummary);
      item.append(heading, excerpt, meta);
      list.append(item);
    }
    section.append(list);
    content.append(section);
  }
  const time = el('p', 'pr-detail-meta');
  time.append(el('span', null, `Opened ${formatAgo(Date.parse(pr.createdAt))}`), el('span', null, `${pr.state === 'MERGED' ? 'Merged' : 'Updated'} ${formatAgo(Date.parse(pr.state === 'MERGED' ? pr.mergedAt ?? '' : pr.updatedAt))}`));
  content.append(time);
  detail.replaceChildren(content);
}

function render(): void {
  createShell();
  if (!queue) return;
  const sections = groupMyPrs(latest?.prs ?? []);
  selectedKey = chooseSelectedKey(sections, selectedKey);
  const focusedKey = document.activeElement instanceof HTMLElement && queue.contains(document.activeElement) ? document.activeElement.dataset.prKey : null;
  const sectionElements = sections.filter((section) => section.prs.length > 0).map((section) => {
    const sectionElement = el('section', 'pr-queue-section');
    sectionElement.append(el('h3', 'pr-section-heading', `${section.title} ${section.prs.length}`));
    for (const pr of section.prs) {
      const row = el('button', 'pr-queue-row');
      row.type = 'button';
      row.dataset.prKey = pr.key;
      row.setAttribute('aria-current', String(pr.key === selectedKey));
      row.title = `${pr.key}: ${stageLabel(pr.stage)}`;
      const glyph = el('span', 'pr-queue-glyph');
      glyph.append(createStateGlyph(stageTone(pr.stage)));
      const top = el('span', 'pr-queue-top');
      top.append(el('strong', 'pr-queue-ref', pr.key), el('span', 'pr-queue-title', pr.title));
      const bottom = el('span', 'pr-queue-bottom');
      bottom.append(stageChip(pr, { hasGlyph: false }), el('span', 'pr-queue-elapsed', `opened ${formatAgo(Date.parse(pr.createdAt))}`));
      row.append(glyph, top, bottom);
      row.addEventListener('click', () => {
        selectedKey = pr.key;
        for (const button of queue?.querySelectorAll<HTMLButtonElement>('button[data-pr-key]') ?? []) button.setAttribute('aria-current', String(button.dataset.prKey === selectedKey));
        renderDetail(pr);
        if (document.documentElement.dataset.layout === 'phone') detail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      sectionElement.append(row);
    }
    return sectionElement;
  });
  if (sectionElements.length === 0) queue.replaceChildren(el('p', 'pr-empty', emptyStateText(latest)));
  if (sectionElements.length > 0) {
    const noticeElements = queueNotices(latest).map((notice) => el('p', notice.tone === 'error' ? 'my-pr-error' : 'my-pr-note', notice.text));
    queue.replaceChildren(...noticeElements, ...sectionElements);
  }
  if (focusedKey) [...queue.querySelectorAll<HTMLButtonElement>('button[data-pr-key]')].find((row) => row.dataset.prKey === focusedKey)?.focus({ preventScroll: true });
  renderDetail(sections.flatMap((section) => section.prs).find((pr) => pr.key === selectedKey));
}

export function mountMyPrsView(parent: HTMLElement, tabs: HTMLElement): HTMLDivElement {
  if (root) return root;
  scopeTabs = tabs;
  root = el('div', 'pr-content');
  parent.append(root);
  render();
  return root;
}

export function applyMyPrsStatus(message: unknown): void {
  const parsed = parseMyPrsStatus(message);
  if (!parsed) return;
  latest = parsed;
  render();
}
