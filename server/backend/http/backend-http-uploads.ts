import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { Session } from '../../../session/sessions.ts';
import { MAX_UPLOAD_BYTES, exceedsUploadCap, framePathPaste, planUploadRetention } from '../../core/upload-core.ts';

async function sweepSessionUploads(dir: string, justWritten: string): Promise<void> {
  let entries: string[] | null = null;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of planUploadRetention(entries, { justWritten })) {
    try {
      await fsp.unlink(path.join(dir, name));
    } catch {}
  }
}

type StreamToFileOutcome =
  | { ok: true; sizeBytes: number }
  | { ok: false; reason: 'over-cap' | 'write-failed' | 'aborted'; bytesReceived: number };

function streamRequestToFile({ req, savedPath, capBytes }: {
  req: Request;
  savedPath: string;
  capBytes: number;
}): Promise<StreamToFileOutcome> {
  return new Promise((resolve) => {
    const writeStream = fs.createWriteStream(savedPath, { mode: 0o600 });
    const writeStreamClosed = new Promise((resolveClosed) => writeStream.once('close', resolveClosed));
    let bytesReceived = 0;
    let settled = false;
    const fail = (reason: 'over-cap' | 'write-failed' | 'aborted') => {
      if (settled) return;
      settled = true;
      const outcome: StreamToFileOutcome = { ok: false, reason, bytesReceived };
      void writeStreamClosed
        .then(() => fsp.unlink(savedPath).catch(() => {}))
        .then(() => resolve(outcome));
    };
    const stopWritingAndDrain = () => {
      req.unpipe(writeStream);
      writeStream.destroy();
      req.resume();
    };
    writeStream.on('error', () => {
      stopWritingAndDrain();
      fail('write-failed');
    });
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, sizeBytes: bytesReceived });
    });
    req.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (settled || !exceedsUploadCap(bytesReceived, capBytes)) return;
      stopWritingAndDrain();
      fail('over-cap');
    });
    req.on('error', () => {
      writeStream.destroy();
      fail('aborted');
    });
    req.on('close', () => {
      if (req.complete) return;
      writeStream.destroy();
      fail('aborted');
    });
    req.pipe(writeStream);
  });
}

const UPLOAD_OVER_CAP_ERROR = `file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)}mb`;

const UPLOAD_FAILURE_REPLIES = {
  'over-cap': { status: 413, error: UPLOAD_OVER_CAP_ERROR },
  'write-failed': { status: 500, error: 'could not store the upload' },
  aborted: { status: 400, error: 'upload failed' },
} as const;

function receiveUpload({ req, res, sess, dir, filename, savedPath, logger }: {
  req: Request;
  res: Response;
  sess: Session;
  dir: string;
  filename: string;
  savedPath: string;
  logger: Pick<Console, 'warn'>;
}): void {
  const answer = (status: number, body: Record<string, unknown>) => {
    if (!res.headersSent) res.status(status).json(body);
  };
  void streamRequestToFile({ req, savedPath, capBytes: MAX_UPLOAD_BYTES }).then((outcome) => {
    if (!outcome.ok) {
      logger.warn(`[upload] session ${sess.id} refused: ${outcome.reason} after ${outcome.bytesReceived} bytes`);
      const failure = UPLOAD_FAILURE_REPLIES[outcome.reason];
      answer(failure.status, { error: failure.error });
      return;
    }
    if (!sess.hasLivePty) {
      logger.warn(`[upload] session ${sess.id} refused: session has no live terminal, after ${outcome.sizeBytes} bytes`);
      answer(409, { error: 'session has no live terminal' });
      fsp.unlink(savedPath).catch(() => {});
      return;
    }
    sess.write(framePathPaste(savedPath));
    sess.noteOperatorDraft();
    answer(200, { ok: true, path: savedPath });
    void sweepSessionUploads(dir, filename);
  });
}

export { UPLOAD_FAILURE_REPLIES, UPLOAD_OVER_CAP_ERROR, receiveUpload, streamRequestToFile };
