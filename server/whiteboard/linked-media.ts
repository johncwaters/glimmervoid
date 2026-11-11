import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { BOARD_DOC_CAP_BYTES, mediaOfBox } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoxMedia, LinkStateOfBox, MediaLink, Op } from '../../shared/contracts/whiteboard.ts';
import { SHOWN_FILE_CAP_BYTES } from '../../shared/contracts/session.ts';
import { linkPathProblem, linkStateOf, linkStateText } from '../../shared/whiteboard-link-core.ts';
import type { FileReading } from '../../shared/whiteboard-link-core.ts';
import { openVerifiedDoc } from '../session/session-docs-wiring.ts';
import type { DocRefusal } from '../session/core/session-docs-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';

type LinkedMedia = BoxMedia & { link: MediaLink };

type OpenedLink = { ok: true; handle: FileHandle } | { ok: false; problem: string };

const NO_CODE_SESSION_TEXT = 'The board code session is not running, so the linked file cannot be read';

const BROKEN_LINK_TEXT_BY_REFUSAL: Readonly<Partial<Record<DocRefusal, string>>> = {
  missing: 'File missing in the code session worktree',
  'outside-root': 'The linked path leads outside the code session worktree',
  'not-a-regular-file': 'The linked path is not a regular file',
  'root-unresolvable': 'The code session worktree cannot be read',
  'hard-linked': 'The linked file has other hard links, so it is not read',
};

function brokenLinkText(reason: DocRefusal): string {
  return BROKEN_LINK_TEXT_BY_REFUSAL[reason] ?? 'The linked file cannot be read';
}

function linkedMediaOf(board: Board, boxId: string): LinkedMedia | null {
  const element = board.elements.get(boxId);
  const media = element?.kind === 'box' ? mediaOfBox(element) : null;
  if (!media?.link) return null;
  return { ...media, link: media.link };
}

function capBytesOf(media: BoxMedia): number {
  return media.kind === 'doc' ? BOARD_DOC_CAP_BYTES : SHOWN_FILE_CAP_BYTES;
}

async function openLinkedFile(root: string | null, media: LinkedMedia): Promise<OpenedLink> {
  if (root === null) return { ok: false, problem: NO_CODE_SESSION_TEXT };
  const pathProblem = linkPathProblem(media.link.path);
  if (pathProblem) return { ok: false, problem: pathProblem };
  const opened = await openVerifiedDoc(path.resolve(root, media.link.path), root, false);
  if (!opened.ok) return { ok: false, problem: brokenLinkText(opened.reason) };
  const { handle, stat } = opened.file;
  if (stat.size <= capBytesOf(media)) return { ok: true, handle };
  await handle.close().catch(() => {});
  return { ok: false, problem: `The linked file is over ${capBytesOf(media) / 1024} KiB` };
}

async function hashOfHandle(handle: FileHandle): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest('hex');
}

async function readFileReading(root: string | null, media: LinkedMedia): Promise<{ reading: FileReading; handle: FileHandle | null }> {
  const opened = await openLinkedFile(root, media);
  if (!opened.ok) return { reading: { ok: false, problem: opened.problem }, handle: null };
  try {
    return { reading: { ok: true, hash: await hashOfHandle(opened.handle) }, handle: opened.handle };
  } catch {
    await opened.handle.close().catch(() => {});
    return { reading: { ok: false, problem: 'The linked file cannot be read' }, handle: null };
  }
}

async function ingestFromHandle(assets: WhiteboardAssetStore, handle: FileHandle, media: LinkedMedia): Promise<{ ok: true; media: BoxMedia } | { ok: false; problem: string }> {
  const incomingPath = await assets.reserveIncomingPath();
  try {
    const incoming = await fsp.open(incomingPath, 'wx', 0o600);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) await incoming.write(chunk);
    } finally {
      await incoming.close();
    }
    const ingested = await assets.adoptIncoming(incomingPath, path.basename(media.link.path));
    if (!ingested.ok) return { ok: false, problem: ingested.error };
    if (ingested.media.kind !== media.kind) return { ok: false, problem: `The linked file is no longer a ${media.kind === 'doc' ? 'Markdown document' : 'HTML page'}` };
    return { ok: true, media: ingested.media };
  } finally {
    await fsp.rm(incomingPath, { force: true }).catch(() => {});
  }
}

function linkedMediaOp(boxId: string, media: LinkedMedia, stored: BoxMedia): Op {
  const syncedMedia: BoxMedia = { ...stored, alt: media.alt, link: { path: media.link.path, syncedHash: stored.asset } };
  return { op: 'set', id: boxId, fields: { media: syncedMedia } };
}

async function syncLinkedBox(board: Board, boxId: string, root: string | null, assets: WhiteboardAssetStore): Promise<{ op: Op | null; linkState: LinkStateOfBox | null }> {
  const media = linkedMediaOf(board, boxId);
  if (!media) return { op: null, linkState: null };
  const { reading, handle } = await readFileReading(root, media);
  try {
    const state = linkStateOf(media, reading);
    const linkState = { boxId, state, text: linkStateText(state, reading) };
    if (state !== 'file-ahead' || !handle) return { op: null, linkState: state === 'in-sync' ? null : linkState };
    const ingested = await ingestFromHandle(assets, handle, media).catch((error: unknown) => ({ ok: false as const, problem: `The linked file could not be copied to the board: ${errorMessage(error)}` }));
    if (!ingested.ok) return { op: null, linkState: { boxId, state: 'broken', text: ingested.problem } };
    return { op: linkedMediaOp(boxId, media, ingested.media), linkState: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncLinkedBoxes(board: Board, boxIds: Iterable<string>, root: string | null, assets: WhiteboardAssetStore): Promise<{ ops: Op[]; linkStates: LinkStateOfBox[] }> {
  const ops: Op[] = [];
  const linkStates: LinkStateOfBox[] = [];
  for (const boxId of boxIds) {
    const synced = await syncLinkedBox(board, boxId, root, assets);
    if (synced.op) ops.push(synced.op);
    if (synced.linkState) linkStates.push(synced.linkState);
  }
  return { ops, linkStates };
}

export { syncLinkedBoxes };
