import type { OutputExcerpt } from './tool-card-core.ts';

export type ChatToolOutcome = { status: 'running' } | { status: 'no-result' } | { status: 'done'; isError: boolean; truncated: boolean };

export type ChatCard =
  | { cardType: 'permission'; cardId: string; data: { title: string; detail: string }; resolution: { decision: 'allow' | 'deny' } | null }
  | { cardType: 'question'; cardId: string; data: { question: string; detail: string; options: { label: string; note: string }[] }; resolution: { answer: string } | null }
  | { cardType: 'notice'; cardId: string; data: { text: string }; resolution: null };

export type ChatCardType = ChatCard['cardType'];

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; toolUseId: string; name: string; mainInput: string; outcome: ChatToolOutcome; excerpt: OutputExcerpt | null }
  | { kind: 'card'; id: string; card: ChatCard }
  | { kind: 'edit'; id: string; toolUseId: string; name: string; filePath: string; oldText: string; newText: string; outcome: ChatToolOutcome };

export type ChatPartKind = ChatPart['kind'];
