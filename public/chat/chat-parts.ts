import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { type InlineSpan, type ReplyBlock, replyBlocksOf } from './reply-text-core.ts';
import { renderToolGroup } from './tool-calls.ts';

type ChatPartByKind = { [Part in ChatPart as Part['kind']]: Part };
type ChatPartRenderer<Kind extends ChatPartKind> = (part: ChatPartByKind[Kind]) => HTMLElement;
type ChatPartRendererTable = { [Kind in ChatPartKind]: ChatPartRenderer<Kind> };

function renderPrompt(part: Extract<ChatPart, { kind: 'prompt' }>): HTMLElement {
  return el('div', 'chat-prompt', part.text);
}

const INLINE_TAG_BY_STYLE = { plain: null, code: 'code', strong: 'strong' } as const;

function appendSpans(parent: HTMLElement, spans: readonly InlineSpan[]): HTMLElement {
  for (const span of spans) {
    const tag = INLINE_TAG_BY_STYLE[span.style];
    parent.append(tag === null ? span.text : el(tag, `chat-inline-${span.style}`, span.text));
  }
  return parent;
}

function renderList(block: Extract<ReplyBlock, { kind: 'list' }>): HTMLElement {
  const list = block.isOrdered ? Object.assign(el('ol', 'chat-reply-list'), { start: block.start }) : el('ul', 'chat-reply-list');
  for (const item of block.items) list.appendChild(appendSpans(el('li', 'chat-reply-item'), item));
  return list;
}

function renderReplyBlock(block: ReplyBlock): HTMLElement {
  if (block.kind === 'code') return el('pre', 'chat-reply-code', block.text);
  if (block.kind === 'list') return renderList(block);
  if (block.kind === 'heading') return appendSpans(el('p', 'chat-reply-heading'), block.spans);
  return appendSpans(el('p', 'chat-reply-paragraph'), block.spans);
}

function renderReply(part: Extract<ChatPart, { kind: 'reply' }>): HTMLElement {
  const reply = el('div', 'chat-reply');
  for (const block of replyBlocksOf(part.text)) reply.appendChild(renderReplyBlock(block));
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
  tools: renderToolGroup,
  card: (part) => renderCard(part.card),
} satisfies ChatPartRendererTable;

const rendererByPartKind: ChatPartRendererTable = RENDERER_BY_PART_KIND;

function renderPartOfKind<Kind extends ChatPartKind>(kind: Kind, part: ChatPartByKind[Kind]): HTMLElement {
  return rendererByPartKind[kind](part);
}

function openKeysWithin(element: HTMLElement): Set<string> {
  const openDetails = element.querySelectorAll<HTMLElement>('details[open][data-open-key]');
  return new Set([...openDetails].map((details) => details.dataset.openKey ?? ''));
}

function reopen(element: HTMLElement, openKeys: ReadonlySet<string>): void {
  for (const details of element.querySelectorAll<HTMLDetailsElement>('details[data-open-key]')) {
    details.open = openKeys.has(details.dataset.openKey ?? '');
  }
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
        reopen(rendered, openKeysWithin(existing));
        existing.replaceWith(rendered);
        continue;
      }
      element.appendChild(rendered);
    }
  };
  return { element, upsert };
}
