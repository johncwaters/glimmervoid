import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { SESSION_DOC_BODY_CAP_BYTES, SESSION_DOCS_MAX } from '../../shared/contracts/session.ts';
import type { AgentEditRequest, SessionDoc } from '../../shared/contracts/session.ts';
import { isPathInside } from '../../shared/paths.ts';
import { openContainedFile } from '../contained-file.ts';
import type { OpenedFile } from '../contained-file.ts';
import { decodeDocBytes, describeDocRefusal, encodeDocText, hashDocBytes, withSurfacedDoc } from './core/session-docs-core.ts';
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
  save(session: DocSession, docPath: string, text: string, baseHash: string): Promise<SaveReply>;
  snapshotMessage(): Record<string, unknown>;
}

async function readAtMostCapPlusOneByte(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(SESSION_DOC_BODY_CAP_BYTES + 1);
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
    return { ok: true, loaded: { file, bytes: await readAtMostCapPlusOneByte(file.handle) } };
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
  const saveQueue = createKeyedSerialQueue();

  function broadcastDocs(sessionId: string): void {
    broadcastControl({ type: 'session-docs-changed', id: sessionId, docs: docsBySessionId.get(sessionId) ?? [] });
  }

  function forgetSession(sessionId: string): void {
    if (!docsBySessionId.delete(sessionId)) return;
    broadcastDocs(sessionId);
  }

  function isSurfaced(session: DocSession, docPath: string): boolean {
    return (docsBySessionId.get(session.id) ?? []).some((doc) => doc.path === docPath);
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
    docsBySessionId.set(session.id, withSurfacedDoc(docsBySessionId.get(session.id) ?? [], doc, SESSION_DOCS_MAX));
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

  return { surface, read, save, snapshotMessage };
}

export { createSessionDocsWiring };
export type { SessionDocsPort };
