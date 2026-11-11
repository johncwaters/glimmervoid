import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { BOARD_DOC_CAP_BYTES, mediaOfBox } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoxMedia, LinkStateOfBox, MediaLink, Op } from '../../shared/contracts/whiteboard.ts';
import { SHOWN_FILE_CAP_BYTES } from '../../shared/contracts/session.ts';
import { linkPathProblem, linkStateOf, linkStateText } from '../../shared/whiteboard-link-core.ts';
import type { FileReading } from '../../shared/whiteboard-link-core.ts';
import { openVerifiedDoc, overwriteIfUnchanged } from '../session/session-docs-wiring.ts';
import type { OpenedFile } from '../contained-file.ts';
import type { DocRefusal } from '../session/core/session-docs-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';

type LinkedMedia = BoxMedia & { link: MediaLink };

type OpenedLink = { ok: true; file: OpenedFile } | { ok: false; problem: string };

type LinkedDocSave = { ok: true; op: Op; media: BoxMedia } | { ok: false; error: string; isConflict: boolean };

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

async function openLinkedFile(root: string | null, media: LinkedMedia, opensForWriting: boolean): Promise<OpenedLink> {
  if (root === null) return { ok: false, problem: NO_CODE_SESSION_TEXT };
  const pathProblem = linkPathProblem(media.link.path);
  if (pathProblem) return { ok: false, problem: pathProblem };
  const opened = await openVerifiedDoc(path.resolve(root, media.link.path), root, opensForWriting);
  if (!opened.ok) return { ok: false, problem: brokenLinkText(opened.reason) };
  if (opened.file.stat.size <= capBytesOf(media)) return { ok: true, file: opened.file };
  await opened.file.handle.close().catch(() => {});
  return { ok: false, problem: `The linked file is over ${capBytesOf(media) / 1024} KiB` };
}

async function hashOfHandle(handle: FileHandle): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest('hex');
}

async function readFileReading(root: string | null, media: LinkedMedia): Promise<{ reading: FileReading; handle: FileHandle | null }> {
  const opened = await openLinkedFile(root, media, false);
  if (!opened.ok) return { reading: { ok: false, problem: opened.problem }, handle: null };
  const { handle } = opened.file;
  try {
    return { reading: { ok: true, hash: await hashOfHandle(handle) }, handle };
  } catch {
    await handle.close().catch(() => {});
    return { reading: { ok: false, problem: 'The linked file cannot be read' }, handle: null };
  }
}

function ingestFromHandle(assets: WhiteboardAssetStore, handle: FileHandle, media: LinkedMedia): Promise<{ ok: true; media: BoxMedia } | { ok: false; problem: string }> {
  return ingestChunks(assets, handle.createReadStream({ autoClose: false, start: 0 }), media);
}

async function ingestChunks(assets: WhiteboardAssetStore, chunks: AsyncIterable<Buffer> | Iterable<Buffer>, media: LinkedMedia): Promise<{ ok: true; media: BoxMedia } | { ok: false; problem: string }> {
  const incomingPath = await assets.reserveIncomingPath();
  try {
    const incoming = await fsp.open(incomingPath, 'wx', 0o600);
    try {
      for await (const chunk of chunks) await incoming.write(chunk);
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

function syncedMediaOf(media: LinkedMedia, stored: BoxMedia): BoxMedia {
  return { ...stored, alt: media.alt, link: { path: media.link.path, syncedHash: stored.asset } };
}

function linkedMediaOp(boxId: string, syncedMedia: BoxMedia): Op {
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
    return { op: linkedMediaOp(boxId, syncedMediaOf(media, ingested.media)), linkState: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeLinkedDoc(boxId: string, file: OpenedFile, media: LinkedMedia, syncedHash: string, text: string, assets: WhiteboardAssetStore): Promise<LinkedDocSave> {
  const written = await overwriteIfUnchanged(file, text, syncedHash);
  if (!written.ok) return { ok: false, error: written.error, isConflict: written.conflict };
  const ingested = await ingestFromHandle(assets, file.handle, media);
  if (!ingested.ok) return { ok: false, error: `The file was saved, but the card could not take it: ${ingested.problem}`, isConflict: false };
  const syncedMedia = syncedMediaOf(media, ingested.media);
  return { ok: true, op: linkedMediaOp(boxId, syncedMedia), media: syncedMedia };
}

async function saveLinkedDoc(board: Board, boxId: string, root: string | null, text: string, baseAsset: string, assets: WhiteboardAssetStore): Promise<LinkedDocSave> {
  const media = linkedMediaOf(board, boxId);
  if (media?.kind !== 'doc') return { ok: false, error: 'That card is not a Markdown document linked to a file', isConflict: false };
  if (media.asset !== baseAsset) return { ok: false, error: 'The card changed since the editor loaded it', isConflict: true };
  const { syncedHash } = media.link;
  if (syncedHash === null) return { ok: false, error: 'The card has not been synced with its file yet; open the board again before saving', isConflict: true };
  if (Buffer.byteLength(text, 'utf8') > BOARD_DOC_CAP_BYTES) return { ok: false, error: `A linked document holds at most ${BOARD_DOC_CAP_BYTES / 1024} KiB`, isConflict: false };
  const textAsCard = await ingestChunks(assets, [Buffer.from(text, 'utf8')], media).catch((error: unknown) => ({ ok: false as const, problem: errorMessage(error) }));
  if (!textAsCard.ok) return { ok: false, error: `Nothing was saved: this text cannot be a Markdown card (${textAsCard.problem})`, isConflict: false };
  const opened = await openLinkedFile(root, media, true);
  if (!opened.ok) return { ok: false, error: opened.problem, isConflict: false };
  try {
    return await writeLinkedDoc(boxId, opened.file, media, syncedHash, text, assets);
  } catch (error) {
    return { ok: false, error: `The linked file could not be saved: ${errorMessage(error)}`, isConflict: false };
  } finally {
    await opened.file.handle.close().catch(() => {});
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

export { saveLinkedDoc, syncLinkedBoxes };
