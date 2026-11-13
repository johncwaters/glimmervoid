import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { BOARD_FILE_CAP_BYTES, BOARD_PAGE_MEMBERS_MAX, boardMediaOriginalFilename, boardMediaSavedName } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoxMedia, Element, LinkState } from '../../shared/contracts/whiteboard.ts';
import { isPathInside } from '../../shared/paths.ts';
import { errorMessage } from '../../shared/text.ts';
import { linkPathProblem } from '../../shared/whiteboard-link-core.ts';
import { openContainedFile } from '../contained-file.ts';
import { writeTextAtomic } from '../json-file.ts';
import { boardDocumentOf, decodeBoardDocument, encodeBoardDocument, mediaOfDocument, mergeBoardDocuments, withDanglingReferencesDropped } from '../core/board-document-core.ts';
import type { BoardDocument } from '../core/board-document-core.ts';
import type { BoardContent } from '../core/board-file-core.ts';
import { ASSET_INPUT_CAP_BYTES } from './whiteboard-assets.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';

type LinkSync = { state: LinkState; text: string; content: BoardContent | null; isFolderChangedMeanwhile: boolean };
type Problem = { ok: false; problem: string };
type WatchedFolder = { folder: string; inode: number };
type FolderRead = { ok: true; text: string; bytes: Buffer } | { ok: true; text: null; bytes: null } | Problem;

const DOCUMENT_FILENAME = 'board.jsonl';
const MEDIA_FOLDER_NAME = 'media';
const MEMBERS_SUFFIX = '.members.json';
const LINKS_FOLDER_NAME = 'links';
const PRIVATE_FOLDER_MODE = 0o700;
const FILE_MODE = 0o644;
const PRIVATE_FILE_MODE = 0o600;
const IN_SYNC_TEXT = 'In sync with the folder';
const NO_CODE_SESSION_TEXT = 'The board code session is not running, so the linked folder cannot be read';
const MemberHashByPath = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/))
  .refine((memberHashByPath) => Object.keys(memberHashByPath).length <= BOARD_PAGE_MEMBERS_MAX);
const EMPTY_DOCUMENT: BoardDocument = { headerLine: '', lineById: new Map() };

function problem(text: string): Problem {
  return { ok: false, problem: text };
}

function brokenSync(text: string): LinkSync {
  return { state: 'broken', text, content: null, isFolderChangedMeanwhile: false };
}

function contentOfBoard(board: Board): BoardContent {
  return { title: board.title, caption: board.caption, legend: board.legend, elements: [...board.elements.values()] };
}

