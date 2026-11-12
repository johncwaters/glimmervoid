const NEWLINE_BYTE = 0x0a;
const ESCAPE_BYTE = 0x1b;

type LineStamper = (chunk: string | Uint8Array) => Buffer;

function isBareTerminalControl(bytes: Buffer): boolean {
  return bytes[0] === ESCAPE_BYTE && !bytes.includes(NEWLINE_BYTE);
}

function createLineStamper(nowIso: () => string): LineStamper {
  let isAtLineStart = true;
  return (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (isAtLineStart && isBareTerminalControl(bytes)) return bytes;
    const pieces: Buffer[] = [];
    let lineStart = 0;
    while (lineStart < bytes.byteLength) {
      if (isAtLineStart) pieces.push(Buffer.from(`${nowIso()} `));
      const newlineAt = bytes.indexOf(NEWLINE_BYTE, lineStart);
      const lineEnd = newlineAt === -1 ? bytes.byteLength : newlineAt + 1;
      pieces.push(bytes.subarray(lineStart, lineEnd));
      isAtLineStart = newlineAt !== -1;
      lineStart = lineEnd;
    }
    return Buffer.concat(pieces);
  };
}

export { createLineStamper };
