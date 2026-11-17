export type ChatPart =
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string };

export type ChatPartKind = ChatPart['kind'];
