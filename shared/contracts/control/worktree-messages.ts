import { z } from 'zod';
import { ChangeMap } from '../change-map.ts';
import { MergeStatus } from '../session.ts';
import { sessionId, loose, openObject, nullableString, DiffBase, timestamp, optionalError, InstallFailureKind, InstallDetail, INSTALL_DETAIL_MAX_FOLDERS } from './control-fields.ts';

export const worktreeClientVariants = [
  loose('watch-session-changes', { id: sessionId.nullable() }),
] as const;

export const worktreeServerVariants = [
  loose('session-merge-status', {
    id: sessionId,
    mergeStatus: MergeStatus,
    reason: nullableString,
    parked: z.boolean(),
    timestamp,
  }),
  loose('session-worktree-blocked', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    notice: nullableString,
    timestamp,
  }),
  loose('session-worktree-warning', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    notice: nullableString,
    failureKind: InstallFailureKind.optional(),
    installDetails: z.array(InstallDetail).max(INSTALL_DETAIL_MAX_FOLDERS).optional(),
    timestamp,
  }),
  loose('session-worktree-ready', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    base: nullableString,
    timestamp,
  }),
  loose('session-diff', {
    id: sessionId,
    committed: openObject({ stat: z.string(), diff: z.string() }),
    uncommitted: openObject({ stat: z.string(), diff: z.string() }),
    hasCommits: z.boolean(),
    bases: z.array(DiffBase),
  }),
  loose('session-diff-error', { id: sessionId, message: z.string() }),
  loose('change-map', { id: sessionId, map: ChangeMap }),
  loose('branch-sync-status', {
    id: sessionId,
    branch: nullableString,
    upstream: nullableString,
    state: z.string(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    fetched: z.boolean().nullable(),
    action: z.string().optional(),
    error: optionalError,
  }),
  loose('session-changed', { id: sessionId }),
] as const;
