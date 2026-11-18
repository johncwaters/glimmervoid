import path from 'node:path';
import { UPLOAD_FILENAME_PATTERN } from '../../shared/contracts/session.ts';

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const UPLOAD_RETAIN_FILES = 20;

const CHAT_UPLOAD_MARKER = '-chat';

const CHAT_UPLOAD_NAME_RE = /-chat(\.[a-z0-9]{1,16})?$/;

const CHAT_UPLOAD_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

const UPLOAD_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const CLIENT_NAME_EXTENSION_RE = /\.([A-Za-z0-9]{1,16})$/;

type UploadTypeVerdict =
  | { ok: true; extension: string }
  | { ok: false; status: number; error: string };

function extensionForImageMime(contentTypeHeader: unknown): string | null {
  if (typeof contentTypeHeader !== 'string') return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return IMAGE_EXTENSION_BY_MIME[mime] || null;
}

function decodeUploadName(uploadNameHeader: unknown): string | null {
  if (typeof uploadNameHeader !== 'string' || uploadNameHeader.length === 0) return null;
  try {
    const decoded = decodeURIComponent(uploadNameHeader);
    if (decoded.length === 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

function extensionForUploadName(uploadNameHeader: unknown): string | null {
  const clientName = decodeUploadName(uploadNameHeader);
  if (clientName === null) return null;
  const trailingExtension = CLIENT_NAME_EXTENSION_RE.exec(clientName);
  if (!trailingExtension) return '';
  return `.${trailingExtension[1].toLowerCase()}`;
}

function decideUploadType(contentTypeHeader: unknown, uploadNameHeader?: unknown): UploadTypeVerdict {
  const imageExtension = extensionForImageMime(contentTypeHeader);
  if (imageExtension) return { ok: true, extension: imageExtension };
  const namedExtension = extensionForUploadName(uploadNameHeader);
  if (namedExtension === null) return { ok: false, status: 415, error: 'unsupported upload type' };
  return { ok: true, extension: namedExtension };
}

function exceedsUploadCap(bytesReceived: number, cap: number = MAX_UPLOAD_BYTES): boolean {
  return bytesReceived > cap;
}

function isSafePathSegment(segment: unknown): boolean {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (path.basename(segment) !== segment) return false;
  return SAFE_SEGMENT_RE.test(segment);
}

function buildUploadFilename({ now, randomSuffix, extension, isChatUpload }: { now: number; randomSuffix: string; extension: string; isChatUpload: boolean }): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const marker = isChatUpload ? CHAT_UPLOAD_MARKER : '';
  return `${stamp}-${randomSuffix}${marker}${extension}`;
}

function writtenAtMsOf(name: string): number | null {
  const stamp = UPLOAD_STAMP_RE.exec(name);
  if (stamp === null) return null;
  const [, day, hours, minutes, seconds, millis] = stamp;
  const writtenAtMs = Date.parse(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
  return Number.isFinite(writtenAtMs) ? writtenAtMs : null;
}

function chatUploadsPastRetention(uploads: readonly string[], nowMs: number): string[] {
  return uploads.filter((name) => {
    const writtenAtMs = writtenAtMsOf(name);
    return writtenAtMs !== null && nowMs - writtenAtMs > CHAT_UPLOAD_RETAIN_MS;
  });
}

function newestBeyondKeep(uploads: readonly string[], keep: number): string[] {
  return [...uploads].sort().reverse().slice(keep);
}

function planUploadRetention(
  filenames: unknown,
  { keep = UPLOAD_RETAIN_FILES, justWritten = null, heldNames = [], nowMs }: { keep?: number; justWritten?: string | null; heldNames?: readonly string[]; nowMs: number },
): string[] {
  if (!Array.isArray(filenames) || keep <= 0) return [];
  const uploads: string[] = filenames.filter((name): name is string => isUploadFilename(name));
  if (justWritten && !uploads.includes(justWritten)) uploads.push(justWritten);
  const chatUploads = uploads.filter((name) => CHAT_UPLOAD_NAME_RE.test(name));
  const terminalUploads = uploads.filter((name) => !CHAT_UPLOAD_NAME_RE.test(name));
  return [...chatUploadsPastRetention(chatUploads, nowMs), ...newestBeyondKeep(terminalUploads, keep)].filter((name) => name !== justWritten && !heldNames.includes(name));
}

function isUploadFilename(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return UPLOAD_FILENAME_PATTERN.test(name);
}

function imageMimeForUploadFilename(name: string): string | null {
  if (!isUploadFilename(name)) return null;
  const extension = path.extname(name).toLowerCase();
  const imageEntry = Object.entries(IMAGE_EXTENSION_BY_MIME).find(([, imageExtension]) => imageExtension === extension);
  return imageEntry ? imageEntry[0] : null;
}

export { MAX_UPLOAD_BYTES, buildUploadFilename, decideUploadType, exceedsUploadCap, imageMimeForUploadFilename, isSafePathSegment, planUploadRetention };
