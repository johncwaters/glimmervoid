import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { holdCardKeys, markCardKeys, releaseCardKeys } from './chat-cards.ts';
import type { DoneLine, DonePanelModel } from './done-panel-core.ts';

interface DonePanel {
  readonly element: HTMLElement;
  show(model: DonePanelModel | null): void;
}

const SEND_BACK_KEY = 'Enter';
const ACCEPT_KEY = '2';

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
  head.append(el('span', 'chat-done-title', 'Done means'), el('span', 'chat-done-count', `${model.metCount} of ${model.lines.length} met`));
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

export function createDonePanel(handlers: { onSendBack(): void; onAccept(): void; onAllowCommands(commands: readonly string[]): void }): DonePanel {
  const element = el('section', 'chat-done');
  element.setAttribute('aria-label', 'Done means');
  element.tabIndex = -1;
  element.hidden = true;
  let shownVerdict: string | null = null;
  let hasAnsweredVerdict = false;

  const answerVerdict = (sendAnswer: () => void) => {
    hasAnsweredVerdict = true;
    element.querySelector('.chat-done-foot')?.remove();
    releaseCardKeys(element);
    sendAnswer();
  };

  const footOf = (verdictText: string, hasFailedLine: boolean): HTMLElement => {
    const actions = el('span', 'chat-done-actions');
    if (hasFailedLine) {
      const sendBackButton = button({ variant: 'primary', size: 'small', textCase: 'sentence', label: 'Send back', shortcutKey: SEND_BACK_KEY, onClick: () => answerVerdict(handlers.onSendBack) });
      markCardKeys(sendBackButton, [SEND_BACK_KEY]);
      actions.append(sendBackButton);
    }
    const acceptButton = button({ variant: 'secondary', size: 'small', textCase: 'sentence', label: 'Accept', shortcutKey: ACCEPT_KEY, onClick: () => answerVerdict(handlers.onAccept) });
    markCardKeys(acceptButton, [ACCEPT_KEY]);
    actions.append(acceptButton);
    const foot = el('div', 'chat-done-foot');
    foot.append(el('span', 'chat-done-verdict', verdictText), actions);
    return foot;
  };

  const show = (model: DonePanelModel | null) => {
    element.hidden = model === null;
    if (model === null || model.verdict === null) {
      shownVerdict = null;
      hasAnsweredVerdict = false;
      releaseCardKeys(element);
    }
    if (model === null) return;
    const parts = [headOf(model), linesOf(model)];
    if (model.waitingCommands.length > 0) parts.push(allowBarOf(model.waitingCommands, handlers.onAllowCommands));
    const hasFailedLine = model.lines.some((line) => line.status === 'failed');
    if (model.verdict !== null && !hasAnsweredVerdict) parts.push(footOf(model.verdict, hasFailedLine));
    element.replaceChildren(...parts);
    if (model.verdict !== null && shownVerdict === null) holdCardKeys(element);
    shownVerdict = model.verdict;
  };
  return { element, show };
}
