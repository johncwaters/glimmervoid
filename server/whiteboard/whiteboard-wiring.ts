import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BoardRecord, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardRegion, BoardReview, BoardSummary, BoxMedia, Element, Op, WhiteboardAgentRequest } from '../../shared/contracts/whiteboard.ts';
import type { AgentReplyBodyOf } from '../../shared/contracts/session.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { WhiteboardPatch } from '../../shared/contracts/control/whiteboard-messages.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { OPERATOR_AUTHOR, createBoard, stageOps } from '../../shared/whiteboard-ops-core.ts';
import { assetIdOf, assetIdsOf, boardIndexOf } from '../../shared/whiteboard-board-index.ts';
import type { StagedElements } from './board-store-core.ts';
import type { Author, PinPositions } from '../../shared/whiteboard-ops-core.ts';
import { createBoardTileService } from './board-tile-service.ts';
import type { BoardPictureRead, BoardTileService, LayoutSummary, PictureImage } from './board-tile-service.ts';
import type { ChangedElement } from './layout-client.ts';
import { elementPageOf, fitsOnePage } from '../../shared/whiteboard-tile-core.ts';
import { referencedPaths, reviewBoard } from '../../shared/whiteboard-anchor-core.ts';
import { cappedWarnings } from '../../shared/whiteboard-route-core.ts';
import { readChangeFacts, readFileFacts } from './whiteboard-anchor-facts.ts';
import type { ChangeMap } from '../../shared/contracts/change-map.ts';
import { stepBoxesOf } from '../../shared/whiteboard-plan-core.ts';
import {
  upgradedBoardRecord, changesForReader, connectSession, disconnectSession, boardNoticeFor, markRead, pickShowBoardId, recordPut, resolveBoardRef, shownBoxOp, summarizeBoard,
} from '../core/whiteboard-store-core.ts';
import { loadJsonStateFile } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { errorMessage } from '../../shared/text.ts';
import { readPageTitle, SHOWN_SNIFF_BYTES } from '../core/shown-files-core.ts';
import { createWhiteboardAssetStore } from './whiteboard-assets.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';
import { createBoardStore } from './board-store-client.ts';
import { BOARD_STORE_FILENAME } from './board-store-core.ts';

const WHITEBOARDS_FOLDER_NAME = 'whiteboards';
const BOARD_FILE_EXTENSION = '.json';
const MIGRATED_JSON_FOLDER_NAME = 'migrated-json';
const OLDER_READER_PICTURE_GUARD = `boards${BOARD_FILE_EXTENSION}.corrupt-moved-to-boards-sqlite`;

const PUT_GUIDE = [
  'glimmervoid whiteboard put <board> <ops> takes a JSON array of ops, - to read it from stdin, or --file <path> to read it from a file, for example',
  '\'[{"op":"add","element":{"kind":"box","id":"parse","title":"Parse","at":{"x":40,"y":40},"lines":[{"text":"reads the feed"},{"text":"skips drafts","muted":true}]}},',
  '{"op":"add","element":{"kind":"box","id":"store","title":"Store","near":{"of":"parse","side":"right","gap":60}}},',
  '{"op":"add","element":{"kind":"wire","id":"w1","from":"parse","to":"store","dashed":true,"label":"on retry"}},',
  '{"op":"set","id":"parse","fields":{"title":"Parse feed"}},{"op":"remove","id":"w1"}]\'.',
  'Pick the layout that fits what you draw; the example shows op syntax, not a preferred shape.',
  'Element kinds: box (title, near, at, lines, refs, change none|added|removed|relabeled, was, order, shape box|decision|panel, outputs, step {status planned|building|landed, linkedBoardId} to make it a plan step), wire (from, to, fromOutput, dashed, tone plain|fail|join, label, fromSide and toSide left|right|top|bottom, back), frame (title, contains, loop), note (on, text, ref).',
  'To show a picture, video, HTML page or Markdown document, run glimmervoid whiteboard attach <path> (PNG, JPEG, WebP, GIF, SVG, MP4, WebM, HTML or Markdown) and set the media it returns on a box unchanged except alt, as in "media":{"kind":"image","asset":"<id>","mime":"image/png","width":800,"height":600,"alt":"login screen","hasPreview":false}; a picture or video first frame draws under the box lines, a page or a video without a first frame shows as a labelled placeholder, and a Markdown document shows the operator its rendered text, which they can edit and save on the board.',
  'A line takes style text|code|item|numbered|kv; kv needs a key, as in {"style":"kv","key":"timeout","text":"30s"}, and numbered lines count up through each run.',
  'A plan step is a box with a step; a wire from one step to another means the second is built after the first, cycles allowed. A step with no place sits in the build-order band above the free drawing until moved. glimmervoid whiteboard plan add|after|status|show edits and reads them.',
  'A box with shape panel is a side note card for text such as prior art: with no place it stacks right of the drawing, lowest order first, until it is given one, and no box can sit near it while it is stacked.',
  'The board is a free canvas: every box but a plan step or a panel needs one place, near another box with near {"of":"parse","side":"right|left|top|bottom","gap":60} or at {"x","y"} pixels; build columns, rows or lanes yourself from at positions, frames and text boxes.',
  'A planned step whose ref files already changed, or a landed one whose ref files are unchanged or uncommitted, comes back as a warning.',
  'Point a box at code with refs ["path", "path#L12", "path#L12-L30"], relative to the board code session worktree (codeSessionId, the creating session by default); any line or note takes one ref. A ref that names no file or runs past the end comes back as a warning.',
  'Mark what a change does to a box with change: added and removed for parts it brings or takes away, relabeled with was set to the old title for a rename.',
  'A decision is a box with shape:"decision" and outputs [{id, label}] drawn as rows in that order; a wire with fromOutput set to an output id leaves from that row, so each branch starts at its own named exit.',
  'Wires route around every box on their own; set fromSide or toSide to pick where one attaches, back:true for a return edge that loops around the outside, and loop:true on a frame to mark what repeats.',
  'The legend lists every wire style in use on its own; a board op with legend [{tone, dashed, back, label}] renames an entry or adds one.',
  'A put is applied whole or refused whole.',
  'glimmervoid whiteboard get <board> returns the board and a one-line summary of each change others made since this session last read it;',
  'add --layout to see where every box, wire and label landed, which refs need fixing, which changed files no ref covers and which referenced files the review tab calls worth a look, or run glimmervoid whiteboard render <board> --out board.svg to draw it as the dashboard does.',
].join(' ');

