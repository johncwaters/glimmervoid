import crypto from 'node:crypto';
import path from 'node:path';

import { SESSION_DOC_BODY_CAP_BYTES } from '../../../shared/contracts/session.ts';
import type { SessionDoc } from '../../../shared/contracts/session.ts';
import type { ContainmentRefusal } from '../../core/trace-tail-core.ts';

type DocRefusal = ContainmentRefusal | 'too-large' | 'binary' | 'not-surfaced' | 'changed-on-disk' | 'hard-linked' | 'image-not-referenced' | 'not-an-image' | 'image-too-large';

type DecodedDoc =
  | { ok: true; text: string; usesCrlf: boolean }
  | { ok: false; reason: DocRefusal };

type EncodedDoc =
  | { ok: true; content: string }
  | { ok: false; reason: DocRefusal };

const NUL_CHARACTER = String.fromCharCode(0);
const DOC_IMAGE_CAP_BYTES = 2 * 1024 * 1024;
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]*\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
});

const DOC_REFUSAL_COPY: Readonly<Record<DocRefusal, string>> = Object.freeze({
  missing: 'no file exists at that path, so write it first and surface it again',
  unreadable: 'the file cannot be read',
  'outside-root': "the path is outside this session's checkout",
  'not-a-regular-file': 'the path is not a regular file',
  'root-unresolvable': "this session's checkout cannot be resolved",
  'too-large': `the file is over ${SESSION_DOC_BODY_CAP_BYTES / 1024} KiB`,
  binary: 'the file is not UTF-8 text',
  'not-surfaced': 'that file was not surfaced by this session',
  'changed-on-disk': 'the file changed on disk since it was opened, so reload it before saving',
  'hard-linked': "the file has other hard links, so it may live outside this session's checkout",
  'image-not-referenced': 'the doc does not show that image',
  'not-an-image': 'that file is not a PNG, JPEG, GIF, WebP, SVG or AVIF image',
  'image-too-large': `the image is over ${DOC_IMAGE_CAP_BYTES / 1024 / 1024} MiB`,
});

function describeDocRefusal(reason: DocRefusal): string {
  return DOC_REFUSAL_COPY[reason];
}

function hashDocBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function decodeDocBytes(bytes: Uint8Array): DecodedDoc {
  if (bytes.byteLength > SESSION_DOC_BODY_CAP_BYTES) return { ok: false, reason: 'too-large' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'binary' };
  }
  if (text.includes(NUL_CHARACTER)) return { ok: false, reason: 'binary' };
  const crlfCount = countOccurrences(text, '\r\n');
  const usesCrlf = crlfCount > 0 && crlfCount === countOccurrences(text, '\n');
  if (!usesCrlf) return { ok: true, text, usesCrlf };
  return { ok: true, text: text.replaceAll('\r\n', '\n'), usesCrlf };
}

function encodeDocText(text: string, usesCrlf: boolean): EncodedDoc {
  if (text.includes(NUL_CHARACTER)) return { ok: false, reason: 'binary' };
  const lineFeedText = text.replaceAll('\r\n', '\n');
  const content = usesCrlf ? lineFeedText.replaceAll('\n', '\r\n') : lineFeedText;
  if (Buffer.byteLength(content, 'utf8') > SESSION_DOC_BODY_CAP_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, content };
}

function withSurfacedDoc(docs: readonly SessionDoc[], surfaced: SessionDoc, maxDocs: number): SessionDoc[] {
  return [surfaced, ...docs.filter((doc) => doc.path !== surfaced.path)].slice(0, maxDocs);
}

function imageReferencesOf(docText: string): Set<string> {
  const imageSources = new Set<string>();
  let openFence: string | null = null;
  for (const line of docText.split('\n')) {
    const fence = FENCE_OPENER.exec(line)?.[1] ?? null;
    if (fence !== null && (openFence === null || fence.startsWith(openFence))) {
      openFence = openFence === null ? fence : null;
      continue;
    }
    if (openFence !== null) continue;
    for (const match of line.matchAll(MARKDOWN_IMAGE_PATTERN)) imageSources.add(match[1] ?? '');
  }
  imageSources.delete('');
  return imageSources;
}

function imageMimeOf(imageSource: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[path.extname(imageSource).toLowerCase()] ?? null;
}

export { DOC_IMAGE_CAP_BYTES, imageMimeOf, imageReferencesOf, decodeDocBytes, describeDocRefusal, encodeDocText, hashDocBytes, withSurfacedDoc };
export type { DocRefusal };
