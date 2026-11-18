import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { TurnMarks } from './chat-parts-core.ts';

type ChatPartByKind = { [Part in ChatPart as Part['kind']]: Part };
type ChatPartRenderer<Kind extends ChatPartKind> = (part: ChatPartByKind[Kind]) => HTMLElement;
type ChatPartRendererTable = { [Kind in ChatPartKind]: ChatPartRenderer<Kind> };

function renderPrompt(part: Extract<ChatPart, { kind: 'prompt' }>): HTMLElement {
  return el('div', 'chat-prompt', part.text);
}

function renderReply(part: Extract<ChatPart, { kind: 'reply' }>): HTMLElement {
  const reply = el('div', 'chat-reply');
  const replyBody = renderPlanBlocks(parsePlanMarkdown(part.text));
  for (const anchoredHeading of replyBody.querySelectorAll('[id]')) anchoredHeading.removeAttribute('id');
  reply.append(el('div', 'chat-work-row'), replyBody);
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
  markTurn(marks: TurnMarks): void;
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
  const markTurn = (marks: TurnMarks) => {
    for (const partId of marks.supersededPartIds) elementByPartId.get(partId)?.setAttribute('data-superseded', 'true');
    for (const { partId, text } of marks.workedFor) {
      const reply = elementByPartId.get(partId);
      const workRow = reply?.querySelector('.chat-work-row');
      if (!reply || !workRow) continue;
      workRow.textContent = text ?? '';
      reply.toggleAttribute('data-worked-for', text !== null);
    }
  };
  return { element, upsert, remove, markTurn };
}
