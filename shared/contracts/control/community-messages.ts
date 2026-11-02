import { z } from 'zod';
import { CommunityActionRequest, CommunityActionResult, CommunityItemKey, CommunityStatus } from '../community.ts';
import { requestId, loose, optionalError } from './control-fields.ts';

export const communityClientVariants = [
  loose('open-community-session', { requestId, key: CommunityItemKey, projectId: z.string().min(1) }),
  loose('community-action', { ...CommunityActionRequest.shape, requestId }),
] as const;

export const communityServerVariants = [
  loose('community-action-result', { ...CommunityActionResult.shape, requestId }),
  loose('open-community-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    key: z.string().optional(),
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
  }),
  CommunityStatus,
] as const;
