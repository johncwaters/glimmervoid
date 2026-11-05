import path from 'node:path';

type ShownFileKind = 'image' | 'video' | 'page';

type ShownKindVerdict =
  | { ok: true; kind: ShownFileKind; mime: string; extension: string }
  | { ok: false; error: string };

interface ShownFormat {
  kind: ShownFileKind;
  mime: string;
  extension: string;
}

const SHOWN_SNIFF_BYTES = 64 * 1024;
const PAGE_TITLE_MAX_CHARS = 200;
const ACCEPTED_KINDS_TEXT = 'PNG, JPEG, WebP, GIF, SVG, MP4, WebM or HTML';

const PNG: ShownFormat = { kind: 'image', mime: 'image/png', extension: '.png' };
const JPEG: ShownFormat = { kind: 'image', mime: 'image/jpeg', extension: '.jpg' };
const GIF: ShownFormat = { kind: 'image', mime: 'image/gif', extension: '.gif' };
const WEBP: ShownFormat = { kind: 'image', mime: 'image/webp', extension: '.webp' };
const SVG: ShownFormat = { kind: 'image', mime: 'image/svg+xml', extension: '.svg' };
const MP4: ShownFormat = { kind: 'video', mime: 'video/mp4', extension: '.mp4' };
const WEBM: ShownFormat = { kind: 'video', mime: 'video/webm', extension: '.webm' };
const PAGE: ShownFormat = { kind: 'page', mime: 'text/html; charset=utf-8', extension: '.html' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const UTF8_BYTE_ORDER_MARK = '﻿';
const PAGE_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function startsWithBytes(chunk: Buffer, signature: Buffer, offset = 0): boolean {
  return chunk.length >= offset + signature.length && chunk.subarray(offset, offset + signature.length).equals(signature);
}

function asciiAt(chunk: Buffer, offset: number, length: number): string {
  return chunk.subarray(offset, offset + length).toString('latin1');
}

function sniffBinaryFormat(chunk: Buffer): ShownFormat | null {
  if (startsWithBytes(chunk, PNG_SIGNATURE)) return PNG;
  if (startsWithBytes(chunk, JPEG_SIGNATURE)) return JPEG;
  if (asciiAt(chunk, 0, 6) === 'GIF87a' || asciiAt(chunk, 0, 6) === 'GIF89a') return GIF;
  if (asciiAt(chunk, 0, 4) === 'RIFF' && asciiAt(chunk, 8, 4) === 'WEBP') return WEBP;
  if (asciiAt(chunk, 4, 4) === 'ftyp') return MP4;
  if (startsWithBytes(chunk, WEBM_SIGNATURE)) return WEBM;
  return null;
}

function leadingMarkup(chunk: Buffer): string {
  const text = chunk.toString('utf8');
  const withoutMark = text.startsWith(UTF8_BYTE_ORDER_MARK) ? text.slice(UTF8_BYTE_ORDER_MARK.length) : text;
  return withoutMark.trimStart().toLowerCase();
}

function sniffMarkupFormat(chunk: Buffer, declaredName: string): ShownFormat | null {
  const markup = leadingMarkup(chunk);
  if (!markup.startsWith('<')) return null;
  if (markup.startsWith('<svg')) return SVG;
  if (markup.startsWith('<!doctype html') || markup.startsWith('<html')) return PAGE;
  const declaredExtension = path.extname(declaredName).toLowerCase();
  if (declaredExtension === '.svg' && markup.includes('<svg')) return SVG;
  if (declaredExtension === '.html' || declaredExtension === '.htm') return PAGE;
  if (markup.startsWith('<?xml') && markup.includes('<svg')) return SVG;
  return null;
}

function decideShownKind(firstChunk: Buffer, declaredName: string): ShownKindVerdict {
  const format = sniffBinaryFormat(firstChunk) ?? sniffMarkupFormat(firstChunk, declaredName);
  if (!format) return { ok: false, error: `${declaredName} is not a file show takes; show takes ${ACCEPTED_KINDS_TEXT} files` };
  return { ok: true, kind: format.kind, mime: format.mime, extension: format.extension };
}

function readPageTitle(firstChunk: Buffer): string | null {
  const titleMatch = PAGE_TITLE_RE.exec(firstChunk.subarray(0, SHOWN_SNIFF_BYTES).toString('utf8'));
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return title ? title.slice(0, PAGE_TITLE_MAX_CHARS) : null;
}

export { decideShownKind, readPageTitle, SHOWN_SNIFF_BYTES };