function sha256Of(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function isReachedThroughSymlink(root: string, candidate: string, realPath: string): Promise<boolean> {
  const realRoot = await fsp.realpath(root);
  return realPath !== path.join(realRoot, path.relative(root, candidate));
}

function strictTextOf(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function megabytesOf(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

async function readContained(root: string, candidate: string, capBytes: number, tooLargeText = `is over ${megabytesOf(capBytes)} MB`): Promise<{ ok: true; bytes: Buffer | null } | Problem> {
  const opened = await openContainedFile(candidate, root);
  if (!opened.ok && opened.reason === 'missing') return { ok: true, bytes: null };
  if (!opened.ok) return problem(`${path.relative(root, candidate)} cannot be read (${opened.reason})`);
  try {
    if (await isReachedThroughSymlink(root, candidate, opened.file.realPath)) return problem(`${path.relative(root, candidate)} is a symbolic link, so it was not read`);
    if (opened.file.stat.size > capBytes) return problem(`${path.relative(root, candidate)} ${tooLargeText}`);
    return { ok: true, bytes: await opened.file.handle.readFile() };
  } finally {
    await opened.file.handle.close().catch(() => {});
  }
}

async function nearestExistingAncestorOf(candidate: string): Promise<string> {
  const exists = await fsp.lstat(candidate).then(() => true, () => false);
  if (exists) return candidate;
  const parent = path.dirname(candidate);
  if (parent === candidate) return candidate;
  return nearestExistingAncestorOf(parent);
}

async function ensureContainedFolder(root: string, folder: string): Promise<{ ok: true } | Problem> {
  const realRoot = await fsp.realpath(root).catch(() => null);
  if (realRoot === null) return problem('The code session worktree cannot be read');
  const realAncestor = await fsp.realpath(await nearestExistingAncestorOf(folder)).catch(() => null);
  if (realAncestor === null || !isPathInside(realRoot, realAncestor, { allowEqual: true })) return problem('The linked folder leads outside the code session worktree');
  await fsp.mkdir(folder, { recursive: true });
  const realFolder = await fsp.realpath(folder);
  if (!isPathInside(realRoot, realFolder, { allowEqual: true })) return problem('The linked folder leads outside the code session worktree');
  if (!(await fsp.stat(realFolder)).isDirectory()) return problem('The linked path is not a folder');
  return { ok: true };
}

async function writeContainedIfChanged(root: string, candidate: string, bytes: Buffer, expectedBytes: Buffer | null | undefined): Promise<'written' | 'unchanged' | 'changed-meanwhile'> {
  const target = await openContainedFile(candidate, root, true);
  if (!target.ok) throw new Error(`${path.relative(root, candidate)} cannot be written (${target.reason})`);
  const realPath = target.file.realPath;
  if ('handle' in target.file) await target.file.handle.close().catch(() => {});
  if (await isReachedThroughSymlink(root, candidate, realPath)) throw new Error(`${path.relative(root, candidate)} is a symbolic link, so it was not written`);
  const current = await fsp.readFile(realPath).catch(() => null);
  if (current?.equals(bytes)) return 'unchanged';
  const isExpected = expectedBytes === undefined || (current === null ? expectedBytes === null : expectedBytes !== null && current.equals(expectedBytes));
  if (!isExpected) return 'changed-meanwhile';
  const draftPath = `${realPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(draftPath, bytes, { flag: 'wx', mode: FILE_MODE });
    await fsp.rename(draftPath, realPath);
    return 'written';
  } finally {
    await fsp.rm(draftPath, { force: true }).catch(() => {});
  }
}

function createLinkedBoards({ boardsRoot, assets }: { boardsRoot: string; assets: WhiteboardAssetStore }) {
  const linksRoot = path.join(boardsRoot, LINKS_FOLDER_NAME);

  function basePathOf(board: Pick<Board, 'id'>, folder: string): string {
    return path.join(linksRoot, `${board.id}-${sha256Of(folder).slice(0, 16)}.jsonl`);
  }

  async function readBase(board: Board, folder: string): Promise<string | null> {
    return fsp.readFile(basePathOf(board, folder), 'utf8').catch(() => null);
  }

  async function writeBase(board: Board, folder: string, text: string): Promise<void> {
    await fsp.mkdir(linksRoot, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    await writeTextAtomic(basePathOf(board, folder), text, { mode: PRIVATE_FILE_MODE });
  }

  async function forgetBase(boardId: string): Promise<void> {
    const names = await fsp.readdir(linksRoot).catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith(`${boardId}-`)).map((name) => fsp.rm(path.join(linksRoot, name), { force: true }).catch(() => {})));
  }

  async function readFolderDocument(root: string, folder: string): Promise<FolderRead> {
    const read = await readContained(root, path.join(folder, DOCUMENT_FILENAME), BOARD_FILE_CAP_BYTES);
    if (!read.ok) return read;
    if (read.bytes === null) return { ok: true, text: null, bytes: null };
    const text = strictTextOf(read.bytes);
    if (text === null) return problem(`${path.relative(root, path.join(folder, DOCUMENT_FILENAME))} is not UTF-8 text, so the board stopped writing to it`);
    return { ok: true, text, bytes: read.bytes };
  }

  async function writeMediaInto(root: string, folder: string, media: BoxMedia): Promise<{ ok: true } | Problem> {
    const original = assets.servableOf(boardMediaOriginalFilename(media));
    if (!original) return problem(`the media ${media.asset} is missing from this machine, so the folder was not written`);
    const mediaFolder = path.join(folder, MEDIA_FOLDER_NAME);
    const memberPaths = assets.memberPathsOf(media.asset);
    const writtenMarker = path.join(mediaFolder, memberPaths.length === 0 ? boardMediaOriginalFilename(media) : `${media.asset}${MEMBERS_SUFFIX}`);
    if (await fsp.lstat(writtenMarker).then(() => true, () => false)) return { ok: true };
    const ensured = await ensureContainedFolder(root, mediaFolder);
    if (!ensured.ok) return ensured;
    await writeContainedIfChanged(root, path.join(mediaFolder, boardMediaOriginalFilename(media)), await fsp.readFile(original.path), undefined);
    if (memberPaths.length === 0) return { ok: true };
    const memberHashByPath: Record<string, string> = {};
    for (const memberPath of [...memberPaths].sort()) {
      const member = assets.servableMemberOf(media.asset, memberPath);
      if (!member) return problem(`a page file of ${media.asset} is missing from this machine, so the folder was not written`);
      const memberBytes = await fsp.readFile(member.path);
      const memberHash = sha256Of(memberBytes);
      memberHashByPath[memberPath] = memberHash;
      await writeContainedIfChanged(root, path.join(mediaFolder, memberHash), memberBytes, undefined);
    }
    await writeContainedIfChanged(root, path.join(mediaFolder, `${media.asset}${MEMBERS_SUFFIX}`), Buffer.from(`${JSON.stringify(memberHashByPath, null, 1)}\n`), undefined);
    return { ok: true };
  }

  async function adoptMediaFrom(root: string, folder: string, media: BoxMedia, boxTitle: string): Promise<{ ok: true; media: BoxMedia } | Problem> {
    if (assets.has(media.asset)) return { ok: true, media: { ...media, link: null, source: null } };
    const mediaFolder = path.join(folder, MEDIA_FOLDER_NAME);
    const original = await readContained(root, path.join(mediaFolder, boardMediaOriginalFilename(media)), ASSET_INPUT_CAP_BYTES);
    if (!original.ok) return original;
    if (original.bytes === null) return problem(`media/${boardMediaOriginalFilename(media)} is missing from the linked folder`);
    const membersRead = await readContained(root, path.join(mediaFolder, `${media.asset}${MEMBERS_SUFFIX}`), ASSET_INPUT_CAP_BYTES);
    if (!membersRead.ok) return membersRead;
    const members = membersRead.bytes === null ? { success: true as const, data: {} } : MemberHashByPath.safeParse(JSON.parse(membersRead.bytes.toString('utf8')));
    if (!members.success) return problem(`media/${media.asset}${MEMBERS_SUFFIX} names a page file by something other than its hash`);
    const bytesByMemberPath = new Map<string, Buffer>();
    const bytesByHash = new Map<string, Buffer>();
    let readBytes = original.bytes.length;
    for (const [memberPath, memberHash] of Object.entries(members.data)) {
      const knownBytes = bytesByHash.get(memberHash);
      if (knownBytes) {
        bytesByMemberPath.set(memberPath, knownBytes);
        continue;
      }
      const memberRead = await readContained(root, path.join(mediaFolder, memberHash), ASSET_INPUT_CAP_BYTES - readBytes, `takes the page files of ${media.asset} over ${megabytesOf(ASSET_INPUT_CAP_BYTES)} MB together`);
      if (!memberRead.ok) return memberRead;
      if (memberRead.bytes === null) return problem(`media/${memberHash} is missing from the linked folder`);
      readBytes += memberRead.bytes.length;
      bytesByHash.set(memberHash, memberRead.bytes);
      bytesByMemberPath.set(memberPath, memberRead.bytes);
    }
    const incomingPath = await assets.reserveIncomingPath();
    await fsp.writeFile(incomingPath, original.bytes, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    const name = boardMediaSavedName(media, boxTitle);
    const adopted = bytesByMemberPath.size === 0 ? await assets.adoptIncoming(incomingPath, name, null) : await assets.adoptPageBundle(incomingPath, name, bytesByMemberPath);
    await fsp.rm(incomingPath, { force: true }).catch(() => {});
    if (!adopted.ok) return problem(`media/${boardMediaOriginalFilename(media)}: ${adopted.error}`);
    return { ok: true, media: { ...adopted.media, alt: media.alt, source: { from: 'upload', name } } };
  }

  async function adoptedContentOf(root: string, folder: string, content: BoardContent): Promise<{ ok: true; content: BoardContent } | Problem> {
    const elements: Element[] = [];
    for (const element of content.elements) {
      if (element.kind !== 'box' || !element.media) {
        elements.push(element);
        continue;
      }
      const adopted = await adoptMediaFrom(root, folder, element.media, element.title);
      if (!adopted.ok) return adopted;
      elements.push({ ...element, media: adopted.media });
    }
    return { ok: true, content: { ...content, elements } };
  }

  async function writeFolder(root: string, folder: string, text: string, content: BoardContent, theirsBytes: Buffer | null): Promise<{ ok: true; isChangedMeanwhile: boolean } | Problem> {
    const ensured = await ensureContainedFolder(root, folder);
    if (!ensured.ok) return ensured;
    for (const media of mediaOfDocument(content)) {
      const written = await writeMediaInto(root, folder, media);
      if (!written.ok) return written;
    }
    const outcome = await writeContainedIfChanged(root, path.join(folder, DOCUMENT_FILENAME), Buffer.from(text), theirsBytes);
    return { ok: true, isChangedMeanwhile: outcome === 'changed-meanwhile' };
  }

  async function syncBoard(board: Board, root: string | null): Promise<LinkSync | null> {
    const linkPath = board.link;
    if (linkPath === null) return null;
    if (root === null) return brokenSync(NO_CODE_SESSION_TEXT);
    const pathProblem = linkPathProblem(linkPath);
    if (pathProblem) return brokenSync(pathProblem);
    try {
      return await syncFolder(board, linkPath, root, path.resolve(root, linkPath));
    } catch (error) {
      return brokenSync(`The linked folder could not be synced: ${errorMessage(error)}`);
    }
  }

  async function syncFolder(board: Board, linkPath: string, root: string, folder: string): Promise<LinkSync> {
    const ours = boardDocumentOf(contentOfBoard(board));
    const oursText = encodeBoardDocument(ours);
    const folderRead = await readFolderDocument(root, folder);
    if (!folderRead.ok) return brokenSync(folderRead.problem);
    const { text: theirsText, bytes: theirsBytes } = folderRead;
    const baseText = await readBase(board, folder);
    if (theirsText === null && baseText !== null) return brokenSync(`${linkPath}/${DOCUMENT_FILENAME} is gone, as after a branch switch, so the board stopped writing to it; it syncs again once the file is back, or link the board again to write it there`);
    if (theirsText === null) return finishSync(board, root, folder, oursText, null, null);
    if (theirsText === oursText || theirsText === baseText) return finishSync(board, root, folder, oursText, theirsBytes, null);
    const theirs = decodeBoardDocument(theirsText);
    if (!theirs.ok) return brokenSync(`${linkPath}/${DOCUMENT_FILENAME} cannot be read, so the board stopped writing to it: ${theirs.error}`);
    if (oursText === baseText) return finishSync(board, root, folder, theirsText, theirsBytes, theirs.content);
    const base = baseText === null ? null : decodeBoardDocument(baseText);
    const baseDocument = base?.ok ? base.document : EMPTY_DOCUMENT;
    const mergedText = encodeBoardDocument(mergeBoardDocuments(baseDocument, ours, theirs.document));
    const merged = decodeBoardDocument(mergedText);
    if (!merged.ok) return brokenSync(`The board and its folder could not be merged: ${merged.error}`);
    const mergedContent = withDanglingReferencesDropped(merged.content);
    const cleanText = encodeBoardDocument(boardDocumentOf(mergedContent));
    return finishSync(board, root, folder, cleanText, theirsBytes, mergedContent);
  }

  async function finishSync(board: Board, root: string, folder: string, targetText: string, theirsBytes: Buffer | null, contentForBoard: BoardContent | null): Promise<LinkSync> {
    const adopted = contentForBoard === null ? null : await adoptedContentOf(root, folder, contentForBoard);
    if (adopted && !adopted.ok) return brokenSync(adopted.problem);
    const targetContent = adopted?.content ?? contentOfBoard(board);
    const written = await writeFolder(root, folder, targetText, targetContent, theirsBytes);
    if (!written.ok) return brokenSync(written.problem);
    if (written.isChangedMeanwhile) return { state: 'file-ahead', text: 'The folder changed while the board was saving; it syncs again', content: null, isFolderChangedMeanwhile: true };
    await writeBase(board, folder, targetText);
    return { state: 'in-sync', text: IN_SYNC_TEXT, content: adopted?.content ?? null, isFolderChangedMeanwhile: false };
  }

  async function nearestFolderInside(root: string, candidate: string): Promise<WatchedFolder | null> {
    const stats = await fsp.stat(candidate).catch(() => null);
    if (stats?.isDirectory()) return { folder: candidate, inode: stats.ino };
    const parent = path.dirname(candidate);
    if (candidate === root || !isPathInside(root, parent, { allowEqual: true })) return null;
    return nearestFolderInside(root, parent);
  }

  async function watchedFolderOf(board: Board, root: string | null): Promise<WatchedFolder | null> {
    if (board.link === null || root === null || linkPathProblem(board.link)) return null;
    return nearestFolderInside(path.resolve(root), path.resolve(root, board.link));
  }

  return { syncBoard, forgetBase, watchedFolderOf };
}

export { createLinkedBoards };
export type { LinkSync, WatchedFolder };
