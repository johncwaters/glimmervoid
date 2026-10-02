import { open } from 'node:fs/promises';
import { extractAiTitle } from './core/task-title-core.ts';

export async function readTranscriptTaskTitle(transcriptPath: string): Promise<string | null> {
  try {
    const transcript = await open(transcriptPath, 'r');
    try {
      const { size } = await transcript.stat();
      const offset = Math.max(0, size - 64 * 1024);
      const readOffset = Math.max(0, offset - 1);
      const buffer = Buffer.alloc(size - readOffset);
      let totalBytesRead = 0;
      while (totalBytesRead < buffer.length) {
        const { bytesRead } = await transcript.read(buffer, totalBytesRead, buffer.length - totalBytesRead, readOffset + totalBytesRead);
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      const tail = buffer.subarray(offset - readOffset, totalBytesRead).toString('utf8');
      return extractAiTitle(tail, offset > 0 && buffer[0] !== 10);
    } finally {
      await transcript.close();
    }
  } catch {
    return null;
  }
}
