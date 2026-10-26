import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glimmervoidHomeDir } from './core/config-path-core.ts';

const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVER_LOG_KEPT_ROTATIONS = 4;

type LogChunk = string | Uint8Array;

function serverLogPath(): string {
  return path.join(glimmervoidHomeDir(os.homedir(), process.env), 'logs', 'server.log');
}

function existingByteCount(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

function createRotatingLogFile(logPath: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let byteCount = existingByteCount(logPath);
  let isBroken = false;
  let chunksQueuedDuringRotation: LogChunk[] | null = null;
  const chunksNotYetWritten = new Set<{ chunk: LogChunk }>();
  let stream = openStream();

  function openStream(): fs.WriteStream {
    const opened = fs.createWriteStream(logPath, { flags: 'a' });
    opened.on('error', () => { isBroken = true; });
    return opened;
  }

  async function shiftRotations(): Promise<void> {
    for (let generation = SERVER_LOG_KEPT_ROTATIONS; generation >= 1; generation -= 1) {
      const olderPath = generation === 1 ? logPath : `${logPath}.${generation - 1}`;
      await fs.promises.rename(olderPath, `${logPath}.${generation}`).catch(() => undefined);
    }
  }

  async function rotate(): Promise<void> {
    chunksQueuedDuringRotation = [];
    const closing = stream;
    await new Promise<void>((resolve) => { closing.end(resolve); });
    await shiftRotations();
    stream = openStream();
    byteCount = 0;
    const queuedChunks = chunksQueuedDuringRotation;
    chunksQueuedDuringRotation = null;
    for (const chunk of queuedChunks) write(chunk);
  }

  function write(chunk: LogChunk): void {
    if (isBroken) return;
    if (chunksQueuedDuringRotation) {
      chunksQueuedDuringRotation.push(chunk);
      return;
    }
    const pendingWrite = { chunk };
    chunksNotYetWritten.add(pendingWrite);
    stream.write(chunk, () => { chunksNotYetWritten.delete(pendingWrite); });
    byteCount += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (byteCount >= SERVER_LOG_MAX_BYTES) void rotate();
  }

  function flushBeforeExit(): void {
    if (isBroken) return;
    const unwrittenChunks = [...[...chunksNotYetWritten].map((pendingWrite) => pendingWrite.chunk), ...(chunksQueuedDuringRotation ?? [])];
    chunksNotYetWritten.clear();
    chunksQueuedDuringRotation = [];
    try {
      for (const chunk of unwrittenChunks) fs.appendFileSync(logPath, chunk);
    } catch {
      isBroken = true;
    }
  }

  return { write, flushBeforeExit };
}

function teeStream(target: NodeJS.WriteStream, logFile: ReturnType<typeof createRotatingLogFile>): void {
  const writeToTarget = target.write.bind(target);
  target.write = ((chunk: LogChunk, ...rest: never[]) => {
    logFile.write(chunk);
    return writeToTarget(chunk, ...rest);
  }) as typeof target.write;
}

function teeProcessOutputToServerLog(logPath = serverLogPath()): void {
  const logFile = createRotatingLogFile(logPath);
  teeStream(process.stdout, logFile);
  teeStream(process.stderr, logFile);
  process.on('uncaughtExceptionMonitor', (error) => {
    logFile.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
  process.on('exit', () => { logFile.flushBeforeExit(); });
}

export { teeProcessOutputToServerLog };
