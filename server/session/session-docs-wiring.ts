import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { SESSION_DOC_BODY_CAP_BYTES, SESSION_DOCS_MAX } from '../../shared/contracts/session.ts';
import type { AgentEditRequest, SessionDoc } from '../../shared/contracts/session.ts';
import { isPathInside } from '../../shared/paths.ts';
import { openContainedFile } from '../contained-file.ts';
import type { OpenedFile } from '../contained-file.ts';
import { DOC_IMAGE_CAP_BYTES, decodeDocBytes, describeDocRefusal, encodeDocText, hashDocBytes, imageMimeOf, imageReferencesOf, withSurfacedDoc } from './core/session-docs-core.ts';
import type { DocRefusal } from './core/session-docs-core.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';

interface DocSession {
  id: string;
  effectiveCwd(): string;
  once(event: 'teardown', listener: () => void): unknown;
}

type SurfaceReply =
  | { ok: true; doc: SessionDoc }
  | { ok: false; error: string };

type ReadReply =
  | { ok: true; text: string; hash: string }
  | { ok: false; error: string };

type ImageReply =
  | { ok: true; mime: string; base64: string }
  | { ok: false; error: string };

type SaveReply =
  | { ok: true; hash: string }
  | { ok: false; error: string; conflict: boolean };

interface LoadedDoc {
  file: OpenedFile;
  bytes: Buffer;
}

type LoadOutcome = { ok: true; loaded: LoadedDoc } | { ok: false; reason: DocRefusal };

type VerifiedOpen = { ok: true; file: OpenedFile } | { ok: false; reason: DocRefusal };

interface SessionDocsPort {
  surface(session: DocSession, request: AgentEditRequest): Promise<SurfaceReply>;
  read(session: DocSession, docPath: string): Promise<ReadReply>;
  readImage(session: DocSession, docPath: string, imageSource: string): Promise<ImageReply>;
  save(session: DocSession, docPath: string, text: string, baseHash: string): Promise<SaveReply>;
  snapshotMessage(): Record<string, unknown>;
}

async function readAtMostCapPlusOneByte(handle: FileHandle, capBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(capBytes + 1);
  let filledBytes = 0;
  while (filledBytes < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, filledBytes, buffer.byteLength - filledBytes, filledBytes);
    if (bytesRead === 0) break;
    filledBytes += bytesRead;
  }
  return buffer.subarray(0, filledBytes);
}

