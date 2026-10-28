export interface LinkProfile {
  name: string;
  bytesPerSecond: number;
  oneWayDelayMs: number;
  initialWindowBytes: number;
}

const SEGMENT_BYTES = 1460;

export const THREE_G_PROFILE: LinkProfile = {
  name: '3G: 400 kbps down and up, 400 ms RTT, initcwnd 10',
  bytesPerSecond: 400_000 / 8,
  oneWayDelayMs: 200,
  initialWindowBytes: 10 * SEGMENT_BYTES,
};

export const UNSHAPED_PROFILE: LinkProfile = {
  name: 'unshaped',
  bytesPerSecond: Number.POSITIVE_INFINITY,
  oneWayDelayMs: 0,
  initialWindowBytes: Number.POSITIVE_INFINITY,
};

export interface SharedLink {
  freeAtMs: number;
}

export interface CongestionWindow {
  windowBytes: number;
  roundStartMs: number;
  bytesInRound: number;
}

interface ScheduledPiece {
  byteCount: number;
  deliverAtMs: number;
}

export type Channel = 'http' | 'control' | 'data';

export const CHANNELS: readonly Channel[] = ['http', 'control', 'data'];

export function openCongestionWindow(profile: LinkProfile, establishedAtMs: number): CongestionWindow {
  return { windowBytes: profile.initialWindowBytes, roundStartMs: establishedAtMs, bytesInRound: 0 };
}

export function schedulePieces(byteCount: number, nowMs: number, link: SharedLink, window: CongestionWindow, profile: LinkProfile): ScheduledPiece[] {
  const roundTripMs = 2 * profile.oneWayDelayMs;
  const pieces: ScheduledPiece[] = [];
  let remainingBytes = byteCount;
  if (nowMs - window.roundStartMs >= roundTripMs) {
    window.roundStartMs = nowMs;
    window.bytesInRound = 0;
  }
  while (remainingBytes > 0) {
    if (window.bytesInRound >= window.windowBytes) {
      window.roundStartMs = Math.max(window.roundStartMs + roundTripMs, nowMs);
      window.windowBytes *= 2;
      window.bytesInRound = 0;
    }
    const takenBytes = Math.min(window.windowBytes - window.bytesInRound, remainingBytes);
    const sendStartMs = Math.max(window.roundStartMs, nowMs, link.freeAtMs);
    link.freeAtMs = sendStartMs + (takenBytes / profile.bytesPerSecond) * 1000;
    pieces.push({ byteCount: takenBytes, deliverAtMs: link.freeAtMs + profile.oneWayDelayMs });
    window.bytesInRound += takenBytes;
    remainingBytes -= takenBytes;
  }
  return pieces;
}

const REQUEST_LINE = /^[A-Z]+ (\S+) HTTP\/1\.[01]\r\n/;
const UPGRADE_HEADER = /\r\nupgrade:\s*websocket\r\n/i;

export function classifyChannel(firstRequestText: string): Channel {
  const requestLine = REQUEST_LINE.exec(firstRequestText);
  if (!requestLine || !UPGRADE_HEADER.test(firstRequestText)) return 'http';
  const requestPath = requestLine[1] ?? '';
  if (requestPath === '/control' || requestPath.startsWith('/control?')) return 'control';
  if (requestPath.startsWith('/terminals/')) return 'data';
  return 'http';
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function medianRunIndex(values: readonly number[]): number {
  const middleValue = median(values);
  let closestIndex = 0;
  values.forEach((value, index) => {
    if (Math.abs(value - middleValue) < Math.abs((values[closestIndex] ?? 0) - middleValue)) closestIndex = index;
  });
  return closestIndex;
}
