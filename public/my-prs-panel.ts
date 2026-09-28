import type { MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { el, externalLink } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createPrQueueColumns } from './pr-queue-columns.ts';
import { chooseSelectedKey, emptyStateText, factLines, groupMyPrs, parseMyPrsStatus, stageLabel, stageTone } from './my-prs-view-core.ts';

let root: HTMLDivElement | null = null;
let queue: HTMLElement | null = null;
let detail: HTMLElement | null = null;
let latest: MyPrsStatus | null = null;
let selectedKey: string | null = null;

function stageChip(pr: MyPr): HTMLElement {
  const chip = el('span', 'my-pr-stage', stageLabel(pr.stage));
  chip.dataset.tone = stageTone(pr.stage);
  return chip;
}

function createShell(): void {
  if (!root || queue?.isConnected) return;
  const shell = createPrQueueColumns({
    queueLabel: 'My pull requests',
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
  heading.append(title, stageChip(pr));
  content.append(heading);
  const facts = el('ul', 'my-pr-facts');
  for (const line of factLines(pr)) facts.append(el('li', null, line));
  content.append(facts);
  if (pr.checks.failing.length > 0) {
    const failed = el('section', 'my-pr-failures');
    failed.append(el('h3', 'pr-section-heading', 'Failing checks'));
    const list = el('ul', 'my-pr-facts');
    for (const name of pr.checks.failing) list.append(el('li', null, name));
    failed.append(list);
    content.append(failed);
  }
  const time = el('p', 'pr-detail-meta', `${pr.state === 'MERGED' ? 'Merged' : 'Updated'} ${formatAgo(Date.parse(pr.state === 'MERGED' ? pr.mergedAt ?? '' : pr.updatedAt))}`);
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
      const top = el('span', 'pr-queue-top');
      top.append(el('strong', 'pr-queue-ref', pr.key), el('span', 'pr-queue-title', pr.title));
      const bottom = el('span', 'pr-queue-bottom');
      bottom.append(stageChip(pr));
      row.append(top, bottom);
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
    const errorNotice = latest?.error ? el('p', 'my-pr-error', emptyStateText(latest)) : null;
    queue.replaceChildren(...(errorNotice ? [errorNotice, ...sectionElements] : sectionElements));
  }
  if (focusedKey) [...queue.querySelectorAll<HTMLButtonElement>('button[data-pr-key]')].find((row) => row.dataset.prKey === focusedKey)?.focus({ preventScroll: true });
  renderDetail(sections.flatMap((section) => section.prs).find((pr) => pr.key === selectedKey));
}

export function mountMyPrsView(parent: HTMLElement): HTMLDivElement {
  if (root) return root;
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
