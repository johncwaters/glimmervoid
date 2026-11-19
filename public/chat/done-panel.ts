import { el } from '../dom-helpers.ts';
import type { DoneLine, DonePanelModel } from './done-panel-core.ts';

interface DonePanel {
  readonly element: HTMLElement;
  show(model: DonePanelModel | null): void;
}

function lineRowOf(line: DoneLine): HTMLElement {
  const row = el('div', 'chat-done-line');
  row.setAttribute('role', 'listitem');
  row.dataset.status = line.status;
  const proof = el('span', 'chat-done-proof', line.proof);
  if (line.isGlimmervoidRan) proof.append(el('span', 'chat-done-provenance', 'Glimmervoid ran'));
  if (line.isFromAgent) {
    const agentProvenance = el('span', 'chat-done-provenance', 'From the agent');
    agentProvenance.dataset.source = 'agent';
    proof.append(agentProvenance);
  }
  row.append(el('span', 'chat-done-mark'), el('span', 'chat-done-text', line.text), proof);
  if (line.command !== '') row.append(el('code', 'chat-done-command', line.command));
  if (line.evidence !== '') row.append(el('pre', 'chat-done-evidence', line.evidence));
  return row;
}

function headOf(model: DonePanelModel): HTMLElement {
  const head = el('div', 'chat-done-head');
  head.append(el('span', 'chat-done-title', 'Checked at turn end'), el('span', 'chat-done-count', `${model.metCount} of ${model.lines.length} passed`));
  return head;
}

function linesOf(model: DonePanelModel): HTMLElement {
  const list = el('div', 'chat-done-lines');
  list.setAttribute('role', 'list');
  list.append(...model.lines.map(lineRowOf));
  return list;
}

export function createDonePanel(): DonePanel {
  const element = el('section', 'chat-done');
  element.setAttribute('aria-label', 'Checked at turn end');
  element.hidden = true;
  const show = (model: DonePanelModel | null) => {
    element.hidden = model === null;
    if (model === null) {
      element.replaceChildren();
      return;
    }
    element.replaceChildren(headOf(model), linesOf(model));
  };
  return { element, show };
}
