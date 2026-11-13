import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { z } from 'zod';
import { BOARD_FILE_CAP_BYTES, BOARD_FILE_ELEMENTS_MAX, BOARD_FILE_EXTENSION, BOARD_PAGE_ENTRY_PATH, BoardFile, boardMediaOriginalFilename, savableFileName } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardFileAsset, BoxMedia } from '../../shared/contracts/whiteboard.ts';
import { exportedAssetsOf, exportedBoardOf } from '../core/board-file-core.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const BOARD_FILE_MODE = 0o600;
const SCRATCH_FOLDER_MODE = 0o700;
const FALLBACK_ASSET_NAME = 'board-media';
const CAP_TEXT = `${BOARD_FILE_CAP_BYTES / (1024 * 1024)} MB`;
const OPEN_WITHOUT_BLOCKING_ON_A_PIPE = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const BASE64_BYTES_PER_INPUT_BYTE = 4 / 3;
const TOO_MANY_ELEMENTS_TEXT = `more than the ${BOARD_FILE_ELEMENTS_MAX} elements a board file holds`;

type Refusal = { ok: false; status: number; error: string };
type AdoptedAsset = { media: BoxMedia; name: string };
type ExportSource = { assetId: string; name: string; originalPath: string; memberFilePathByPath: Map<string, string> };

function refusal(status: number, error: string): Refusal {
  return { ok: false, status, error };
}

function exportSourceOf(assets: WhiteboardAssetStore, media: BoxMedia, name: string): ExportSource | null {
  const original = assets.servableOf(boardMediaOriginalFilename(media));
  if (!original) return null;
  const memberFilePathByPath = new Map<string, string>();
  for (const memberPath of assets.memberPathsOf(media.asset)) {
    const member = assets.servableMemberOf(media.asset, memberPath);
    if (!member) return null;
    memberFilePathByPath.set(memberPath, member.path);
  }
  return { assetId: media.asset, name, originalPath: original.path, memberFilePathByPath };
}

async function encodedSizeOf(sources: readonly ExportSource[]): Promise<number> {
  let totalBytes = 0;
  for (const source of sources) {
    for (const filePath of [source.originalPath, ...source.memberFilePathByPath.values()]) totalBytes += (await fsp.stat(filePath)).size;
  }
  return Math.ceil(totalBytes * BASE64_BYTES_PER_INPUT_BYTE);
}

async function exportedAssetOf(source: ExportSource): Promise<BoardFileAsset> {
  const members: Record<string, string> = {};
  for (const [memberPath, filePath] of source.memberFilePathByPath) members[memberPath] = (await fsp.readFile(filePath)).toString('base64');
  return { name: source.name, bytes: (await fsp.readFile(source.originalPath)).toString('base64'), members };
}

async function boardFileBytes(board: Board, assets: WhiteboardAssetStore): Promise<{ ok: true; bytes: Buffer } | Refusal> {
  if (board.elements.size > BOARD_FILE_ELEMENTS_MAX) return refusal(413, `the board has ${TOO_MANY_ELEMENTS_TEXT}`);
  const sources: ExportSource[] = [];
  for (const [, { media, name }] of exportedAssetsOf(board)) {
    const source = exportSourceOf(assets, media, name);
    if (!source) return refusal(500, `the media of ${name} is missing from this machine, so the board was not exported`);
    sources.push(source);
  }
  const overCap = refusal(413, `the board and its media come to more than the ${CAP_TEXT} a board file holds`);
  if (await encodedSizeOf(sources) > BOARD_FILE_CAP_BYTES) return overCap;
  const exportedAssets: Record<string, BoardFileAsset> = {};
  for (const source of sources) exportedAssets[source.assetId] = await exportedAssetOf(source);
  const json = Buffer.from(JSON.stringify({ ...exportedBoardOf(board), assets: exportedAssets }));
  if (json.byteLength > BOARD_FILE_CAP_BYTES) return overCap;
  return { ok: true, bytes: await gzip(json) };
}

function boardFileExportPathOf(exportsRoot: string, boardId: string): string {
  return path.join(exportsRoot, `${boardId}${BOARD_FILE_EXTENSION}`);
}

async function forgetBoardFileExport(exportsRoot: string, boardId: string): Promise<void> {
  await fsp.rm(boardFileExportPathOf(exportsRoot, boardId), { force: true }).catch(() => {});
}

