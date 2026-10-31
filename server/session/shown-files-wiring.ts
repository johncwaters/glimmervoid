import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { SHOWN_FILES_KEPT_PER_SESSION, ShownFile } from '../../shared/contracts/session.ts';
import { buildUploadFilename, isSafePathSegment, planUploadRetention } from '../core/upload-core.ts';
import { decideShownKind, filesAfterRetention, readPageTitle, shownMimeForFilename, thumbnailFilenameOf, thumbnailOwnerIdOf, thumbnailRecipeFor, SHOWN_SNIFF_BYTES } from '../core/shown-files-core.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { makeShownThumbnail } from './shown-thumbnails.ts';

const SHOWN_FOLDER_NAME = 'shown';
const INDEX_FILENAME = 'index.json';
const INCOMING_PREFIX = '.incoming-';
const ShownIndex = z.array(ShownFile);

interface ShownSession {
  id: string;
}

interface ShownArrival {
  incomingPath: string;
  name: string;
  caption: string | null;
  sizeBytes: number;
}

type AdmitReply =
  | { ok: true; file: ShownFile }
  | { ok: false; status: number; error: string };

interface ServableShownFile {
  path: string;
  mime: string;
  sizeBytes: number;
}

interface ShownFilesPort {
  reserveIncomingPath(sessionId: string): Promise<string>;
  admit(session: ShownSession, arrival: ShownArrival): Promise<AdmitReply>;
  findServable(sessionId: string, filename: string): ServableShownFile | null;
  snapshotMessage(): Record<string, unknown>;
}

async function readFirstChunk(filePath: string): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SHOWN_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readSessionIndex(indexPath: string): Promise<ShownFile[]> {
  const text = await fsp.readFile(indexPath, 'utf8').catch(() => null);
  if (text === null) return [];
  const parsed = ShownIndex.safeParse(parseJsonOrNull(text));
  return parsed.success ? parsed.data : [];
}

