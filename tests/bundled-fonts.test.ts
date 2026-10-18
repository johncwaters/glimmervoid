import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { STATE_GLYPHS } from '../shared/states.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const FONTS_DIRECTORY = path.join(REPO_ROOT, 'assets', 'fonts');
const dashboardStylesheet = fs.readFileSync(path.join(REPO_ROOT, 'public', 'style.css'), 'utf8');

test('every bundled font ships with the SIL OFL licence beside it', () => {
  const fontFiles = fs.readdirSync(FONTS_DIRECTORY).filter((name) => name.endsWith('.woff2'));
  assert.ok(fontFiles.length > 0);
  const licence = fs.readFileSync(path.join(FONTS_DIRECTORY, 'CommitMono-OFL.txt'), 'utf8');
  assert.match(licence, /Copyright \(c\) 2023 Eigil Nikolajsen/);
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('every font-face source in the dashboard stylesheet points at a bundled file', () => {
  const sources = [...dashboardStylesheet.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((match) => match[1]);
  assert.equal(sources.length, 4);
  const missingSources = sources.filter((source) => !fs.existsSync(path.join(FONTS_DIRECTORY, source)));
  assert.deepEqual(missingSources, []);
});

const WOFF2_KNOWN_TABLE_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca'];

function readUIntBase128(bytes: Buffer, start: number) {
  let value = 0;
  let offset = start;
  for (;;) {
    const byte = bytes[offset++];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset };
  }
}

function readWoff2CmapTable(fontPath: string) {
  const fontBytes = fs.readFileSync(fontPath);
  const tableCount = fontBytes.readUInt16BE(12);
  const compressedSize = fontBytes.readUInt32BE(20);
  let offset = 48;
  let cmapStart = -1;
  let cmapLength = 0;
  let decompressedOffset = 0;
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex++) {
    const flags = fontBytes[offset++];
    const knownTagIndex = flags & 0x3f;
    const tag = knownTagIndex === 0x3f ? fontBytes.toString('latin1', offset, offset + 4) : WOFF2_KNOWN_TABLE_TAGS[knownTagIndex];
    if (knownTagIndex === 0x3f) offset += 4;
    const original = readUIntBase128(fontBytes, offset);
    offset = original.offset;
    const transformVersion = flags >> 6;
    const isGlyphTable = tag === 'glyf' || tag === 'loca';
    const isTransformed = isGlyphTable ? transformVersion === 0 : transformVersion !== 0;
    let storedLength = original.value;
    if (isTransformed) {
      const transformed = readUIntBase128(fontBytes, offset);
      offset = transformed.offset;
      storedLength = transformed.value;
    }
    if (tag === 'cmap') {
      cmapStart = decompressedOffset;
      cmapLength = storedLength;
    }
    decompressedOffset += storedLength;
  }
  const tables = zlib.brotliDecompressSync(fontBytes.subarray(offset, offset + compressedSize));
  assert.ok(cmapStart >= 0, `${fontPath} has no cmap table`);
  return tables.subarray(cmapStart, cmapStart + cmapLength);
}

function format12CodePoints(cmap: Buffer, subtableOffset: number) {
  const codePoints = new Set<number>();
  const groupCount = cmap.readUInt32BE(subtableOffset + 12);
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const groupOffset = subtableOffset + 16 + groupIndex * 12;
    const lastCodePoint = cmap.readUInt32BE(groupOffset + 4);
    for (let codePoint = cmap.readUInt32BE(groupOffset); codePoint <= lastCodePoint; codePoint++) codePoints.add(codePoint);
  }
  return codePoints;
}

function format4CodePoints(cmap: Buffer, subtableOffset: number) {
  const codePoints = new Set<number>();
  const segmentCount = cmap.readUInt16BE(subtableOffset + 6) / 2;
  const endCodesOffset = subtableOffset + 14;
  const startCodesOffset = endCodesOffset + segmentCount * 2 + 2;
  const deltasOffset = startCodesOffset + segmentCount * 2;
  const rangeOffsetsOffset = deltasOffset + segmentCount * 2;
  for (let segment = 0; segment < segmentCount; segment++) {
    const endCode = cmap.readUInt16BE(endCodesOffset + segment * 2);
    const delta = cmap.readUInt16BE(deltasOffset + segment * 2);
    const rangeOffsetPosition = rangeOffsetsOffset + segment * 2;
    const rangeOffset = cmap.readUInt16BE(rangeOffsetPosition);
    for (let codePoint = cmap.readUInt16BE(startCodesOffset + segment * 2); codePoint <= endCode && codePoint !== 0xffff; codePoint++) {
      const glyphIndex = rangeOffset === 0
        ? (codePoint + delta) & 0xffff
        : cmap.readUInt16BE(rangeOffsetPosition + rangeOffset + (codePoint - cmap.readUInt16BE(startCodesOffset + segment * 2)) * 2);
      if (glyphIndex !== 0) codePoints.add(codePoint);
    }
  }
  return codePoints;
}

function bundledFontCodePoints(fontPath: string) {
  const cmap = readWoff2CmapTable(fontPath);
  const encodingCount = cmap.readUInt16BE(2);
  for (let encodingIndex = 0; encodingIndex < encodingCount; encodingIndex++) {
    const recordOffset = 4 + encodingIndex * 8;
    const subtableOffset = cmap.readUInt32BE(recordOffset + 4);
    const format = cmap.readUInt16BE(subtableOffset);
    if (format === 12) return format12CodePoints(cmap, subtableOffset);
  }
  for (let encodingIndex = 0; encodingIndex < encodingCount; encodingIndex++) {
    const recordOffset = 4 + encodingIndex * 8;
    const subtableOffset = cmap.readUInt32BE(recordOffset + 4);
    if (cmap.readUInt16BE(subtableOffset) === 4) return format4CodePoints(cmap, subtableOffset);
  }
  throw new Error(`${fontPath} has no format 4 or 12 cmap subtable`);
}

test('every session state glyph is drawn by the bundled mono font, so desktop and phone render the same mark', () => {
  for (const fontFile of ['commit-mono-400-regular.woff2', 'commit-mono-700-regular.woff2']) {
    const codePoints = bundledFontCodePoints(path.join(FONTS_DIRECTORY, fontFile));
    assert.ok(codePoints.has('A'.codePointAt(0) ?? 0), `${fontFile} cmap parse found no Latin letters`);
    const missingGlyphs = Object.entries(STATE_GLYPHS).filter(([, glyph]) => !codePoints.has(glyph.codePointAt(0) ?? 0));
    assert.deepEqual(missingGlyphs, [], fontFile);
  }
});
