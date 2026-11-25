import type { ElicitationRequest, UsageLimit } from '#shared/contracts/session.ts';
import type { FileEditTally, FilePatch, TurnSegment } from './turn-digest-core.ts';

export type ChatCard =
  | { cardType: 'permission'; cardId: string; data: { title: string; detail: string }; resolution: { decision: 'allow' | 'deny'; message?: string } | null }
  | { cardType: 'question'; cardId: string; data: { question: string; detail: string; step?: string; multiSelect?: true; options: { label: string; note: string; preview?: string }[] }; resolution: { answer: string; canChange?: true } | { isDismissed: true } | null }
  | { cardType: 'notice'; cardId: string; data: { text: string }; resolution: null }
  | { cardType: 'board-change'; cardId: string; data: { changed: string; boardTitle: string | null }; resolution: null }
  | { cardType: 'live-terminal'; cardId: string; data: { heading: string }; resolution: null }
  | { cardType: 'elicitation'; cardId: string; data: ElicitationRequest; resolution: { action: 'accept' | 'decline' } | null }
  | { cardType: 'plan'; cardId: string; data: { agentName: string; planText: string; isPlanTruncated: boolean }; resolution: { decision: PlanVerdict; feedback: string | null } | null }
  | { cardType: 'sign-in'; cardId: string; data: { agentName: string; stage: SignInStage }; resolution: { isSignedIn: true } | null }
  | { cardType: 'usage-limit'; cardId: string; data: UsageLimit; resolution: { isContinuingAtReset: true } | { isPassed: true } | null };

export type PlanVerdict = 'approve' | 'reject';

export type SignInStage = 'offered' | 'signing-in' | 'refused-key';

export type ChatCardType = ChatCard['cardType'];

export type ChatPart =
  | { kind: 'prompt'; id: string; text: string; at: number; attachments: string[]; isBoardAnswer: boolean }
  | TurnPart
  | { kind: 'skill'; id: string; skillName: string }
  | { kind: 'system-line'; id: string; label: string; at: number; isRelayNews: boolean }
  | BackgroundTaskPart
  | { kind: 'card'; id: string; card: ChatCard };

export type TurnPart = { kind: 'turn'; id: string; openedAt: number | null; segments: readonly TurnSegment[]; droppedSegmentCount: number; toolCount: number; failedCount: number; fileEdits: FileEditTally; filePatches: readonly FilePatch[]; unshownPatchCount: number; thoughtText: string | null; durationText: string | null; isOver: boolean };

export type BackgroundTaskPart = { kind: 'background-task'; id: string; taskType: string | null; label: string; command: string | null; startedAt: number; endedAt: number | null };

export type ChatPartKind = ChatPart['kind'];