interface WhiteboardCaller {
  id: string;
  name: string;
  cwd?: string;
  remoteWorkspace?: string | null;
}

interface WhiteboardReply {
  status: number;
  body: AgentReplyBodyOf<'whiteboard'>;
  patch?: WhiteboardPatch;
}

type StagedWrite = StagedElements & { commit: () => void };
type CommittedReply = { reply: WhiteboardReply };
type RecordChange = {
  ok: true; record: BoardRecord; reply: WhiteboardReply; patch?: WhiteboardPatch; staged?: StagedWrite; replyAfterCommit?: (record: BoardRecord, layout: LayoutSummary | null) => CommittedReply;
} | { ok: false; reply: WhiteboardReply };

type AppliedOps = { ok: true; record: BoardRecord; patch: WhiteboardPatch; staged: StagedWrite } | { ok: false; error: string };

type OperatorReply = {
  ok: boolean;
  error: string | null;
  board?: Board;
  summary?: BoardSummary;
  review?: BoardReview;
  patch?: WhiteboardPatch;
};

const GLIMMERVOID_AUTHOR: Author = Object.freeze({ id: 'glimmervoid', name: 'Glimmervoid' });
const DELETED_BOARD_TEXT = 'that board was deleted';
const RELEASE_HOLD_MS = 60 * 60_000;
const UNREADABLE_LAYOUT_WARNING = 'the board could not be laid out after this put, so its layout warnings are unknown and the dashboard may not show it';

interface WhiteboardWiringOptions {
  boardsRoot: string;
  broadcastControl?: (message: ControlMessageRecord) => void;
  now?: () => number;
  newBoardId?: () => string;
  logger?: Pick<Console, 'warn'>;
  codeContextOf?: (sessionId: string) => CodeContext | null;
}

interface CodeContext {
  root: string;
  buildChangeMap: () => Promise<ChangeMap>;
}

interface WhiteboardPort {
  loaded: Promise<void>;
  assets: WhiteboardAssetStore;
  handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply>;
  handleOperator: {
    create(title: string): Promise<OperatorReply>;
    put(boardId: string, ops: readonly Op[]): Promise<OperatorReply>;
    remove(boardId: string): Promise<OperatorReply>;
    get(boardId: string): Promise<OperatorReply>;
    review(boardId: string): Promise<OperatorReply>;
    connect(boardId: string, sessionId: string): Promise<OperatorReply>;
    disconnect(boardId: string, sessionId: string): Promise<OperatorReply>;
  };
  forgetSession(sessionId: string): Promise<void>;
  forgetClosedSessions(isClosedSession: (sessionId: string) => boolean): Promise<void>;
  takeBoardNotice(sessionId: string): string | null;
  isConnected(sessionId: string): boolean;
  snapshotMessage(): ServerMessageOf<'whiteboards-snapshot'>;
  tiles: Pick<BoardTileService, 'view' | 'forget' | 'operatorViewOf'>;
  layouts: WhiteboardLayouts;
}

interface WhiteboardLayouts {
  summaryOf(boardId: string): Promise<LayoutSummary | null>;
  pictureImagesOf(boardId: string): Promise<PictureImage[] | null>;
  pictureOf(boardId: string, dataUriByAssetId: Record<string, string>): Promise<BoardPictureRead | null>;
}

function hasNoConnectedSessions(record: BoardRecord): boolean {
  return Object.keys(record.cursorBySessionId).length === 0;
}

function refusal(status: number, error: string): WhiteboardReply {
  return { status, body: { ok: false, error } };
}

function attachedMediaUse(media: BoxMedia): string {
  if (media.kind === 'doc') return 'to show the operator the document, which they can edit and save on the board';
  if (media.kind === 'image' || media.hasPreview) return 'to draw it';
  return 'to show it as a labelled placeholder until live playback ships';
}

function parseBoardRecord(raw: unknown): BoardRecord | null {
  const parsed = BoardRecord.safeParse(upgradedBoardRecord(raw));
  return parsed.success ? parsed.data : null;
}

interface AgentFocus {
  region: BoardRegion;
  operatorView: BoardRegion | null;
}

type PageStart = { ok: true; offset: number } | { ok: false; reply: WhiteboardReply };

function boardSnapshotOf(board: Board): Board {
  return { ...board, elements: { ...board.elements } };
}

function isWholeBoardRead(board: Board, request: Extract<WhiteboardAgentRequest, { sub: 'get' }>): boolean {
  if (request.whole === true) return true;
  return request.region === undefined && request.cursor === undefined && fitsOnePage(board);
}

function pageStartOf(board: Board, cursor: string | undefined): PageStart {
  if (cursor === undefined) return { ok: true, offset: 0 };
  const [cursorVersion, cursorOffset] = cursor.split('.').map(Number);
  if (cursorVersion !== board.version) return { ok: false, reply: refusal(409, `the board changed since that page (it was version ${cursorVersion}, now ${board.version}), so its cursor no longer lines up; read again without cursor`) };
  return { ok: true, offset: cursorOffset ?? 0 };
}

