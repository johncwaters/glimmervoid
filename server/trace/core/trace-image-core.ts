import { createHash } from 'node:crypto';

import { CHAT_SEND_MAX_ATTACHMENTS } from '../../../shared/contracts/session.ts';
import { MAX_RECORD_IMAGES } from '../../../shared/contracts/trace.ts';
import type { TraceImage, TraceRecord } from '../../../shared/contracts/trace.ts';
import { buildUploadFilename } from '../../core/upload-core.ts';

interface ImageBlob {
  mimeType: TraceImage['mimeType'];
  base64: string;
}

const EXTENSION_BY_IMAGE_MIME: Readonly<Record<TraceImage['mimeType'], string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const MIME_FIELD_NAMES = ['media_type', 'mediaType', 'mimeType', 'mime_type', 'mime'] as const;
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/;
const MAX_WALK_DEPTH = 8;
const HASH_SUFFIX_LENGTH = 8;

function isImageMime(value: unknown): value is TraceImage['mimeType'] {
  return typeof value === 'string' && Object.hasOwn(EXTENSION_BY_IMAGE_MIME, value);
}

function blobOfDataUrl(value: string): ImageBlob | null {
  const match = DATA_URL.exec(value);
  if (match === null || !isImageMime(match[1])) return null;
  return { mimeType: match[1], base64: match[2] ?? '' };
}

function blobOfRecord(record: Record<string, unknown>): ImageBlob | null {
  const encodedImage = record.data;
  const mimeType = MIME_FIELD_NAMES.map((fieldName) => record[fieldName]).find((value) => typeof value === 'string');
  if (typeof encodedImage !== 'string' || !isImageMime(mimeType)) return null;
  if (encodedImage.startsWith('data:')) return blobOfDataUrl(encodedImage);
  if (!BASE64_TEXT.test(encodedImage)) return null;
  return { mimeType, base64: encodedImage };
}

function collectBlobs(value: unknown, depth: number, blobs: ImageBlob[]): void {
  if (blobs.length >= MAX_RECORD_IMAGES || depth > MAX_WALK_DEPTH) return;
  if (typeof value === 'string') {
    const blob = value.startsWith('data:image/') ? blobOfDataUrl(value) : null;
    if (blob !== null) blobs.push(blob);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBlobs(item, depth + 1, blobs);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const blob = blobOfRecord(record);
  if (blob !== null) {
    blobs.push(blob);
    return;
  }
  for (const nested of Object.values(record)) collectBlobs(nested, depth + 1, blobs);
}

function imageBlobsIn(value: unknown): ImageBlob[] {
  const blobs: ImageBlob[] = [];
  collectBlobs(value, 0, blobs);
  return blobs;
}

function decodedByteSize(base64: string): number {
  const compact = base64.replace(/\s/g, '');
  const paddingLength = compact.length - compact.replace(/=+$/, '').length;
  return Math.max(1, Math.floor((compact.length * 3) / 4) - paddingLength);
}

function hashSuffixOf(base64: string): string {
  return createHash('sha256').update(base64.replace(/\s/g, '')).digest('hex').slice(0, HASH_SUFFIX_LENGTH);
}

function imageFileNameOf(blob: ImageBlob, writtenAtMs: number): string {
  return buildUploadFilename({ now: writtenAtMs, randomSuffix: hashSuffixOf(blob.base64), extension: EXTENSION_BY_IMAGE_MIME[blob.mimeType], isChatUpload: true });
}

function traceImagesIn(value: unknown, writtenAtMs: number): TraceImage[] {
  return imageBlobsIn(value).map((blob) => ({
    fileName: imageFileNameOf(blob, writtenAtMs),
    mimeType: blob.mimeType,
    byteSize: decodedByteSize(blob.base64),
  }));
}

function isImageBlock(value: unknown): boolean {
  return imageBlobsIn([value]).length > 0;
}

function withoutImageBlocks(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((item) => !isImageBlock(item)) : value;
}

function traceImagesField(value: unknown, writtenAtMs: number): { images?: TraceImage[] } {
  const images = traceImagesIn(value, writtenAtMs);
  return images.length === 0 ? {} : { images };
}

type RecordBaseFields = Pick<TraceRecord, 'ts' | 'uuid' | 'parentUuid' | 'vendorSessionId' | 'agentId' | 'agentType'>;

function pastedImagesRecordOf(base: RecordBaseFields, images: readonly TraceImage[]): TraceRecord {
  return { ...base, kind: 'attachments', files: images.slice(0, CHAT_SEND_MAX_ATTACHMENTS).map((image) => image.fileName), pastedPrefix: '', fromTranscript: true };
}

export { imageBlobsIn, imageFileNameOf, isImageBlock, pastedImagesRecordOf, traceImagesField, traceImagesIn, withoutImageBlocks };