async function writeSessionIndex(indexPath: string, files: readonly ShownFile[]): Promise<void> {
  const pendingPath = `${indexPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(pendingPath, JSON.stringify(files), { mode: 0o600 });
  await fsp.rename(pendingPath, indexPath);
}

function createShownFilesWiring({ shownRoot, broadcastControl, now = Date.now }: {
  shownRoot: string;
  broadcastControl: (message: ControlMessageRecord) => void;
  now?: () => number;
}): ShownFilesPort & { loaded: Promise<void> } {
  const filesBySessionId = new Map<string, ShownFile[]>();
  const indexQueue = createKeyedSerialQueue();
  const thumbnailSizeByPath = new Map<string, number>();

  function sessionDir(sessionId: string): string {
    return path.join(shownRoot, sessionId);
  }

  async function loadIndexes(): Promise<void> {
    const sessionIds = await fsp.readdir(shownRoot).catch(() => []);
    for (const sessionId of sessionIds) {
      if (!isSafePathSegment(sessionId)) continue;
      const files = await readSessionIndex(path.join(sessionDir(sessionId), INDEX_FILENAME));
      if (files.length > 0 && !filesBySessionId.has(sessionId)) filesBySessionId.set(sessionId, files);
      for (const file of files) if (file.hasThumbnail) await recordThumbnailSize(path.join(sessionDir(sessionId), thumbnailFilenameOf(file.id)));
    }
  }

  async function recordThumbnailSize(thumbnailPath: string): Promise<boolean> {
    const stats = await fsp.stat(thumbnailPath).catch(() => null);
    if (!stats) return false;
    thumbnailSizeByPath.set(thumbnailPath, stats.size);
    return true;
  }

  async function reserveIncomingPath(sessionId: string): Promise<string> {
    const dir = sessionDir(sessionId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${INCOMING_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  }

  async function recordAdmitted(sessionId: string, file: ShownFile): Promise<void> {
    const dir = sessionDir(sessionId);
    const current = filesBySessionId.get(sessionId) ?? await readSessionIndex(path.join(dir, INDEX_FILENAME));
    const withNewest = [...current, file];
    const droppedIds = planUploadRetention(withNewest.map((shown) => shown.id), { keep: SHOWN_FILES_KEPT_PER_SESSION, justWritten: file.id });
    const kept = filesAfterRetention(withNewest, droppedIds);
    await writeSessionIndex(path.join(dir, INDEX_FILENAME), kept);
    filesBySessionId.set(sessionId, kept);
    const droppedFilenames = droppedIds.flatMap((droppedId) => [droppedId, thumbnailFilenameOf(droppedId)]);
    for (const droppedId of droppedIds) thumbnailSizeByPath.delete(path.join(dir, thumbnailFilenameOf(droppedId)));
    await Promise.all(droppedFilenames.map((droppedFilename) => fsp.unlink(path.join(dir, droppedFilename)).catch(() => {})));
  }

  async function admit(session: ShownSession, arrival: ShownArrival): Promise<AdmitReply> {
    const firstChunk = await readFirstChunk(arrival.incomingPath);
    const verdict = decideShownKind(firstChunk, arrival.name);
    if (!verdict.ok) {
      await fsp.unlink(arrival.incomingPath).catch(() => {});
      return { ok: false, status: 415, error: verdict.error };
    }
    const shownAt = now();
    const fileId = buildUploadFilename({ now: shownAt, randomSuffix: crypto.randomBytes(4).toString('hex'), extension: verdict.extension });
    const storedPath = path.join(sessionDir(session.id), fileId);
    await fsp.rename(arrival.incomingPath, storedPath);
    const thumbnailPath = path.join(sessionDir(session.id), thumbnailFilenameOf(fileId));
    const hasThumbnail = await makeShownThumbnail(thumbnailRecipeFor(verdict.kind), storedPath, thumbnailPath) && await recordThumbnailSize(thumbnailPath);
    const file: ShownFile = {
      id: fileId,
      name: arrival.name,
      caption: arrival.caption,
      kind: verdict.kind,
      mime: verdict.mime,
      sizeBytes: arrival.sizeBytes,
      pageTitle: verdict.kind === 'page' ? readPageTitle(firstChunk) : null,
      shownAt,
      hasThumbnail,
    };
    await indexQueue.run(session.id, () => recordAdmitted(session.id, file));
    broadcastControl({ type: 'session-shown', id: session.id, files: [file] });
    return { ok: true, file };
  }

  function findServable(sessionId: string, filename: string): ServableShownFile | null {
    if (!isSafePathSegment(sessionId) || !isSafePathSegment(filename)) return null;
    const thumbnailOwnerId = thumbnailOwnerIdOf(filename);
    if (thumbnailOwnerId !== null) return findServableThumbnail(sessionId, thumbnailOwnerId, filename);
    const file = filesBySessionId.get(sessionId)?.find((shown) => shown.id === filename);
    const mime = shownMimeForFilename(filename);
    if (!file || !mime) return null;
    return { path: path.join(sessionDir(sessionId), filename), mime, sizeBytes: file.sizeBytes };
  }

  function findServableThumbnail(sessionId: string, ownerId: string, filename: string): ServableShownFile | null {
    const owner = filesBySessionId.get(sessionId)?.find((shown) => shown.id === ownerId);
    const mime = shownMimeForFilename(filename);
    if (!owner?.hasThumbnail || !mime) return null;
    const thumbnailPath = path.join(sessionDir(sessionId), filename);
    const sizeBytes = thumbnailSizeByPath.get(thumbnailPath);
    if (sizeBytes === undefined) return null;
    return { path: thumbnailPath, mime, sizeBytes };
  }

  function snapshotMessage(): Record<string, unknown> {
    return { type: 'session-shown-snapshot', sessions: Object.fromEntries(filesBySessionId) };
  }

  return { reserveIncomingPath, admit, findServable, snapshotMessage, loaded: loadIndexes() };
}

export { createShownFilesWiring, SHOWN_FOLDER_NAME };
export type { ShownFilesPort };