function pageReplyOf(board: Board, elementIds: readonly string[], offset: number): { elements: Element[]; nextCursor: string | null } {
  const { elements, nextOffset } = elementPageOf(board, elementIds, offset);
  return { elements, nextCursor: nextOffset === null ? null : `${board.version}.${nextOffset}` };
}

function operatorReplyOf(reply: WhiteboardReply): OperatorReply {
  if (!reply.body.ok) return { ok: false, error: reply.body.error };
  const patch = reply.patch ? { patch: reply.patch } : {};
  if ('board' in reply.body && 'changes' in reply.body && !('outline' in reply.body)) return { ok: true, error: null, board: reply.body.board, ...patch };
  if ('board' in reply.body) return { ok: true, error: null, summary: reply.body.board, ...patch };
  return { ok: true, error: null, ...patch };
}

function createWhiteboardWiring({
  boardsRoot, broadcastControl = () => {}, now = Date.now, newBoardId = () => crypto.randomUUID(), logger = console, codeContextOf = () => null,
}: WhiteboardWiringOptions): WhiteboardPort {
  const recordsByBoardId = new Map<string, BoardRecord>();
  const announcedVersionByBoardIdBySessionId = new Map<string, Map<string, number>>();
  const deletedBoardIds = new Set<string>();
  const writeQueue = createKeyedSerialQueue();
  const assets = createWhiteboardAssetStore({ boardsRoot, logger, now });
  const store = createBoardStore(boardsRoot);
  const tiles = createBoardTileService({ boardOf: (boardId) => recordsByBoardId.get(boardId)?.board ?? null, logger });
  const agentFocusBySessionId = new Map<string, Map<string, AgentFocus>>();
  const pagedFocusBySessionId = new Map<string, Map<string, BoardRegion>>();
  let isEveryBoardLoaded = true;
  const loaded = Promise.all([loadBoards(), assets.loaded]).then(sweepUnusedAssets).then(() => {});

  function sweepUnusedAssets(): Promise<number> {
    if (!isEveryBoardLoaded) return Promise.resolve(0);
    const referencedAssetIds = new Set([...recordsByBoardId.values()].flatMap((record) => [...assetIdsOf(record.board)]));
    return assets.sweep(referencedAssetIds);
  }

  function keepPicturesWhileUnloaded(filename: string): void {
    isEveryBoardLoaded = false;
    logger.warn(`[whiteboard] board pictures are kept, not cleared, while ${filename} is not loaded`);
  }

  async function loadBoards(): Promise<void> {
    const stored = await store.loadAll().catch((error: unknown) => {
      logger.warn(`[whiteboard] the board store could not be read: ${errorMessage(error)}`);
      return null;
    });
    if (!stored) {
      keepPicturesWhileUnloaded(boardsRoot);
      return;
    }
    await fsp.writeFile(path.join(boardsRoot, OLDER_READER_PICTURE_GUARD), '', { mode: 0o600 }).catch((error: unknown) => {
      logger.warn(`[whiteboard] an older Glimmervoid started on ${boardsRoot} could clear board pictures: ${errorMessage(error)}`);
    });
    for (const record of stored.records) recordsByBoardId.set(record.board.id, record);
    for (const boardId of stored.unreadableBoardIds) keepPicturesWhileUnloaded(`board ${boardId}`);
    await migrateJsonBoards();
  }

  async function migrateJsonBoards(): Promise<void> {
    const filenames = await fsp.readdir(boardsRoot).catch((error: NodeJS.ErrnoException): string[] | null => (error.code === 'ENOENT' ? [] : null));
    if (filenames === null) {
      keepPicturesWhileUnloaded(boardsRoot);
      return;
    }
    const migratedFilenames: string[] = [];
    const importedRecords: BoardRecord[] = [];
    for (const filename of filenames) {
      if (filename === OLDER_READER_PICTURE_GUARD) continue;
      if (filename.includes(`${BOARD_FILE_EXTENSION}.corrupt-`) || filename.startsWith(`${BOARD_STORE_FILENAME}.corrupt-`)) keepPicturesWhileUnloaded(filename);
      if (!filename.endsWith(BOARD_FILE_EXTENSION)) continue;
      const outcome = await loadJsonStateFile({ filePath: path.join(boardsRoot, filename), parse: parseBoardRecord });
      if (outcome.status === 'loaded' && `${outcome.value.board.id}${BOARD_FILE_EXTENSION}` === filename) {
        migratedFilenames.push(filename);
        if (!recordsByBoardId.has(outcome.value.board.id)) importedRecords.push(outcome.value);
        continue;
      }
      if (outcome.status === 'missing') continue;
      logger.warn(`[whiteboard] ${filename} was not loaded: ${outcome.status}`);
      keepPicturesWhileUnloaded(filename);
    }
    if (migratedFilenames.length === 0) return;
    try {
      await store.saveMany(importedRecords);
    } catch (error) {
      logger.warn(`[whiteboard] ${importedRecords.length} board file(s) could not be moved into the board store: ${errorMessage(error)}`);
      keepPicturesWhileUnloaded(MIGRATED_JSON_FOLDER_NAME);
      return;
    }
    for (const record of importedRecords) recordsByBoardId.set(record.board.id, record);
    await moveMigratedFiles(migratedFilenames);
  }

  async function moveMigratedFiles(filenames: readonly string[]): Promise<void> {
    const migratedRoot = path.join(boardsRoot, MIGRATED_JSON_FOLDER_NAME);
    const isFolderReady = await fsp.mkdir(migratedRoot, { recursive: true, mode: 0o700 }).then(() => true, (error: unknown) => {
      logger.warn(`[whiteboard] ${filenames.length} board file(s) are in the board store but stayed in place: ${errorMessage(error)}`);
      return false;
    });
    if (!isFolderReady) return;
    for (const filename of filenames) {
      await fsp.rename(path.join(boardsRoot, filename), path.join(migratedRoot, filename)).catch((error: unknown) => {
        logger.warn(`[whiteboard] ${filename} is in the board store but stayed in place: ${errorMessage(error)}`);
      });
    }
  }

  function snapshotMessage(): ServerMessageOf<'whiteboards-snapshot'> {
    return { type: 'whiteboards-snapshot', boards: [...recordsByBoardId.values()].map(summarizeBoard) };
  }

  function broadcastSummariesIfChanged(before: BoardRecord | null, after: BoardRecord | null): void {
    const summaryBefore = before ? JSON.stringify(summarizeBoard(before)) : null;
    const summaryAfter = after ? JSON.stringify(summarizeBoard(after)) : null;
    if (summaryBefore === summaryAfter) return;
    broadcastControl(snapshotMessage());
  }

  async function saveRecordInSlot(current: BoardRecord, next: BoardRecord, staged: StagedWrite | null): Promise<boolean> {
    const boardId = current.board.id;
    try {
      await store.save(current, next, staged);
    } catch (error) {
      logger.warn(`[whiteboard] board ${boardId} could not be saved: ${errorMessage(error)}`);
      return false;
    }
    staged?.commit();
    recordsByBoardId.set(boardId, next);
    return true;
  }
  function elementChangesOf(staged: StagedWrite): ChangedElement[] {
    return Object.entries(staged.diff.elements).map(([id, change]) => ({ id, after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }));
  }

  function changeRecord(boardId: string, change: (record: BoardRecord) => RecordChange | Promise<RecordChange>): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, DELETED_BOARD_TEXT);
      const outcome = await change(current);
      if (!outcome.ok) return outcome.reply;
      if (outcome.record === current) return outcome.reply;
      const elementChanges = outcome.staged ? elementChangesOf(outcome.staged) : null;
      const isSaved = await saveRecordInSlot(current, outcome.record, outcome.staged ?? null);
      if (!isSaved) return refusal(500, 'the board could not be saved, so nothing changed');
      const isBoardChanged = outcome.record.board !== current.board;
      const layout = isBoardChanged ? await tiles.advance(outcome.record.board, elementChanges) : null;
      const committed = outcome.replyAfterCommit?.(outcome.record, layout) ?? { reply: outcome.reply };
      broadcastSummariesIfChanged(current, outcome.record);
      return outcome.patch ? { ...committed.reply, patch: outcome.patch } : committed.reply;
    });
  }

  function findBoardId(ref: string): { ok: true; boardId: string } | { ok: false; reply: WhiteboardReply } {
    if (deletedBoardIds.has(ref)) return { ok: false, reply: refusal(404, DELETED_BOARD_TEXT) };
    const resolved = resolveBoardRef([...recordsByBoardId.values()].map((record) => record.board), ref);
    if ('error' in resolved) return { ok: false, reply: refusal(404, resolved.error) };
    return { ok: true, boardId: resolved.id };
  }

  async function createBoardFor(creator: WhiteboardCaller | null, title: string): Promise<WhiteboardReply> {
    const boardId = newBoardId();
    const nowMs = now();
    const cursorBySessionId: Record<string, number> = creator ? { [creator.id]: 0 } : {};
    const board = createBoard({ id: boardId, title, nowMs, codeSessionId: creator?.id ?? null });
    const record: BoardRecord = { board, log: [], cursorBySessionId, createdBy: creator?.id ?? null };
    recordsByBoardId.set(boardId, record);
    try {
      await writeQueue.run(boardId, () => store.save(null, record));
    } catch (error) {
      recordsByBoardId.delete(boardId);
      logger.warn(`[whiteboard] board ${boardId} could not be created: ${errorMessage(error)}`);
      return refusal(500, 'the board could not be saved, so it was not created');
    }
    broadcastSummariesIfChanged(null, record);
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note: PUT_GUIDE } };
  }

  function putOps(boardId: string, ops: readonly Op[], author: Author): Promise<WhiteboardReply> {
    if (Buffer.byteLength(JSON.stringify(ops)) > WHITEBOARD_LIMITS.putBytes) {
      return Promise.resolve(refusal(413, `one put carries at most ${WHITEBOARD_LIMITS.putBytes} bytes of ops, so nothing changed`));
    }
    return changeRecord(boardId, async (record) => {
      const applied = await applyOpsToRecord(record, ops, author);
      if (!applied.ok) return { ok: false, reply: refusal(400, `${applied.error}, so nothing changed`) };
      const replyAfterCommit = (saved: BoardRecord, layout: LayoutSummary | null): CommittedReply => {
        const warnings = layout?.warnings ?? [UNREADABLE_LAYOUT_WARNING];
        const body = { ok: true as const, version: saved.board.version, ...(warnings.length > 0 ? { warnings } : {}) };
        return { reply: { status: 200, body } };
      };
      return { ok: true, record: applied.record, reply: { status: 200, body: { ok: true, version: applied.record.board.version } }, patch: applied.patch, staged: applied.staged, replyAfterCommit };
    });
  }

  function stagedRefusalOf(boardBefore: Board, afterById: ReadonlyMap<string, Element | null>): string | null {
    for (const element of afterById.values()) {
      const before = element ? boardBefore.elements[element.id] : undefined;
      if (element?.kind !== 'box') continue;
      const linkedBoardId = element.step?.linkedBoardId ?? null;
      const isNewLink = before?.kind !== 'box' || (before.step?.linkedBoardId ?? null) !== linkedBoardId;
      if (isNewLink && linkedBoardId !== null && !recordsByBoardId.has(linkedBoardId)) return `step ${element.id} links to board ${linkedBoardId}, which does not exist`;
      if (!element.media) continue;
      const mediaBefore = before?.kind === 'box' ? before.media : null;
      if (JSON.stringify(mediaBefore) === JSON.stringify(element.media)) continue;
      const mismatch = assets.mismatchOf(element.media);
      if (mismatch) return `box ${element.id} names ${mismatch}`;
    }
    return null;
  }

  function holdReleasedAssets(board: Board, releasedAssetIds: ReadonlySet<string>): void {
    const assetRefCount = boardIndexOf(board.elements).assetRefCount;
    for (const releasedAssetId of releasedAssetIds) {
      if (!assetRefCount.has(releasedAssetId)) assets.hold(releasedAssetId, RELEASE_HOLD_MS);
    }
  }

  function hasNearBox(board: Board, boxId: string): boolean {
    const dependentIds = boardIndexOf(board.elements).dependentIdsByBoxId.get(boxId) ?? [];
    for (const dependentId of dependentIds) {
      const dependent = board.elements[dependentId];
      if (dependent?.kind === 'box' && dependent.near?.of === boxId) return true;
    }
    return false;
  }

  function basePinPositionsFor(board: Board, ops: readonly Op[]): Promise<PinPositions | null> {
    const removedBoxIds = ops.flatMap((op) => (op.op === 'remove' && board.elements[op.id]?.kind === 'box' ? [op.id] : []));
    const isPinNeeded = removedBoxIds.some((boxId) => hasNearBox(board, boxId)) || ops.some((op) => op.op === 'add' || op.op === 'set');
    if (removedBoxIds.length === 0 || !isPinNeeded) return Promise.resolve(null);
    const ids = ops.flatMap((op) => (op.op === 'remove' || op.op === 'set' ? [op.id] : []));
    return tiles.pinPositionsOf(board, ids).catch((error: unknown) => {
      logger.warn(`[whiteboard] board ${board.id} could not be laid out to pin boxes, so they keep their drawn anchors: ${errorMessage(error)}`);
      return null;
    });
  }

  async function applyOpsToRecord(record: BoardRecord, ops: readonly Op[], author: Author): Promise<AppliedOps> {
    const basePinPositions = await basePinPositionsFor(record.board, ops);
    const result = stageOps(record.board, ops, author, now(), basePinPositions);
    if (!result.ok) return result;
    const refusalText = stagedRefusalOf(record.board, result.afterById);
    if (refusalText) return { ok: false, error: refusalText };
    const releasedAssetIds = new Set([...result.afterById.keys()].flatMap((id) => assetIdOf(record.board.elements[id]) ?? []));
    const next = recordPut(record, result);
    const patch: WhiteboardPatch = {
      boardId: record.board.id, fromVersion: record.board.version, toVersion: next.board.version,
      author: { id: author.id, name: author.name }, updatedAt: next.board.updatedAt, diff: result.diff, before: result.before,
    };
    const commit = (): void => {
      result.commit();
      holdReleasedAssets(record.board, releasedAssetIds);
    };
    return { ok: true, record: next, patch, staged: { diff: result.diff, afterById: result.afterById, commit } };
  }

  async function reviewFor(board: Board, { readsChanges }: { readsChanges: boolean }): Promise<BoardReview> {
    const codeContext = board.codeSessionId ? codeContextOf(board.codeSessionId) : null;
    if (!codeContext) return reviewBoard(board, null);
    const fileFactByPath = await readFileFacts(codeContext.root, referencedPaths(board));
    const changes = readsChanges ? await readChangeFacts(codeContext.buildChangeMap) : null;
    return reviewBoard(board, { fileFactByPath, changes });
  }

  async function readDocOf(boardId: string, boxId: string): Promise<WhiteboardReply> {
    const board = recordsByBoardId.get(boardId)?.board;
    if (!board) return refusal(404, DELETED_BOARD_TEXT);
    const element = board.elements[boxId];
    if (element?.kind !== 'box' || element.media?.kind !== 'doc') {
      return refusal(400, `${boxId} on board "${board.title}" holds no document; whiteboard doc reads a box whose media kind is doc`);
    }
    const text = await assets.readDocText(element.media);
    if (text === null) return refusal(404, `the document ${boxId} on board "${board.title}" shows is not stored any more`);
    return { status: 200, body: { ok: true, box: boxId, text } };
  }

  async function reviewedPut(boardId: string, ops: readonly Op[], author: Author): Promise<WhiteboardReply> {
    const reply = await putOps(boardId, ops, author);
    const board = recordsByBoardId.get(boardId)?.board;
    if (!reply.body.ok || !('version' in reply.body) || 'elements' in reply.body || !board) return reply;
    const { anchorWarnings, stepWarnings } = await reviewFor(board, { readsChanges: stepBoxesOf(board).length > 0 });
    if (anchorWarnings.length === 0 && stepWarnings.length === 0) return reply;
    return { status: reply.status, body: { ...reply.body, warnings: cappedWarnings([...reply.body.warnings ?? [], ...anchorWarnings, ...stepWarnings]) } };
  }

  function focusFor(boardId: string, readerId: string, requested: BoardRegion | undefined): BoardRegion | null {
    const operatorView = tiles.operatorViewOf(boardId)?.view ?? null;
    const focusByBoardId = agentFocusBySessionId.get(readerId) ?? new Map<string, AgentFocus>();
    agentFocusBySessionId.set(readerId, focusByBoardId);
    if (requested) {
      focusByBoardId.set(boardId, { region: requested, operatorView });
      return requested;
    }
    const kept = focusByBoardId.get(boardId);
    if (kept && kept.operatorView === operatorView) return kept.region;
    focusByBoardId.delete(boardId);
    return operatorView;
  }

  async function readBoard(boardId: string, readerId: string, request: Extract<WhiteboardAgentRequest, { sub: 'get' }>): Promise<WhiteboardReply> {
    const reply = await changeRecord(boardId, async (record) => {
      const changes = changesForReader(record, readerId);
      const next = request.peek === true || record.cursorBySessionId[readerId] === record.board.version ? record : markRead(record, readerId);
      if (isWholeBoardRead(record.board, request)) return { ok: true, record: next, reply: { status: 200, body: { ok: true, board: boardSnapshotOf(record.board), changes } } };
      const pageStart = pageStartOf(record.board, request.cursor);
      if (!pageStart.ok) return { ok: false, reply: pageStart.reply };
      const pagedFocus = request.cursor === undefined || request.region ? null : pagedFocusBySessionId.get(readerId)?.get(boardId) ?? null;
      if (request.cursor !== undefined && !request.region && !pagedFocus) return { ok: false, reply: refusal(409, 'that cursor is not from a read of this board by this session; read again without cursor') };
      const region = await tiles.regionOf(record.board, pagedFocus ?? focusFor(boardId, readerId, request.region), true).catch((error: unknown) => {
        logger.warn(`[whiteboard] board ${boardId} could not be laid out for a read: ${errorMessage(error)}`);
        return null;
      });
      if (!region?.outline) return { ok: false, reply: refusal(503, 'the board layout could not be read; try again') };
      const { focus, outline } = region;
      const pagedFocusByBoardId = pagedFocusBySessionId.get(readerId) ?? new Map<string, BoardRegion>();
      pagedFocusByBoardId.set(boardId, focus);
      pagedFocusBySessionId.set(readerId, pagedFocusByBoardId);
      const page = pageReplyOf(record.board, region.elementIds, pageStart.offset);
      return { ok: true, record: next, reply: { status: 200, body: { ok: true, board: summarizeBoard(next), outline, focus, ...page, changes } } };
    });
    if (request.review !== true || !reply.body.ok || !('changes' in reply.body)) return reply;
    const board = recordsByBoardId.get(boardId)?.board;
    if (!board) return reply;
    return { status: reply.status, body: { ...reply.body, review: await reviewFor(board, { readsChanges: true }) } };
  }

  async function queryBoard(boardId: string, query: Extract<WhiteboardAgentRequest, { sub: 'query' }>): Promise<WhiteboardReply> {
    const board = recordsByBoardId.get(boardId)?.board;
    if (!board) return refusal(404, `no board ${boardId}`);
    const pageStart = pageStartOf(board, query.cursor);
    if (!pageStart.ok) return pageStart.reply;
    const { offset } = pageStart;
    if (query.ids) {
      const missingIds = query.ids.filter((elementId) => !board.elements[elementId]);
      return { status: 200, body: { ok: true, version: board.version, ...pageReplyOf(board, query.ids, offset), missingIds } };
    }
    if (query.region) {
      const region = await tiles.regionOf(board, query.region, false).catch((error: unknown) => {
        logger.warn(`[whiteboard] board ${boardId} could not be laid out for a query: ${errorMessage(error)}`);
        return null;
      });
      if (!region) return refusal(503, 'the board layout could not be read, so the query found nothing; try again');
      return { status: 200, body: { ok: true, version: board.version, ...pageReplyOf(board, region.elementIds, offset), missingIds: [] } };
    }
    const matchedIds = await store.searchText(boardId, query.text ?? '', offset + WHITEBOARD_LIMITS.readPage + 1).catch((error: unknown) => {
      logger.warn(`[whiteboard] text query on board ${boardId} failed: ${errorMessage(error)}`);
      return null;
    });
    if (!matchedIds) return refusal(503, 'the board text index could not be read, so the query found nothing; try again');
    return { status: 200, body: { ok: true, version: board.version, ...pageReplyOf(board, matchedIds, offset), missingIds: [] } };
  }

  function connectionReply(record: BoardRecord, note: string): WhiteboardReply {
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note } };
  }

  function connectBoard(boardId: string, sessionId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, async (record) => {
      const claimed = record.board.codeSessionId === null ? await applyOpsToRecord(record, [{ op: 'board', codeSessionId: sessionId }], GLIMMERVOID_AUTHOR) : null;
      if (!claimed?.ok) {
        const next = connectSession(record, sessionId);
        return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE) };
      }
      const next = connectSession(claimed.record, sessionId);
      return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE), patch: claimed.patch, staged: claimed.staged };
    });
  }

  function disconnectBoard(boardId: string, sessionId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, (record) => {
      const next = disconnectSession(record, sessionId);
      return { ok: true, record: next, reply: connectionReply(next, 'this session is no longer told when this board changes') };
    });
  }

  async function clearLinksTo(deletedBoardId: string): Promise<void> {
    const unlinkPuts = [...recordsByBoardId.values()].flatMap((record) => {
      const ops: Op[] = stepBoxesOf(record.board)
        .filter((stepBox) => stepBox.step.linkedBoardId === deletedBoardId)
        .map((stepBox) => ({ op: 'set', id: stepBox.id, fields: { step: { linkedBoardId: null } } }));
      if (ops.length === 0) return [];
      const linkingBoardId = record.board.id;
      return [putOps(linkingBoardId, ops, GLIMMERVOID_AUTHOR).then((reply) => {
        if (!reply.body.ok) logger.warn(`[whiteboard] steps on board ${linkingBoardId} still link to deleted board ${deletedBoardId}: ${reply.body.error}`);
      })];
    });
    await Promise.all(unlinkPuts);
  }

  async function removeBoard(boardId: string): Promise<WhiteboardReply> {
    const reply = await removeBoardRecord(boardId);
    if (reply.body.ok) await clearLinksTo(boardId);
    return reply;
  }

  function removeBoardRecord(boardId: string): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, DELETED_BOARD_TEXT);
      return deleteRecordInSlot(current);
    });
  }

  async function deleteRecordInSlot(current: BoardRecord): Promise<WhiteboardReply> {
    const boardId = current.board.id;
    try {
      await fsp.rm(path.join(boardsRoot, `${boardId}${BOARD_FILE_EXTENSION}`), { force: true });
      await store.remove(boardId);
    } catch (error) {
      logger.warn(`[whiteboard] board ${boardId} could not be deleted: ${errorMessage(error)}`);
      return refusal(500, 'the board could not be deleted, so it is still here');
    }
    recordsByBoardId.delete(boardId);
    deletedBoardIds.add(boardId);
    tiles.forgetBoard(boardId);
    broadcastControl({ type: 'whiteboard-removed', boardId });
    broadcastSummariesIfChanged(current, null);
    void sweepUnusedAssets();
    return { status: 200, body: { ok: true, version: current.board.version } };
  }

  function deleteOwnBoard(boardId: string, callerId: string): Promise<WhiteboardReply> {
    if (recordsByBoardId.get(boardId)?.createdBy !== callerId) {
      return Promise.resolve(refusal(403, 'a session deletes only a board it created, so this board is still here; the operator can delete it from the dashboard'));
    }
    return removeBoard(boardId);
  }

  async function operatorBoardCommand(boardId: string, command: (foundBoardId: string) => Promise<WhiteboardReply>): Promise<OperatorReply> {
    await loaded;
    const found = findBoardId(boardId);
    if (!found.ok) return operatorReplyOf(found.reply);
    return operatorReplyOf(await command(found.boardId));
  }

  const handleOperator: WhiteboardPort['handleOperator'] = {
    create: async (title) => {
      await loaded;
      return operatorReplyOf(await createBoardFor(null, title));
    },
    put: (boardId, ops) => operatorBoardCommand(boardId, (foundBoardId) => putOps(foundBoardId, ops, OPERATOR_AUTHOR)),
    remove: (boardId) => operatorBoardCommand(boardId, removeBoard),
    get: (boardId) => operatorBoardCommand(boardId, async (foundBoardId) => {
      const record = recordsByBoardId.get(foundBoardId);
      if (!record) return refusal(404, DELETED_BOARD_TEXT);
      return { status: 200, body: { ok: true, board: boardSnapshotOf(record.board), changes: [] } };
    }),
    review: async (boardId) => {
      await loaded;
      const record = recordsByBoardId.get(boardId);
      if (!record) return { ok: false, error: DELETED_BOARD_TEXT };
      return { ok: true, error: null, review: await reviewFor(record.board, { readsChanges: true }) };
    },
    connect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => connectBoard(foundBoardId, sessionId)),
    disconnect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => disconnectBoard(foundBoardId, sessionId)),
  };

  async function closeConnections(boardId: string, closedSessionIds: readonly string[]): Promise<void> {
    const isDeleted = await writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return false;
      const next = closedSessionIds.reduce(disconnectSession, current);
      if (hasNoConnectedSessions(next)) return (await deleteRecordInSlot(current)).body.ok;
      if (await saveRecordInSlot(current, next, null)) broadcastSummariesIfChanged(current, next);
      return false;
    });
    if (isDeleted) await clearLinksTo(boardId);
  }

  async function forgetClosedSessions(isClosedSession: (sessionId: string) => boolean): Promise<void> {
    await loaded;
    for (const sessionId of [...announcedVersionByBoardIdBySessionId.keys()].filter(isClosedSession)) announcedVersionByBoardIdBySessionId.delete(sessionId);
    const closedConnectionsPerBoard = [...recordsByBoardId].map(([boardId, record]) => ({ boardId, closedSessionIds: Object.keys(record.cursorBySessionId).filter(isClosedSession) }));
    await Promise.all(closedConnectionsPerBoard
      .filter(({ closedSessionIds }) => closedSessionIds.length > 0)
      .map(({ boardId, closedSessionIds }) => closeConnections(boardId, closedSessionIds)));
  }

  function forgetSession(sessionId: string): Promise<void> {
    agentFocusBySessionId.delete(sessionId);
    pagedFocusBySessionId.delete(sessionId);
    return forgetClosedSessions((connectedSessionId) => connectedSessionId === sessionId);
  }

  function isConnected(sessionId: string): boolean {
    return [...recordsByBoardId.values()].some((record) => sessionId in record.cursorBySessionId);
  }

  function takeBoardNotice(sessionId: string): string | null {
    const announcedVersionByBoardId = announcedVersionByBoardIdBySessionId.get(sessionId) ?? new Map<string, number>();
    const notice = boardNoticeFor([...recordsByBoardId.values()], sessionId, announcedVersionByBoardId);
    if (!notice) return null;
    for (const { boardId, version } of notice.announced) announcedVersionByBoardId.set(boardId, version);
    announcedVersionByBoardIdBySessionId.set(sessionId, announcedVersionByBoardId);
    return notice.text;
  }

  async function attachMedia(caller: WhiteboardCaller, requestedPath: string): Promise<WhiteboardReply> {
    if (caller.remoteWorkspace) return refusal(409, `attach reads files on the Glimmervoid machine, and this session runs in the Coder workspace ${caller.remoteWorkspace}, so its files are not there`);
    const ingested = await assets.ingestFile(path.resolve(caller.cwd ?? boardsRoot, requestedPath));
    if (!ingested.ok) return refusal(ingested.status, ingested.error);
    const note = `put a box with "media":${JSON.stringify({ ...ingested.media, alt: '<what it shows>' })} ${attachedMediaUse(ingested.media)}`;
    return { status: 200, body: { ok: true, media: ingested.media, note } };
  }

  async function pageTitleOf(sourcePath: string): Promise<string | null> {
    const handle = await fsp.open(sourcePath, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const firstChunk = Buffer.alloc(SHOWN_SNIFF_BYTES);
      const { bytesRead } = await handle.read(firstChunk, 0, SHOWN_SNIFF_BYTES, 0);
      return readPageTitle(firstChunk.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async function showBoardIdFor(caller: WhiteboardCaller): Promise<{ ok: true; boardId: string } | { ok: false; reply: WhiteboardReply }> {
    const pickedBoardId = pickShowBoardId([...recordsByBoardId.values()], caller.id);
    if (pickedBoardId) return { ok: true, boardId: pickedBoardId };
    const created = await createBoardFor(caller, caller.name.slice(0, WHITEBOARD_LIMITS.title));
    if (!created.body.ok || !('board' in created.body)) return { ok: false, reply: created };
    return { ok: true, boardId: created.body.board.id };
  }

  async function showOnBoard(caller: WhiteboardCaller, requestedPath: string, caption: string | null): Promise<WhiteboardReply> {
    if (caller.remoteWorkspace) return refusal(409, `show reads files on the Glimmervoid machine, and this session runs in the Coder workspace ${caller.remoteWorkspace}, so its files are not there`);
    const sourcePath = path.resolve(caller.cwd ?? boardsRoot, requestedPath);
    const ingested = await assets.ingestFile(sourcePath);
    if (!ingested.ok) return refusal(ingested.status, ingested.error);
    const pageTitle = ingested.media.kind === 'page' ? await pageTitleOf(sourcePath) : null;
    const target = await showBoardIdFor(caller);
    if (!target.ok) return target.reply;
    const card = { media: ingested.media, title: pageTitle ?? path.basename(sourcePath), caption };
    const author: Author = { id: caller.id, name: caller.name };
    return changeRecord(target.boardId, async (record) => {
      const layout = await tiles.summaryOf(record.board).catch((error: unknown) => {
        logger.warn(`[whiteboard] board ${record.board.id} could not be laid out to place a shown file: ${errorMessage(error)}`);
        return null;
      });
      if (!layout) return { ok: false, reply: refusal(503, 'the board layout could not be read, so nothing was shown; try again') };
      const shownBox = shownBoxOp(record.board, layout.chrome.bounds, card);
      if (!shownBox.ok) return { ok: false, reply: refusal(400, `${shownBox.error}, so nothing changed`) };
      const { op, boxId } = shownBox;
      const applied = await applyOpsToRecord(record, [op], author);
      if (!applied.ok) return { ok: false, reply: refusal(400, `${applied.error}, so nothing changed`) };
      const { board } = applied.record;
      const note = `showed ${card.title} as box ${boxId} on board "${board.title}" (${board.id}), where the operator sees it; change it with whiteboard put`;
      return { ok: true, record: applied.record, reply: { status: 200, body: { ok: true, board: summarizeBoard(applied.record), note } }, patch: applied.patch, staged: applied.staged };
    });
  }

  async function handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply> {
    await loaded;
    if (request.sub === 'new') return createBoardFor(caller, request.title);
    if (request.sub === 'attach') return attachMedia(caller, request.path);
    if (request.sub === 'show') return showOnBoard(caller, request.path, request.caption?.trim() || null);
    if (request.sub === 'list') {
      return { status: 200, body: { ok: true, boards: [...recordsByBoardId.values()].map(summarizeBoard) } };
    }
    const found = findBoardId(request.board);
    if (!found.ok) return found.reply;
    const author: Author = { id: caller.id, name: caller.name };
    switch (request.sub) {
      case 'connect': return connectBoard(found.boardId, caller.id);
      case 'disconnect': return disconnectBoard(found.boardId, caller.id);
      case 'get': return readBoard(found.boardId, caller.id, request);
      case 'query': return queryBoard(found.boardId, request);
      case 'put': return reviewedPut(found.boardId, request.ops, author);
      case 'resolve': return putOps(found.boardId, [{ op: 'resolve', id: request.note }], author);
      case 'doc': return readDocOf(found.boardId, request.box);
      case 'delete': return deleteOwnBoard(found.boardId, caller.id);
    }
  }

  const layouts: WhiteboardLayouts = {
    summaryOf: (boardId) => {
      const board = recordsByBoardId.get(boardId)?.board;
      return board ? tiles.summaryOf(board) : Promise.resolve(null);
    },
    pictureImagesOf: (boardId) => {
      const board = recordsByBoardId.get(boardId)?.board;
      return board ? tiles.pictureImagesOf(board) : Promise.resolve(null);
    },
    pictureOf: (boardId, dataUriByAssetId) => {
      const board = recordsByBoardId.get(boardId)?.board;
      return board ? tiles.pictureOf(board, dataUriByAssetId) : Promise.resolve(null);
    },
  };

  return { loaded, assets, handleAgent, handleOperator, forgetSession, forgetClosedSessions, takeBoardNotice, isConnected, snapshotMessage, tiles, layouts };
}

export { createWhiteboardWiring, WHITEBOARDS_FOLDER_NAME };
export type { WhiteboardLayouts, WhiteboardPort };