async function readOpenedDoc(file: OpenedFile): Promise<LoadOutcome> {
  if (file.stat.size > SESSION_DOC_BODY_CAP_BYTES) return { ok: false, reason: 'too-large' };
  try {
    return { ok: true, loaded: { file, bytes: await readAtMostCapPlusOneByte(file.handle, SESSION_DOC_BODY_CAP_BYTES) } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

async function refusalForOpenedInode(file: OpenedFile, root: string): Promise<DocRefusal | null> {
  if (file.stat.nlink > 1) return 'hard-linked';
  const kernelPath = await fs.promises.readlink(`/proc/self/fd/${file.handle.fd}`).catch(() => null);
  if (kernelPath === null) return null;
  const realRoot = await fs.promises.realpath(root).catch(() => null);
  if (realRoot === null) return 'root-unresolvable';
  if (!isPathInside(realRoot, kernelPath, { allowEqual: false })) return 'outside-root';
  return null;
}

async function openVerifiedDoc(candidate: string, root: string, opensForWriting: boolean): Promise<VerifiedOpen> {
  const opened = opensForWriting ? await openContainedFile(candidate, root, false, true) : await openContainedFile(candidate, root);
  if (!opened.ok) return opened;
  const refusal = await refusalForOpenedInode(opened.file, root);
  if (refusal === null) return opened;
  await opened.file.handle.close().catch(() => {});
  return { ok: false, reason: refusal };
}

async function loadContainedDoc(candidate: string, root: string): Promise<LoadOutcome> {
  const opened = await openVerifiedDoc(candidate, root, false);
  if (!opened.ok) return opened;
  try {
    return await readOpenedDoc(opened.file);
  } finally {
    await opened.file.handle.close().catch(() => {});
  }
}

async function loadContainedImage(candidate: string, root: string): Promise<LoadOutcome> {
  const opened = await openVerifiedDoc(candidate, root, false);
  if (!opened.ok) return opened;
  try {
    if (imageMimeOf(opened.file.realPath) === null) return { ok: false, reason: 'not-an-image' };
    if (opened.file.stat.size > DOC_IMAGE_CAP_BYTES) return { ok: false, reason: 'image-too-large' };
    const bytes = await readAtMostCapPlusOneByte(opened.file.handle, DOC_IMAGE_CAP_BYTES);
    if (bytes.byteLength > DOC_IMAGE_CAP_BYTES) return { ok: false, reason: 'image-too-large' };
    return { ok: true, loaded: { file: opened.file, bytes } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await opened.file.handle.close().catch(() => {});
  }
}

async function overwriteThroughHandle(handle: FileHandle, bytes: Buffer): Promise<void> {
  let writtenBytes = 0;
  while (writtenBytes < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, writtenBytes, bytes.byteLength - writtenBytes, writtenBytes);
    writtenBytes += bytesWritten;
  }
  await handle.truncate(bytes.byteLength);
  await handle.sync();
}

async function overwriteIfUnchanged(file: OpenedFile, text: string, baseHash: string): Promise<SaveReply> {
  const outcome = await readOpenedDoc(file);
  if (!outcome.ok) return { ok: false, error: describeDocRefusal(outcome.reason), conflict: false };
  if (hashDocBytes(outcome.loaded.bytes) !== baseHash) return { ok: false, error: describeDocRefusal('changed-on-disk'), conflict: true };
  const current = decodeDocBytes(outcome.loaded.bytes);
  const encoded = encodeDocText(text, current.ok && current.usesCrlf);
  if (!encoded.ok) return { ok: false, error: describeDocRefusal(encoded.reason), conflict: false };
  const encodedBytes = Buffer.from(encoded.content, 'utf8');
  await overwriteThroughHandle(file.handle, encodedBytes);
  return { ok: true, hash: hashDocBytes(encodedBytes) };
}

async function nameWithinRoot(root: string, realPath: string): Promise<string> {
  const realRoot = await fs.promises.realpath(root).catch(() => root);
  return path.relative(realRoot, realPath);
}

function createSessionDocsWiring({ broadcastControl, now = Date.now }: {
  broadcastControl: (message: ControlMessageRecord) => void;
  now?: () => number;
}): SessionDocsPort {
  const docsBySessionId = new Map<string, SessionDoc[]>();
  const surfacedImagesByDocPathBySessionId = new Map<string, Map<string, Set<string>>>();
  const saveQueue = createKeyedSerialQueue();

  function broadcastDocs(sessionId: string): void {
    broadcastControl({ type: 'session-docs-changed', id: sessionId, docs: docsBySessionId.get(sessionId) ?? [] });
  }

  function forgetSession(sessionId: string): void {
    surfacedImagesByDocPathBySessionId.delete(sessionId);
    if (!docsBySessionId.delete(sessionId)) return;
    broadcastDocs(sessionId);
  }

  function isSurfaced(session: DocSession, docPath: string): boolean {
    return (docsBySessionId.get(session.id) ?? []).some((doc) => doc.path === docPath);
  }

  function rememberSurfacedImages(sessionId: string, surfacedDocs: readonly SessionDoc[], docPath: string, imageSources: Set<string>): void {
    const previousImages = surfacedImagesByDocPathBySessionId.get(sessionId) ?? new Map<string, Set<string>>();
    const keptImages = new Map(surfacedDocs.flatMap((doc) => {
      const docImages = previousImages.get(doc.path);
      return docImages ? [[doc.path, docImages] as const] : [];
    }));
    keptImages.set(docPath, imageSources);
    surfacedImagesByDocPathBySessionId.set(sessionId, keptImages);
  }

  async function surface(session: DocSession, request: AgentEditRequest): Promise<SurfaceReply> {
    const root = session.effectiveCwd();
    const outcome = await loadContainedDoc(path.resolve(root, request.path), root);
    if (!outcome.ok) return { ok: false, error: describeDocRefusal(outcome.reason) };
    const decoded = decodeDocBytes(outcome.loaded.bytes);
    if (!decoded.ok) return { ok: false, error: describeDocRefusal(decoded.reason) };
    const realPath = outcome.loaded.file.realPath;
    const doc: SessionDoc = { path: realPath, name: await nameWithinRoot(root, realPath), surfacedAt: now() };
    if (!docsBySessionId.has(session.id)) session.once('teardown', () => forgetSession(session.id));
    const surfacedDocs = withSurfacedDoc(docsBySessionId.get(session.id) ?? [], doc, SESSION_DOCS_MAX);
    docsBySessionId.set(session.id, surfacedDocs);
    rememberSurfacedImages(session.id, surfacedDocs, realPath, imageReferencesOf(decoded.text));
    broadcastDocs(session.id);
    return { ok: true, doc };
  }

  async function read(session: DocSession, docPath: string): Promise<ReadReply> {
    if (!isSurfaced(session, docPath)) return { ok: false, error: describeDocRefusal('not-surfaced') };
    const outcome = await loadContainedDoc(docPath, session.effectiveCwd());
    if (!outcome.ok) return { ok: false, error: describeDocRefusal(outcome.reason) };
    const decoded = decodeDocBytes(outcome.loaded.bytes);
    if (!decoded.ok) return { ok: false, error: describeDocRefusal(decoded.reason) };
    return { ok: true, text: decoded.text, hash: hashDocBytes(outcome.loaded.bytes) };
  }

  async function readImage(session: DocSession, docPath: string, imageSource: string): Promise<ImageReply> {
    if (!isSurfaced(session, docPath)) return { ok: false, error: describeDocRefusal('not-surfaced') };
    const surfacedImages = surfacedImagesByDocPathBySessionId.get(session.id)?.get(docPath);
    if (!surfacedImages?.has(imageSource)) return { ok: false, error: describeDocRefusal('image-not-referenced') };
    const mime = imageMimeOf(imageSource);
    if (mime === null) return { ok: false, error: describeDocRefusal('not-an-image') };
    const outcome = await loadContainedImage(path.resolve(path.dirname(docPath), imageSource), session.effectiveCwd());
    if (!outcome.ok) return { ok: false, error: describeDocRefusal(outcome.reason) };
    return { ok: true, mime, base64: outcome.loaded.bytes.toString('base64') };
  }

  async function writeIfUnchanged(session: DocSession, docPath: string, text: string, baseHash: string): Promise<SaveReply> {
    const opened = await openVerifiedDoc(docPath, session.effectiveCwd(), true);
    if (!opened.ok) return { ok: false, error: describeDocRefusal(opened.reason), conflict: false };
    try {
      return await overwriteIfUnchanged(opened.file, text, baseHash);
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
  }

  async function save(session: DocSession, docPath: string, text: string, baseHash: string): Promise<SaveReply> {
    if (!isSurfaced(session, docPath)) return { ok: false, error: describeDocRefusal('not-surfaced'), conflict: false };
    return saveQueue.run(docPath, () => writeIfUnchanged(session, docPath, text, baseHash));
  }

  function snapshotMessage(): Record<string, unknown> {
    return { type: 'session-docs-snapshot', sessions: Object.fromEntries(docsBySessionId) };
  }

  return { surface, read, readImage, save, snapshotMessage };
}

export { createSessionDocsWiring, openVerifiedDoc, overwriteIfUnchanged };
export type { SessionDocsPort };
