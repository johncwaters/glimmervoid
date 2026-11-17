import type { OutputExcerpt } from './tool-card-core.ts';

export type ChatToolOutcome = { status: 'running' } | { status: 'no-result' } | { status: 'done'; isError: boolean; truncated: boolean };

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; toolUseId: string; name: string; mainInput: string; outcome: ChatToolOutcome; excerpt: OutputExcerpt | null }
  | { kind: 'edit'; id: string; toolUseId: string; name: string; filePath: string; oldText: string; newText: string; outcome: ChatToolOutcome };

export type ChatPartKind = ChatPart['kind'];
