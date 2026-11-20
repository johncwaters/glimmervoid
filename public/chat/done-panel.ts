import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { donePillOf } from './done-panel-core.ts';
import type { DoneLine, DonePanelModel } from './done-panel-core.ts';
import type { TurnEnd } from './chat-parts.ts';

interface DonePanel {
  show(model: DonePanelModel | null): void;
}

type SettledModel = Extract<DonePanelModel, { kind: 'settled' }>;

let donePanelCount = 0;

function lineRowOf(line: DoneLine): HTMLElement {
  const row = el('div', 'chat-done-line');
  row.setAttribute('role', 'listitem');
  row.dataset.status = line.status;
  row.append(el('span', 'chat-done-mark'), el('span', 'chat-done-text', line.text), el('span', 'chat-done-proof', line.proof));
  if (line.command !== '') row.append(el('code', 'chat-done-command', line.command));
  if (line.evidence !== '') row.append(el('pre', 'chat-done-evidence', line.evidence));
  return row;
}

function passedRowOf(passedLines: readonly DoneLine[]): HTMLElement {
  const row = el('div', 'chat-done-passed');
  row.setAttribute('role', 'listitem');
  row.append(el('span', 'chat-done-mark'), el('span', 'chat-done-passed-text', `Also passed: ${passedLines.map((line) => line.text).join(', ')}`));
  return row;
}

function listRowsOf(model: SettledModel): HTMLElement[] {
  const rows = [...model.failedLines, ...model.skippedLines].map(lineRowOf);
  if (model.passedLines.length === 0) return rows;
  return [...rows, passedRowOf(model.passedLines)];
}

export function createDonePanel(placeTurnEnd: (turnEnd: TurnEnd | null) => void): DonePanel {
  donePanelCount += 1;
  const pill = createPressable('chat-done-pill');
  const pillMark = el('span', 'chat-done-mark');
  const pillText = el('span', 'chat-done-pill-text');
  pill.append(pillMark, pillText);
  const list = el('div', 'chat-done-list');
  list.id = `chat-done-list-${donePanelCount}`;
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Checked at turn end');
  pill.setAttribute('aria-controls', list.id);
  let openRunKey: string | null = null;
  let shownModel: DonePanelModel | null = null;
  let shownModelJson = '';
  const showOpenState = () => {
    const isOpen = shownModel?.kind === 'settled' && openRunKey === shownModel.runKey;
    pill.setAttribute('aria-expanded', String(isOpen));
    list.hidden = !isOpen;
  };
  pill.addEventListener('click', (event) => {
    event.stopPropagation();
    if (shownModel?.kind !== 'settled') return;
    openRunKey = openRunKey === shownModel.runKey ? null : shownModel.runKey;
    showOpenState();
  });
  const show = (model: DonePanelModel | null) => {
    const modelJson = JSON.stringify(model);
    if (modelJson === shownModelJson) return;
    shownModelJson = modelJson;
    shownModel = model;
    if (model === null) {
      list.replaceChildren();
      placeTurnEnd(null);
      return;
    }
    const { tone, text } = donePillOf(model);
    pill.dataset.tone = tone;
    pill.disabled = model.kind === 'running';
    pillText.textContent = text;
    list.replaceChildren(...(model.kind === 'settled' ? listRowsOf(model) : []));
    showOpenState();
    placeTurnEnd({ pill, list });
  };
  return { show };
}
