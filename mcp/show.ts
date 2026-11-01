import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import { describeOverCap } from '../server/core/shown-files-core.ts';
import type { ShownFilesPort } from '../server/session/shown-files-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { SHOWN_CAPTION_MAX_CHARS, SHOWN_FILE_CAP_BYTES } from '../shared/contracts/session.ts';

interface ShowByPathRequest {
  requestedPath: string;
  caption: string | null;
}

type ShowReply = { status: number; body: Record<string, unknown> };

const OPEN_WITHOUT_BLOCKING_ON_A_PIPE = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

function refusal(status: number, error: string): ShowReply {
  return { status, body: { ok: false, error } };
}

function remoteRefusal(workspace: string): ShowReply {
  return refusal(409, `show reads files on the Glimmervoid machine, and this session runs in the Coder workspace ${workspace}, so its files are not there`);
}

async function copyCapped(handle: fsp.FileHandle, incomingPath: string): Promise<number | null> {
  let copiedBytes = 0;
  const source = handle.createReadStream({ start: 0, end: SHOWN_FILE_CAP_BYTES, autoClose: false });
  source.on('data', (chunk) => { copiedBytes += chunk.length; });
  await pipeline(source, fs.createWriteStream(incomingPath, { mode: 0o600 }));
  return copiedBytes > SHOWN_FILE_CAP_BYTES ? null : copiedBytes;
}

async function openRegularFile(absolutePath: string): Promise<fsp.FileHandle | null> {
  const pathStats = await fsp.stat(absolutePath).catch(() => null);
  if (!pathStats?.isFile()) return null;
  const handle = await fsp.open(absolutePath, OPEN_WITHOUT_BLOCKING_ON_A_PIPE).catch(() => null);
  if (!handle) return null;
  const handleStats = await handle.stat().catch(() => null);
  if (handleStats?.isFile()) return handle;
  await handle.close();
  return null;
}

async function storeAndAdmit(session: Session, shownFiles: ShownFilesPort, handle: fsp.FileHandle, name: string, caption: string | null): Promise<ShowReply> {
  const incomingPath = await shownFiles.reserveIncomingPath(session.id);
  const copiedBytes = await copyCapped(handle, incomingPath).catch(() => undefined);
  if (copiedBytes === undefined || copiedBytes === null) {
    await fsp.unlink(incomingPath).catch(() => {});
    if (copiedBytes === null) return refusal(413, describeOverCap(name, null));
    return refusal(500, `could not read ${name}`);
  }
  const admitted = await shownFiles.admit(session, { incomingPath, name, caption, sizeBytes: copiedBytes });
  if (!admitted.ok) return refusal(admitted.status, admitted.error);
  return { status: 200, body: { ok: true, shown: { name: admitted.file.name, kind: admitted.file.kind } } };
}

async function showByPath(session: Session, agentApi: AgentApiPort, shownFiles: ShownFilesPort | null, request: ShowByPathRequest): Promise<ShowReply> {
  const roleRefusal = agentApi.refuseRole(session, 'show');
  if (roleRefusal) return roleRefusal;
  if (session.remoteWorkspace !== null) return remoteRefusal(session.remoteWorkspace);
  if (!shownFiles) return refusal(503, 'show is not available right now');
  const absolutePath = path.resolve(session.effectiveCwd(), request.requestedPath);
  const name = path.basename(absolutePath);
  const handle = await openRegularFile(absolutePath);
  if (!handle) return refusal(404, `${request.requestedPath} is not a file this session can read`);
  try {
    const { size } = await handle.stat();
    if (size > SHOWN_FILE_CAP_BYTES) return refusal(413, describeOverCap(request.requestedPath, size));
    session.noteCommandRan('show');
    const caption = request.caption?.trim().slice(0, SHOWN_CAPTION_MAX_CHARS) || null;
    return await storeAndAdmit(session, shownFiles, handle, name, caption);
  } finally {
    await handle.close();
  }
}

export { showByPath };
export type { ShowByPathRequest, ShowReply };
