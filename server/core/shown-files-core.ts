import path from 'node:path';

import { SHOWN_FILE_CAP_BYTES } from '../../shared/contracts/session.ts';
import type { ShownFile, ShownFileKind } from '../../shared/contracts/session.ts';

type ThumbnailRecipe = 'image' | 'video-poster' | 'none';

type ShownKindVerdict =
  | { ok: true; kind: ShownFileKind; mime: string; extension: string }
  | { ok: false; error: string };

interface ShownFormat {
  kind: ShownFileKind;
  mime: string;
  extension: string;
}

const SHOWN_SNIFF_BYTES = 64 * 1024;
const SHOWN_THUMBNAIL_MAX_EDGE_PX = 320;
const THUMBNAIL_SUFFIX = '.thumb.webp';
const PAGE_TITLE_MAX_CHARS = 200;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const ACCEPTED_KINDS_TEXT = 'PNG, JPEG, WebP, GIF, SVG, MP4, WebM or HTML';

const PNG: ShownFormat = { kind: 'image', mime: 'image/png', extension: '.png' };
const JPEG: ShownFormat = { kind: 'image', mime: 'image/jpeg', extension: '.jpg' };
const GIF: ShownFormat = { kind: 'image', mime: 'image/gif', extension: '.gif' };
const WEBP: ShownFormat = { kind: 'image', mime: 'image/webp', extension: '.webp' };
const SVG: ShownFormat = { kind: 'image', mime: 'image/svg+xml', extension: '.svg' };
const MP4: ShownFormat = { kind: 'video', mime: 'video/mp4', extension: '.mp4' };
const WEBM: ShownFormat = { kind: 'video', mime: 'video/webm', extension: '.webm' };
const PAGE: ShownFormat = { kind: 'page', mime: 'text/html; charset=utf-8', extension: '.html' };

const SHOWN_FORMATS: readonly ShownFormat[] = [PNG, JPEG, GIF, WEBP, SVG, MP4, WEBM, PAGE];

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

function shownMimeForFilename(filename: string): string | null {
  const extension = path.extname(filename).toLowerCase();
  return SHOWN_FORMATS.find((format) => format.extension === extension)?.mime ?? null;
}

function megabytesOf(sizeBytes: number): number {
  return Math.ceil(sizeBytes / BYTES_PER_MEGABYTE);
}

function describeOverCap(name: string, sizeBytes: number | null): string {
  const limit = `show takes files up to ${megabytesOf(SHOWN_FILE_CAP_BYTES)} MB`;
  if (sizeBytes === null) return `${name} is too large; ${limit}`;
  return `${name} is ${megabytesOf(sizeBytes)} MB; ${limit}`;
}

function readPageTitle(firstChunk: Buffer): string | null {
  const titleMatch = PAGE_TITLE_RE.exec(firstChunk.subarray(0, SHOWN_SNIFF_BYTES).toString('utf8'));
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return title ? title.slice(0, PAGE_TITLE_MAX_CHARS) : null;
}

function filesAfterRetention(files: readonly ShownFile[], droppedIds: readonly string[]): ShownFile[] {
  const dropped = new Set(droppedIds);
  return files.filter((file) => !dropped.has(file.id));
}

const THUMBNAIL_RECIPE_BY_KIND: Record<ShownFileKind, ThumbnailRecipe> = { image: 'image', video: 'video-poster', page: 'none' };

function thumbnailRecipeFor(kind: ShownFileKind): ThumbnailRecipe {
  return THUMBNAIL_RECIPE_BY_KIND[kind];
}

function thumbnailFilenameOf(fileId: string): string {
  return `${fileId}${THUMBNAIL_SUFFIX}`;
}

function thumbnailOwnerIdOf(filename: string): string | null {
  return filename.endsWith(THUMBNAIL_SUFFIX) ? filename.slice(0, -THUMBNAIL_SUFFIX.length) : null;
}

export { decideShownKind, describeOverCap, filesAfterRetention, readPageTitle, shownMimeForFilename, thumbnailFilenameOf, thumbnailOwnerIdOf, thumbnailRecipeFor, SHOWN_SNIFF_BYTES, SHOWN_THUMBNAIL_MAX_EDGE_PX };
export type { ThumbnailRecipe };
