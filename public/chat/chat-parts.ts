import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { TurnMarks } from './chat-parts-core.ts';

type ChatPartByKind = { [Part in ChatPart as Part['kind']]: Part };
type UploadUrlOf = (fileName: string) => string;
type ChatPartRenderer<Kind extends ChatPartKind> = (part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf) => HTMLElement;
type ChatPartRendererTable = { [Kind in ChatPartKind]: ChatPartRenderer<Kind> };

export function renderAttachmentThumbnail(fileName: string, uploadUrlOf: UploadUrlOf): HTMLElement {
  const thumbnail = el('span', 'chat-prompt-thumbnail');
  const image = el('img', 'chat-prompt-thumbnail-image');
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = uploadUrlOf(fileName);
  thumbnail.append(el('span', 'chat-prompt-thumbnail-name', fileName), image);
  return thumbnail;
}

export function renderPromptBubble(text: string, attachments: readonly string[], uploadUrlOf: UploadUrlOf): HTMLElement {
  if (attachments.length === 0) return el('div', 'chat-prompt', text);
  const prompt = el('div', 'chat-prompt-with-attachments');
  const thumbnails = el('div', 'chat-prompt-thumbnails');
  thumbnails.append(...attachments.map((fileName) => renderAttachmentThumbnail(fileName, uploadUrlOf)));
  prompt.append(thumbnails);
  if (text.length > 0) prompt.append(el('div', 'chat-prompt', text));
  return prompt;
}

function renderPrompt(part: Extract<ChatPart, { kind: 'prompt' }>, uploadUrlOf: UploadUrlOf): HTMLElement {
  return renderPromptBubble(part.text, part.attachments, uploadUrlOf);
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

function renderPartOfKind<Kind extends ChatPartKind>(kind: Kind, part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf): HTMLElement {
  return rendererByPartKind[kind](part, uploadUrlOf);
}

function renderPart(part: ChatPart, uploadUrlOf: UploadUrlOf): HTMLElement {
  const element = renderPartOfKind(part.kind, part, uploadUrlOf);
  element.dataset.partId = part.id;
  return element;
}

interface ChatLog {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[]): void;
  remove(partIds: readonly string[]): void;
  markTurn(marks: TurnMarks): void;
}

export function createChatLog(uploadUrlOf: UploadUrlOf): ChatLog {
  const element = el('div', 'chat-log');
  element.setAttribute('role', 'log');
  const elementByPartId = new Map<string, HTMLElement>();
  const upsert = (parts: readonly ChatPart[]) => {
    for (const part of parts) {
      const rendered = renderPart(part, uploadUrlOf);
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
