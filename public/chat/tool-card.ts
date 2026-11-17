import { el } from '../dom-helpers.ts';
import { mountContentsDiff } from '../review/diff-view.ts';
import type { ChatPart, ChatToolOutcome } from './chat-part.ts';
import type { OutputExcerpt } from './tool-card-core.ts';

type ToolCardState = 'running' | 'ok' | 'failed' | 'no-result';

const STATUS_TEXT_BY_STATE: Record<ToolCardState, string> = {
  running: 'running',
  ok: 'ok',
  failed: 'failed',
  'no-result': 'no result',
};

function toolCardStateOf(outcome: ChatToolOutcome): ToolCardState {
  if (outcome.status === 'done') return outcome.isError ? 'failed' : 'ok';
  return outcome.status;
}

function toolLine(tag: 'div' | 'summary', name: string, mainInput: string, state: ToolCardState): HTMLElement {
  const line = el(tag, 'chat-tool-line');
  line.appendChild(el('span', 'chat-tool-name', name));
  line.appendChild(el('span', 'chat-tool-input', mainInput));
  line.appendChild(el('span', 'chat-tool-status', STATUS_TEXT_BY_STATE[state]));
  return line;
}

function excerptElement(excerpt: OutputExcerpt): HTMLElement {
  const element = el('div', 'chat-tool-excerpt');
  element.appendChild(el('div', 'chat-tool-excerpt-line', excerpt.firstLine));
  if (excerpt.hiddenLineCount > 0) element.appendChild(el('div', 'chat-tool-excerpt-gap', `+ ${excerpt.hiddenLineCount} lines`));
  if (excerpt.lastLine !== null) element.appendChild(el('div', 'chat-tool-excerpt-line', excerpt.lastLine));
  return element;
}

export function renderToolCard(part: Extract<ChatPart, { kind: 'tool' }>): HTMLElement {
  const state = toolCardStateOf(part.outcome);
  const card = el('div', 'chat-tool');
  card.dataset.state = state;
  card.appendChild(toolLine('div', part.name, part.mainInput, state));
  if (part.excerpt) card.appendChild(excerptElement(part.excerpt));
  return card;
}

export function renderEditCard(part: Extract<ChatPart, { kind: 'edit' }>): HTMLElement {
  const state = toolCardStateOf(part.outcome);
  const card = el('details', 'chat-tool chat-edit');
  card.dataset.state = state;
  card.appendChild(toolLine('summary', part.name, part.filePath, state));
  const diffHost = el('div', 'chat-edit-diff');
  card.appendChild(diffHost);
  let hasRequestedDiff = false;
  card.addEventListener('toggle', () => {
    if (!card.open || hasRequestedDiff) return;
    hasRequestedDiff = true;
    mountContentsDiff(diffHost, part.filePath, { oldContents: part.oldText, newContents: part.newText }, 'unified').catch((error: unknown) => {
      hasRequestedDiff = false;
      diffHost.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  return card;
}
