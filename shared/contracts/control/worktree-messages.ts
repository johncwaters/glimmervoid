import { z } from 'zod';
import { ChangeMap } from '../change-map.ts';
import { MergeStatus } from '../session.ts';
import { sessionId, requestId, loose, nullableString, DiffBase, timestamp, optionalError, InstallFailureKind, InstallDetail, INSTALL_DETAIL_MAX_FOLDERS } from './control-fields.ts';

const diffFilePath = z.string().min(1).max(4096);
const blobId = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

export const worktreeClientVariants = [
  loose('watch-session-changes', { id: sessionId.nullable() }),
  loose('request-diff-file', { id: sessionId, requestId, path: diffFilePath, oldBlobId: blobId.nullable(), newBlobId: blobId }),
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
    patch: z.string(),
    contentHashByPath: z.record(z.string(), z.string().nullable()),
    generatedPaths: z.array(z.string()),
    hasCommits: z.boolean(),
    bases: z.array(DiffBase),
  }),
  loose('session-diff-error', { id: sessionId, message: z.string() }),
  loose('diff-file', {
    requestId,
    id: sessionId,
    path: z.string(),
    ok: z.boolean(),
    oldContents: z.string().nullable(),
    newContents: z.string().nullable(),
    error: optionalError,
  }),
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
