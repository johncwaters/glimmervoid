import { Buffer } from "node:buffer";

type InputReadyCondition = "startup-hook" | "cursor-shown" | "full-frame";

interface InputReadyScan {
  pending: string;
  openFrameBytes: number | null;
}

interface InputReadyScanResult {
  isReady: boolean;
  scan: InputReadyScan;
}

const FULL_FRAME_MIN_BYTES = 1000;
const CURSOR_SHOW = "\x1b[?25h";
const FRAME_START = "\x1b[?2026h";
const FRAME_MARKER = /\x1b\[\?2026([hl])/g;
const NO_INPUT_READY_SCAN: InputReadyScan = Object.freeze({ pending: "", openFrameBytes: null });

function carriedTail(buffer: string, markerLength: number): string {
  return buffer.slice(-(markerLength - 1));
}

function scanCursorShown(scan: InputReadyScan, chunk: string): InputReadyScanResult {
  const buffer = scan.pending + chunk;
  if (buffer.includes(CURSOR_SHOW)) return { isReady: true, scan: NO_INPUT_READY_SCAN };
  return { isReady: false, scan: { pending: carriedTail(buffer, CURSOR_SHOW.length), openFrameBytes: null } };
}

function scanFullFrame(scan: InputReadyScan, chunk: string): InputReadyScanResult {
  const buffer = scan.pending + chunk;
  const chunkStart = scan.pending.length;
  let openFrameBytes = scan.openFrameBytes;
  let countedUpTo = chunkStart;
  for (const marker of buffer.matchAll(FRAME_MARKER)) {
    const markerEnd = marker.index + marker[0].length;
    if (markerEnd <= chunkStart) continue;
    if (marker[1] === "h") {
      openFrameBytes = 0;
      countedUpTo = marker.index;
      continue;
    }
    if (openFrameBytes === null) continue;
    const frameBytes = openFrameBytes + Buffer.byteLength(buffer.slice(countedUpTo, markerEnd));
    if (frameBytes >= FULL_FRAME_MIN_BYTES) return { isReady: true, scan: NO_INPUT_READY_SCAN };
    openFrameBytes = null;
  }
  const bytesStillOpen = openFrameBytes === null ? null : openFrameBytes + Buffer.byteLength(buffer.slice(countedUpTo));
  return { isReady: false, scan: { pending: carriedTail(buffer, FRAME_START.length), openFrameBytes: bytesStillOpen } };
}

function scanInputReady(condition: InputReadyCondition | undefined, scan: InputReadyScan, chunk: string): InputReadyScanResult {
  if (condition === undefined) return { isReady: true, scan: NO_INPUT_READY_SCAN };
  if (condition === "startup-hook") return { isReady: false, scan: NO_INPUT_READY_SCAN };
  if (condition === "cursor-shown") return scanCursorShown(scan, chunk);
  return scanFullFrame(scan, chunk);
}

export { NO_INPUT_READY_SCAN, scanInputReady };
export type { InputReadyCondition };
