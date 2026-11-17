import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { replyParagraphsOf } from './chat-parts-core.ts';
import { renderEditCard, renderToolCard } from './tool-card.ts';

type ChatPartByKind = { [Part in ChatPart as Part['kind']]: Part };
type ChatPartRenderer<Kind extends ChatPartKind> = (part: ChatPartByKind[Kind]) => HTMLElement;
type ChatPartRendererTable = { [Kind in ChatPartKind]: ChatPartRenderer<Kind> };

function renderPrompt(part: Extract<ChatPart, { kind: 'prompt' }>): HTMLElement {
  return el('div', 'chat-prompt', part.text);
}

function renderReply(part: Extract<ChatPart, { kind: 'reply' }>): HTMLElement {
  const reply = el('div', 'chat-reply');
  for (const paragraph of replyParagraphsOf(part.text)) reply.appendChild(el('p', 'chat-reply-paragraph', paragraph));
  return reply;
}

function renderThinking(part: Extract<ChatPart, { kind: 'thinking' }>): HTMLElement {
  const thinking = el('details', 'chat-thinking');
  thinking.appendChild(el('summary', 'chat-thinking-summary', 'Thinking'));
  thinking.appendChild(el('div', 'chat-thinking-body', part.text));
  return thinking;
}

const RENDERER_BY_PART_KIND = {
  prompt: renderPrompt,
  reply: renderReply,
  thinking: renderThinking,
  tool: renderToolCard,
  edit: renderEditCard,
  card: (part) => renderCard(part.card),
} satisfies ChatPartRendererTable;

const rendererByPartKind: ChatPartRendererTable = RENDERER_BY_PART_KIND;

function renderPartOfKind<Kind extends ChatPartKind>(kind: Kind, part: ChatPartByKind[Kind]): HTMLElement {
  return rendererByPartKind[kind](part);
}

function renderPart(part: ChatPart): HTMLElement {
  const element = renderPartOfKind(part.kind, part);
  element.dataset.partId = part.id;
  return element;
}

interface ChatLog {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[]): void;
}

export function createChatLog(): ChatLog {
  const element = el('div', 'chat-log');
  element.setAttribute('role', 'log');
  const elementByPartId = new Map<string, HTMLElement>();
  const upsert = (parts: readonly ChatPart[]) => {
    for (const part of parts) {
      const rendered = renderPart(part);
      const existing = elementByPartId.get(part.id);
      elementByPartId.set(part.id, rendered);
      if (existing) {
        existing.replaceWith(rendered);
        continue;
      }
      element.appendChild(rendered);
    }
  };
  return { element, upsert };
}