async function writeBoardFile(exportsRoot: string, boardId: string, bytes: Buffer): Promise<{ ok: true; wrote: string } | Refusal> {
  const exportPath = boardFileExportPathOf(exportsRoot, boardId);
  const draftPath = `${exportPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(exportsRoot, { recursive: true, mode: SCRATCH_FOLDER_MODE });
    await fsp.writeFile(draftPath, bytes, { flag: 'wx', mode: BOARD_FILE_MODE });
    await fsp.rename(draftPath, exportPath);
    return { ok: true, wrote: exportPath };
  } catch (error) {
    await fsp.rm(draftPath, { force: true }).catch(() => {});
    return refusal(500, `the board file could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readBoardFileAt(filePath: string): Promise<{ ok: true; bytes: Buffer } | Refusal> {
  const handle = await fsp.open(filePath, OPEN_WITHOUT_BLOCKING_ON_A_PIPE).catch(() => null);
  if (!handle) return refusal(404, `${filePath} is not a file this session can read`);
  const overCap = refusal(413, `${path.basename(filePath)} is larger than the ${CAP_TEXT} a board file holds`);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refusal(404, `${filePath} is not a file this session can read`);
    if (stats.size > BOARD_FILE_CAP_BYTES) return overCap;
    const chunks: Buffer[] = [];
    let readBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      readBytes += chunk.byteLength;
      if (readBytes > BOARD_FILE_CAP_BYTES) return overCap;
      chunks.push(chunk);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function unzippedBoardFile(gzipped: Buffer): Promise<{ ok: true; json: Buffer } | Refusal> {
  try {
    return { ok: true, json: await gunzip(gzipped, { maxOutputLength: BOARD_FILE_CAP_BYTES }) };
  } catch (error) {
    if (error instanceof RangeError) return refusal(413, `the board file unpacks to more than the ${CAP_TEXT} a board file holds`);
    return refusal(415, 'this is not a Glimmervoid board file');
  }
}

function firstIssueText(issues: readonly z.core.$ZodIssue[]): string {
  const [issue] = issues;
  if (!issue) return 'it does not match the board file shape';
  if (issue.code === 'invalid_key' && issue.issues.length > 0) return firstIssueText(issue.issues);
  return issue.message;
}

function elementCountOf(parsedJson: unknown): number {
  if (typeof parsedJson !== 'object' || parsedJson === null || !('board' in parsedJson)) return 0;
  const { board } = parsedJson;
  if (typeof board !== 'object' || board === null || !('elements' in board)) return 0;
  const { elements } = board;
  if (typeof elements !== 'object' || elements === null) return 0;
  return Object.keys(elements).length;
}

async function parseBoardFile(gzipped: Buffer): Promise<{ ok: true; file: BoardFile } | Refusal> {
  const unzipped = await unzippedBoardFile(gzipped);
  if (!unzipped.ok) return unzipped;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(unzipped.json.toString('utf8'));
  } catch {
    return refusal(415, 'this is not a Glimmervoid board file');
  }
  if (elementCountOf(parsedJson) > BOARD_FILE_ELEMENTS_MAX) return refusal(413, `the board file holds ${TOO_MANY_ELEMENTS_TEXT}`);
  const parsed = BoardFile.safeParse(parsedJson);
  if (!parsed.success) return refusal(400, `the board file is damaged: ${firstIssueText(parsed.error.issues)}`);
  return { ok: true, file: parsed.data };
}

async function writeNewFile(filePath: string, bytes: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: SCRATCH_FOLDER_MODE });
  await fsp.writeFile(filePath, bytes, { flag: 'wx', mode: BOARD_FILE_MODE });
}

function adoptedNamed(outcome: { ok: true; media: BoxMedia } | Refusal, name: string): ({ ok: true } & AdoptedAsset) | Refusal {
  if (!outcome.ok) return outcome;
  return { ok: true, media: outcome.media, name };
}

async function adoptAsset(assets: WhiteboardAssetStore, scratchRoot: string, asset: BoardFileAsset): Promise<({ ok: true } & AdoptedAsset) | Refusal> {
  const name = savableFileName(asset.name) ?? FALLBACK_ASSET_NAME;
  const memberEntries = Object.entries(asset.members);
  if (memberEntries.some(([memberPath]) => memberPath === BOARD_PAGE_ENTRY_PATH)) return refusal(400, `the board file gives ${name} a page file named ${BOARD_PAGE_ENTRY_PATH}, which is the page itself`);
  const pageFolder = memberEntries.length === 0 ? null : path.join(scratchRoot, crypto.randomUUID());
  const incomingPath = await assets.reserveIncomingPath();
  try {
    await writeNewFile(incomingPath, Buffer.from(asset.bytes, 'base64'));
    if (pageFolder === null) return adoptedNamed(await assets.adoptIncoming(incomingPath, name, null), name);
    const pagePath = path.join(pageFolder, BOARD_PAGE_ENTRY_PATH);
    await writeNewFile(pagePath, Buffer.from(asset.bytes, 'base64'));
    for (const [memberPath, memberBytes] of memberEntries) await writeNewFile(path.join(pageFolder, memberPath), Buffer.from(memberBytes, 'base64'));
    return adoptedNamed(await assets.adoptIncoming(incomingPath, name, pagePath), name);
  } catch {
    return refusal(400, `the files of ${name} in the board file could not be unpacked, so the board was not imported`);
  } finally {
    await fsp.rm(incomingPath, { force: true }).catch(() => {});
    if (pageFolder !== null) await fsp.rm(pageFolder, { recursive: true, force: true }).catch(() => {});
  }
}

async function adoptBoardFileAssets(file: BoardFile, assets: WhiteboardAssetStore, scratchRoot: string): Promise<{ ok: true; adoptedByExportedAssetId: Map<string, AdoptedAsset> } | Refusal> {
  const adoptedByExportedAssetId = new Map<string, AdoptedAsset>();
  for (const [exportedAssetId, asset] of Object.entries(file.assets)) {
    const adopted = await adoptAsset(assets, scratchRoot, asset);
    if (!adopted.ok) return adopted;
    adoptedByExportedAssetId.set(exportedAssetId, { media: adopted.media, name: adopted.name });
  }
  return { ok: true, adoptedByExportedAssetId };
}

export { adoptBoardFileAssets, boardFileBytes, forgetBoardFileExport, parseBoardFile, readBoardFileAt, writeBoardFile };
