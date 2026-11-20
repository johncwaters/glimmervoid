import { el } from '../dom-helpers.ts';
import { disclosure } from '../ui/disclosure.ts';
import { failedCountText, foldedSummaryText, settledSummaryText } from './done-panel-core.ts';
import type { DoneLine, DonePanelModel } from './done-panel-core.ts';

interface DonePanel {
  readonly element: HTMLElement;
  show(model: DonePanelModel | null): void;
}

type SettledModel = Extract<DonePanelModel, { kind: 'settled' }>;

function lineRowOf(line: DoneLine): HTMLElement {
  const row = el('div', 'chat-done-line');
  row.setAttribute('role', 'listitem');
  row.dataset.status = line.status;
  row.append(el('span', 'chat-done-mark'), el('span', 'chat-done-text', line.text));
  if (line.status !== 'passed') row.append(el('span', 'chat-done-proof', line.proof));
  if (line.command !== '') row.append(el('code', 'chat-done-command', line.command));
  if (line.evidence !== '') row.append(el('pre', 'chat-done-evidence', line.evidence));
  return row;
}

function linesOf(lines: readonly DoneLine[]): HTMLElement {
  const list = el('div', 'chat-done-lines');
  list.setAttribute('role', 'list');
  list.append(...lines.map(lineRowOf));
  return list;
}

function summaryRowOf(status: string, ...texts: HTMLElement[]): HTMLElement[] {
  const mark = el('span', 'chat-done-mark');
  mark.dataset.status = status;
  return [mark, ...texts];
}

function runningRowOf(): HTMLElement {
  const row = el('div', 'chat-done-summary');
  row.append(...summaryRowOf('running', el('span', 'chat-done-summary-text', 'Running checks')));
  return row;
}

function foldOf(summary: HTMLElement[], lines: readonly DoneLine[], isOpen: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const fold = disclosure({ summary: [...summary, el('span', 'chat-done-details', 'Details')], body: () => linesOf(lines), open: isOpen, marker: 'chevron', onToggle });
  fold.element.classList.add('chat-done-fold');
  return fold.element;
}

function headOf(model: SettledModel): HTMLElement {
  const head = el('div', 'chat-done-head');
  head.append(el('span', 'chat-done-title', 'Checked at turn end'), el('span', 'chat-done-count', failedCountText(model)));
  return head;
}

function settledChildrenOf(model: SettledModel, isOpen: boolean, onToggle: (open: boolean) => void): HTMLElement[] {
  if (model.failedLines.length === 0) {
    const summary = summaryRowOf(model.passedCount > 0 ? 'passed' : 'not-checked', el('span', 'chat-done-summary-text', settledSummaryText(model)), el('span', 'chat-done-summary-note', 'at turn end'));
    return [foldOf(summary, model.foldedLines, isOpen, onToggle)];
  }
  const children = [headOf(model), linesOf(model.failedLines)];
  if (model.foldedLines.length === 0) return children;
  const summary = summaryRowOf(model.passedCount > 0 ? 'passed' : 'not-checked', el('span', 'chat-done-summary-note', foldedSummaryText(model)));
  return [...children, foldOf(summary, model.foldedLines, isOpen, onToggle)];
}

export function createDonePanel(): DonePanel {
  const element = el('section', 'chat-done');
  element.setAttribute('aria-label', 'Checked at turn end');
  element.hidden = true;
  let openRunKey: string | null = null;
  let shownModelJson = '';
  const show = (model: DonePanelModel | null) => {
    const modelJson = JSON.stringify(model);
    if (modelJson === shownModelJson) return;
    shownModelJson = modelJson;
    element.hidden = model === null;
    if (model === null) {
      element.replaceChildren();
      return;
    }
    element.dataset.state = model.kind === 'running' ? 'running' : model.failedLines.length > 0 ? 'failed' : 'passed';
    if (model.kind === 'running') {
      element.replaceChildren(runningRowOf());
      return;
    }
    const onToggle = (open: boolean) => {
      openRunKey = open ? model.runKey : null;
    };
    element.replaceChildren(...settledChildrenOf(model, openRunKey === model.runKey, onToggle));
  };
  return { element, show };
}
