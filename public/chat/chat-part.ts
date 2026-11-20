import type { FileEditTally, TurnSegment } from './turn-digest-core.ts';

export type ChatCard =
  | { cardType: 'permission'; cardId: string; data: { title: string; detail: string }; resolution: { decision: 'allow' | 'deny'; message?: string } | null }
  | { cardType: 'question'; cardId: string; data: { question: string; detail: string; step?: string; options: { label: string; note: string }[] }; resolution: { answer: string } | { isDismissed: true } | null }
  | { cardType: 'notice'; cardId: string; data: { text: string }; resolution: null }
  | { cardType: 'board-change'; cardId: string; data: { changed: string; boardTitle: string | null }; resolution: null }
  | { cardType: 'live-terminal'; cardId: string; data: { heading: string }; resolution: null }
  | { cardType: 'sign-in'; cardId: string; data: { agentName: string; stage: SignInStage }; resolution: { isSignedIn: true } | null };

export type SignInStage = 'offered' | 'signing-in' | 'refused-key';

export type ChatCardType = ChatCard['cardType'];

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string; at: number; attachments: string[] }
  | TurnPart
  | { kind: 'skill'; id: string; skillName: string }
  | { kind: 'card'; id: string; card: ChatCard };

export type TurnPart = { kind: 'turn'; id: string; segments: readonly TurnSegment[]; droppedSegmentCount: number; toolCount: number; fileEdits: FileEditTally; durationText: string | null; isOver: boolean };

export type ChatPartKind = ChatPart['kind'];
