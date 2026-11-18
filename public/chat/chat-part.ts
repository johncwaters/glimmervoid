export type ChatCard =
  | { cardType: 'permission'; cardId: string; data: { title: string; detail: string }; resolution: { decision: 'allow' | 'deny' } | null }
  | { cardType: 'question'; cardId: string; data: { question: string; detail: string; options: { label: string; note: string }[] }; resolution: { answer: string } | null }
  | { cardType: 'notice'; cardId: string; data: { text: string }; resolution: null }
  | { cardType: 'live-terminal'; cardId: string; data: { heading: string }; resolution: null };

export type ChatCardType = ChatCard['cardType'];

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string; at: number; attachments: string[] }
  | { kind: 'reply'; id: string; text: string }
  | { kind: 'skill'; id: string; skillName: string }
  | { kind: 'card'; id: string; card: ChatCard };

export type ChatPartKind = ChatPart['kind'];
