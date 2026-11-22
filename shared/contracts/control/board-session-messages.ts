import { z } from 'zod';
import { loose, optionalError, requestId, sessionId } from './control-fields.ts';

const CODEMAP_BOXES_MAX_PATHS = 200;
const ASK_ANSWER_MAX_CHARS = 2000;
export const CODEMAP_BOX_CHOICES_MAX = 5000;
const BRANCH_PROMPT_MAX_CHARS = 20000;

const RepoPath = z.string().min(1).max(1000);

export const boardSessionClientVariants = [
  loose('codemap-boxes-of', { id: sessionId, requestId, paths: z.array(RepoPath).max(CODEMAP_BOXES_MAX_PATHS).default([]) }),
  loose('board-ask-answer', { requestId, boardId: z.string().min(1).max(200), askBoxId: z.string().min(1).max(40), answer: z.string().trim().min(1).max(ASK_ANSWER_MAX_CHARS) }),
  loose('branch-spawn', { id: sessionId, requestId, aboutBoxId: z.string().min(1).max(40), aboutTitle: z.string().min(1).max(80), prompt: z.string().trim().min(1).max(BRANCH_PROMPT_MAX_CHARS) }),
  loose('studio-main-ensure', { id: sessionId, requestId }),
  loose('codemap-folder-toggle', { id: sessionId, requestId, boxId: z.string().min(1).max(40) }),
] as const;

export const boardSessionServerVariants = [
  loose('codemap-boxes-of-response', {
    id: sessionId,
    requestId,
    ok: z.boolean(),
    boardId: z.string().nullable().default(null),
    boxIdByPath: z.record(z.string(), z.string()).default({}),
    fallbackBoxId: z.string().nullable().default(null),
    changedBoxIds: z.array(z.string()).default([]),
    boxChoices: z.array(z.object({ boxId: z.string(), title: z.string() })).max(CODEMAP_BOX_CHOICES_MAX).default([]),
    error: optionalError,
  }),
  loose('board-ask-answer-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('branch-spawn-result', { id: sessionId, requestId, ok: z.boolean(), branchId: z.string().nullable().default(null), error: optionalError }),
  loose('studio-main-ensure-result', { id: sessionId, requestId, ok: z.boolean(), mainId: z.string().nullable().default(null), error: optionalError }),
  loose('codemap-folder-toggle-result', { id: sessionId, requestId, ok: z.boolean(), isOpen: z.boolean().default(false), error: optionalError }),
] as const;
