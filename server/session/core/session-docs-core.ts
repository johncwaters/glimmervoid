import crypto from 'node:crypto';

import { SESSION_DOC_BODY_CAP_BYTES } from '../../../shared/contracts/session.ts';
import type { SessionDoc } from '../../../shared/contracts/session.ts';
import type { ContainmentRefusal } from '../../core/trace-tail-core.ts';

type DocRefusal = ContainmentRefusal | 'too-large' | 'binary' | 'not-surfaced' | 'changed-on-disk' | 'hard-linked';

type DecodedDoc =
  | { ok: true; text: string; usesCrlf: boolean }
  | { ok: false; reason: DocRefusal };

type EncodedDoc =
  | { ok: true; content: string }
  | { ok: false; reason: DocRefusal };

const NUL_CHARACTER = String.fromCharCode(0);

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

export { decodeDocBytes, describeDocRefusal, encodeDocText, hashDocBytes, withSurfacedDoc };
export type { DocRefusal };
