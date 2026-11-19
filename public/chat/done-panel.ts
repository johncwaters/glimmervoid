import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { questionCardOf } from './chat-cards.ts';
import type { DoneLine, DonePanelModel } from './done-panel-core.ts';

interface DonePanel {
  readonly element: HTMLElement;
  show(model: DonePanelModel | null): void;
}

const DONE_LABEL = 'Done, land it';
const NOT_DONE_LABEL = 'Not done';

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

function allowBarOf(waitingCommands: readonly string[], onAllowCommands: (commands: readonly string[]) => void): HTMLElement {
  const bar = el('div', 'chat-done-allow');
  const commandCount = waitingCommands.length;
  const note = `The agent asks Glimmervoid to run ${commandCount === 1 ? 'this command' : `these ${commandCount} commands`} in the worktree at each turn end. Allowed commands run until the agent changes them or Glimmervoid restarts.`;
  const allowButton = button({ variant: 'secondary', size: 'small', textCase: 'sentence', label: 'Allow commands', onClick: () => onAllowCommands(waitingCommands) });
  bar.append(el('span', 'chat-done-allow-note', note), allowButton);
  return bar;
}

function verdictOptionsOf(hasFailedLine: boolean): { label: string; note: string }[] {
  return [
    { label: DONE_LABEL, note: 'Tells the agent to land the work' },
    { label: NOT_DONE_LABEL, note: hasFailedLine ? 'Sends the failed lines and their output to the agent' : 'Type what is missing in the message box' },
  ];
}

export function createDonePanel(handlers: { onNotDone(): void; onDone(): void; onAllowCommands(commands: readonly string[]): void }): DonePanel {
  const element = el('section', 'chat-done');
  element.setAttribute('aria-label', 'Checked at turn end');
  element.hidden = true;
  let shownModel: DonePanelModel | null = null;
  let answeredLabel: string | null = null;
  let verdictCard: { key: string; element: HTMLElement } | null = null;

  const verdictCardOf = (verdictText: string, hasFailedLine: boolean): HTMLElement => {
    const key = JSON.stringify([verdictText, hasFailedLine, answeredLabel]);
    if (verdictCard?.key === key) return verdictCard.element;
    const question = { cardType: 'done-verdict', heading: verdictText, detail: '', options: verdictOptionsOf(hasFailedLine), answer: answeredLabel };
    const card = questionCardOf(question, (label) => {
      answeredLabel = label;
      show(shownModel);
      if (label === NOT_DONE_LABEL) {
        handlers.onNotDone();
        return;
      }
      handlers.onDone();
    });
    verdictCard = { key, element: card };
    return card;
  };

  const show = (model: DonePanelModel | null) => {
    element.hidden = model === null;
    if (model === null || model.verdict === null) {
      answeredLabel = null;
      verdictCard = null;
    }
    shownModel = model;
    if (model === null) {
      element.replaceChildren();
      return;
    }
    const parts = [headOf(model), linesOf(model)];
    if (model.waitingCommands.length > 0) parts.push(allowBarOf(model.waitingCommands, handlers.onAllowCommands));
    const hasFailedLine = model.lines.some((line) => line.status === 'failed');
    if (model.verdict !== null) parts.push(verdictCardOf(model.verdict, hasFailedLine));
    element.replaceChildren(...parts);
  };
  return { element, show };
}
