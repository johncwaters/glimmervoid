import crypto from 'node:crypto';
import { FRAME_ROUTE } from '../../shared/contracts/whiteboard.ts';

const FRAME_SCOPE_SEGMENTS = 3;
const FRAME_KEY_PATTERN = /^[0-9a-f]{64}$/;

type FrameRequest = { scope: readonly string[]; restPath: string };

function frameSegmentsOf(innerPath: string): string[] | null {
  const segments = innerPath.split('/');
  if (segments.length <= FRAME_SCOPE_SEGMENTS) return null;
  const isEverySegmentPlain = segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return isEverySegmentPlain ? segments : null;
}

function frameKeyOf(secret: Buffer, scope: readonly string[]): string {
  return crypto.createHmac('sha256', secret).update(scope.join('\0')).digest('hex');
}

function encodedPathOf(segments: readonly string[]): string {
  return segments.map(encodeURIComponent).join('/');
}

function keyedFramePath(secret: Buffer, innerPath: string): string | null {
  const segments = frameSegmentsOf(innerPath);
  if (segments === null) return null;
  return `${FRAME_ROUTE}/${frameKeyOf(secret, segments.slice(0, FRAME_SCOPE_SEGMENTS))}/${encodedPathOf(segments)}`;
}

function verifiedFrameRequest(secret: Buffer, offeredKey: string, innerPath: string): FrameRequest | null {
  const segments = frameSegmentsOf(innerPath);
  if (segments === null || !FRAME_KEY_PATTERN.test(offeredKey)) return null;
  const scope = segments.slice(0, FRAME_SCOPE_SEGMENTS);
  const isKeyRight = crypto.timingSafeEqual(Buffer.from(frameKeyOf(secret, scope)), Buffer.from(offeredKey));
  return isKeyRight ? { scope, restPath: segments.slice(FRAME_SCOPE_SEGMENTS).join('/') } : null;
}

export { keyedFramePath, verifiedFrameRequest };
export type { FrameRequest };
