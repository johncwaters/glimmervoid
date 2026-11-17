import type { ChatToolOutcome } from '../trace-store-core.ts';
import type { OutputExcerpt } from './tool-call-core.ts';

export type { ChatToolOutcome };

export type ToolCategory = 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other';

export interface ChatToolCall {
  toolUseId: string;
  name: string;
  category: ToolCategory;
  verb: string;
  target: string;
  filePaths: string[];
  outcome: ChatToolOutcome;
  excerpt: OutputExcerpt | null;
  edit: { filePath: string; oldText: string; newText: string } | null;
}

export type ChatCard =
  | { cardType: 'permission'; cardId: string; data: { title: string; detail: string }; resolution: { decision: 'allow' | 'deny' } | null }
  | { cardType: 'question'; cardId: string; data: { question: string; detail: string; options: { label: string; note: string }[] }; resolution: { answer: string } | null }
  | { cardType: 'notice'; cardId: string; data: { text: string }; resolution: null };

export type ChatCardType = ChatCard['cardType'];

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tools'; id: string; calls: ChatToolCall[] }
  | { kind: 'card'; id: string; card: ChatCard };

export type ChatPartKind = ChatPart['kind'];
