import { z } from 'zod';
import { loose, optionalError, requestId, sessionId } from './control-fields.ts';
import { SessionProgressAnswer } from '../director-digests.ts';
import { StudioGuideStep } from '../studio-guide.ts';
import { BoardAsk } from '../whiteboard.ts';
import { LayoutRect } from '../whiteboard-tiles.ts';

export const CODEMAP_BOXES_MAX_PATHS = 200;
const ASK_ANSWER_MAX_CHARS = 2000;
export const CODEMAP_BOX_CHOICES_MAX = 5000;

export const CODE_MAP_BOARD_TITLE = 'Code map';
export const BRANCH_PROMPT_MAX_CHARS = 20000;
export const DIRECTOR_DIGEST_SESSIONS_MAX = 50;
const PROGRESS_QUESTION_MAX_CHARS = 2000;

const RepoPath = z.string().min(1).max(1000);
const BOARD_ID_MAX_CHARS = 200;

export const OpenBoardAsk = z.object({
  askBoxId: z.string().min(1),
  ask: BoardAsk,
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type OpenBoardAsk = z.infer<typeof OpenBoardAsk>;

const SessionMapBoxes = z.object({ boxIdByPath: z.record(z.string(), z.string()).default({}), fallbackBoxId: z.string().nullable().default(null), changedBoxIds: z.array(z.string()).default([]) });
export type SessionMapBoxes = z.infer<typeof SessionMapBoxes>;

const StudioMapArea = z.object({ repoKey: z.string(), repoName: z.string(), isFolded: z.boolean(), anchorBoxId: z.string(), mapError: z.string().nullable().default(null) });
export type StudioMapArea = z.infer<typeof StudioMapArea>;

export const boardSessionClientVariants = [
  loose('codemap-boxes-of', { id: sessionId, requestId, pathsBySessionId: z.record(z.string().min(1).max(200), z.array(RepoPath).max(CODEMAP_BOXES_MAX_PATHS)).default({}) }),
  loose('board-asks-of', { requestId, boardId: z.string().min(1).max(BOARD_ID_MAX_CHARS) }),
  loose('board-ask-answer', { requestId, boardId: z.string().min(1).max(200), askBoxId: z.string().min(1).max(40), answer: z.string().trim().min(1).max(ASK_ANSWER_MAX_CHARS) }),
  loose('branch-spawn', { id: sessionId, requestId, aboutBoxId: z.string().min(1).max(40), prompt: z.string().trim().min(1).max(BRANCH_PROMPT_MAX_CHARS) }),
  loose('studio-main-ensure', { id: sessionId, requestId }),
  loose('codemap-folder-set', { id: sessionId, requestId, boxId: z.string().min(1).max(40), isOpen: z.boolean() }),
  loose('director-digests', { id: sessionId, requestId, sessionIds: z.array(z.string().min(1).max(200)).max(DIRECTOR_DIGEST_SESSIONS_MAX).default([]) }),
  loose('studio-progress-ask', { id: sessionId, requestId, text: z.string().trim().min(1).max(PROGRESS_QUESTION_MAX_CHARS) }),
  loose('studio-guide', { requestId, step: StudioGuideStep.nullable().default(null) }),
] as const;

export const boardSessionServerVariants = [
  loose('codemap-boxes-of-response', {
    id: sessionId,
    requestId,
    ok: z.boolean(),
    boardId: z.string().nullable().default(null),
    boxesBySessionId: z.record(z.string(), SessionMapBoxes).default({}),
    areas: z.array(StudioMapArea).default([]),
    boxRectById: z.record(z.string(), LayoutRect).default({}),
    boxChoices: z.array(z.object({ boxId: z.string(), title: z.string(), repoName: z.string() })).default([]),
    isMapFailed: z.boolean().default(false),
    error: optionalError,
  }),
  loose('board-asks-of-result', { requestId, ok: z.boolean(), asks: z.array(OpenBoardAsk).default([]), error: optionalError }),
  loose('board-ask-answer-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('branch-spawn-result', { id: sessionId, requestId, ok: z.boolean(), branchId: z.string().nullable().default(null), error: optionalError }),
  loose('studio-main-ensure-result', { id: sessionId, requestId, ok: z.boolean(), mainId: z.string().nullable().default(null), error: optionalError }),
  loose('codemap-folder-set-result', { id: sessionId, requestId, ok: z.boolean(), isOpen: z.boolean().default(false), error: optionalError }),
  loose('director-digest-kept', { id: sessionId }),
  loose('director-digests-result', {
    id: sessionId,
    requestId,
    ok: z.boolean(),
    verdictByKey: z.record(z.string(), z.object({ chatLine: z.string().nullable(), digest: z.string().nullable() })).default({}),
    progressAnswers: z.array(SessionProgressAnswer).default([]),
    error: optionalError,
  }),
  loose('studio-progress-ask-result', { id: sessionId, requestId, ok: z.boolean(), isAnswered: z.boolean().default(false), error: optionalError }),
  loose('studio-guide-result', { requestId, ok: z.boolean(), doneSteps: z.array(StudioGuideStep).default([]), error: optionalError }),
] as const;
