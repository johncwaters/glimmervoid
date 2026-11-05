import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream';
import type { Request, Response } from 'express';
import { decideByteRange } from '../../core/custom-sounds-core.ts';
import { isShownPageMime, leavesVisibleRawTextOpen, SHOWN_PAGE_ZOOM_BRIDGE, SHOWN_SNIFF_BYTES } from '../../core/shown-files-core.ts';
import type { ServableShownFile, ShownFilesPort } from '../../session/shown-files-wiring.ts';

const SHOWN_FILE_SANDBOX_POLICY = 'sandbox allow-scripts allow-popups allow-modals allow-forms';

async function* withZoomBridgeAppended(pageChunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  yield* pageChunks;
  yield SHOWN_PAGE_ZOOM_BRIDGE;
}

async function readPageTail(servable: ServableShownFile): Promise<string> {
  const handle = await fsp.open(servable.path, 'r');
  try {
    const tailStart = Math.max(0, servable.sizeBytes - SHOWN_SNIFF_BYTES);
    const tailBuffer = Buffer.alloc(servable.sizeBytes - tailStart);
    const { bytesRead } = await handle.read(tailBuffer, 0, tailBuffer.byteLength, tailStart);
    return tailBuffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

function streamPage(res: Response, servable: ServableShownFile, pageTail: string): void {
  res.setHeader('Content-Type', servable.mime);
  if (leavesVisibleRawTextOpen(pageTail)) {
    res.setHeader('Content-Length', String(servable.sizeBytes));
    pipeline(fs.createReadStream(servable.path), res, () => {});
    return;
  }
  res.setHeader('Content-Length', String(servable.sizeBytes + SHOWN_PAGE_ZOOM_BRIDGE.byteLength));
  pipeline(fs.createReadStream(servable.path), withZoomBridgeAppended, res, () => {});
}

function servePageWithZoomBridge(res: Response, servable: ServableShownFile): void {
  readPageTail(servable)
    .then((pageTail) => streamPage(res, servable, pageTail))
    .catch(() => {
      if (!res.headersSent) res.status(404).end();
    });
}

function serveShownFile(req: Request, res: Response, shownFiles: ShownFilesPort | null): void {
  const servable = shownFiles?.findServable(req.params.sessionId, req.params.filename) ?? null;
  if (!servable) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Security-Policy', SHOWN_FILE_SANDBOX_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  if (isShownPageMime(servable.mime)) {
    servePageWithZoomBridge(res, servable);
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  const byteRange = decideByteRange(req.headers.range, servable.sizeBytes);
  if (byteRange.kind === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${servable.sizeBytes}`);
    res.end();
    return;
  }
  res.setHeader('Content-Type', servable.mime);
  if (byteRange.kind === 'partial') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${byteRange.start}-${byteRange.end}/${servable.sizeBytes}`);
    res.setHeader('Content-Length', String(byteRange.end - byteRange.start + 1));
    pipeline(fs.createReadStream(servable.path, { start: byteRange.start, end: byteRange.end }), res, () => {});
    return;
  }
  res.setHeader('Content-Length', String(servable.sizeBytes));
  pipeline(fs.createReadStream(servable.path), res, () => {});
}

export { serveShownFile };
