import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ANIMAL_SPRITES_DIRECTORY = path.join(import.meta.dirname, '..', 'public', 'animals');

const TRANSPARENT_SYMBOL = '.';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGBA_BYTES_PER_PIXEL = 4;

type PixelArt = { widthPx: number; heightPx: number; rgbaPixels: Buffer };

function parsePalette(paletteBlock: string, sourceName: string): Map<string, number[]> {
  const colorsBySymbol = new Map<string, number[]>();
  for (const line of paletteBlock.split('\n')) {
    const paletteEntry = line.match(/^(\S) #([0-9a-f]{6})$/i);
    if (!paletteEntry) throw new Error(`${sourceName}: palette line "${line}" is not "<symbol> #rrggbb"`);
    const [, symbol, hex] = paletteEntry;
    if (symbol === TRANSPARENT_SYMBOL) throw new Error(`${sourceName}: "${TRANSPARENT_SYMBOL}" is reserved for transparent pixels`);
    colorsBySymbol.set(symbol, [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)));
  }
  return colorsBySymbol;
}

function parsePixelArt(source: string, sourceName: string): PixelArt {
  const [paletteBlock, ...frameBlocks] = source.trim().split(/\n\s*\n/);
  if (frameBlocks.length === 0) throw new Error(`${sourceName}: needs a palette block and at least one frame block`);
  const colorsBySymbol = parsePalette(paletteBlock, sourceName);
  const frames = frameBlocks.map((block) => block.split('\n'));
  const frameWidthPx = frames[0][0].length;
  const heightPx = frames[0].length;
  for (const [frameIndex, rows] of frames.entries()) {
    if (rows.length !== heightPx || rows.some((row) => row.length !== frameWidthPx)) {
      throw new Error(`${sourceName}: frame ${frameIndex + 1} is not ${frameWidthPx}x${heightPx} like the first frame`);
    }
  }
  const widthPx = frameWidthPx * frames.length;
  const rgbaPixels = Buffer.alloc(widthPx * heightPx * RGBA_BYTES_PER_PIXEL);
  for (const [frameIndex, rows] of frames.entries()) {
    for (const [y, row] of rows.entries()) {
      for (const [x, symbol] of [...row].entries()) {
        if (symbol === TRANSPARENT_SYMBOL) continue;
        const color = colorsBySymbol.get(symbol);
        if (!color) throw new Error(`${sourceName}: symbol "${symbol}" at frame ${frameIndex + 1} row ${y + 1} is not in the palette`);
        const offset = (y * widthPx + frameIndex * frameWidthPx + x) * RGBA_BYTES_PER_PIXEL;
        rgbaPixels.set([...color, 255], offset);
      }
    }
  }
  return { widthPx, heightPx, rgbaPixels };
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeAndPayload = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(zlib.crc32(typeAndPayload));
  return Buffer.concat([length, typeAndPayload, checksum]);
}

function encodePng({ widthPx, heightPx, rgbaPixels }: PixelArt): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(widthPx, 0);
  header.writeUInt32BE(heightPx, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rowBytes = widthPx * RGBA_BYTES_PER_PIXEL;
  const filteredRows = Buffer.alloc((rowBytes + 1) * heightPx);
  for (let y = 0; y < heightPx; y += 1) {
    rgbaPixels.copy(filteredRows, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(filteredRows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderAnimalSprites(directory = ANIMAL_SPRITES_DIRECTORY): Map<string, Buffer> {
  const pngBytesByFileName = new Map<string, Buffer>();
  for (const sourceFileName of fs.readdirSync(directory).filter((fileName) => fileName.endsWith('.txt')).sort()) {
    const source = fs.readFileSync(path.join(directory, sourceFileName), 'utf8');
    pngBytesByFileName.set(sourceFileName.replace(/\.txt$/, '.png'), encodePng(parsePixelArt(source, sourceFileName)));
  }
  return pngBytesByFileName;
}

if (process.argv[1] === import.meta.filename) {
  const pngBytesByFileName = renderAnimalSprites();
  for (const [fileName, pngBytes] of pngBytesByFileName) fs.writeFileSync(path.join(ANIMAL_SPRITES_DIRECTORY, fileName), pngBytes);
  console.log(`Wrote ${pngBytesByFileName.size} sprites to ${path.relative(process.cwd(), ANIMAL_SPRITES_DIRECTORY)}`);
}
