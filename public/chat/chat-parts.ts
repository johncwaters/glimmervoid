import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { type InlineSpan, type ReplyBlock, replyBlocksOf } from './reply-text-core.ts';

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

function renderSkill(part: Extract<ChatPart, { kind: 'skill' }>): HTMLElement {
  const skillLine = el('div', 'chat-skill');
  skillLine.append('Loaded skill ', el('code', null, part.skillName));
  return skillLine;
}

const RENDERER_BY_PART_KIND = {
  prompt: renderPrompt,
  reply: renderReply,
  skill: renderSkill,
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
  remove(partIds: readonly string[]): void;
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
  const remove = (partIds: readonly string[]) => {
    for (const partId of partIds) {
      elementByPartId.get(partId)?.remove();
      elementByPartId.delete(partId);
    }
  };
  return { element, upsert, remove };
}
