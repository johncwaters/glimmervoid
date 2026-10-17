import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ANIMAL_SPRITES_DIRECTORY = path.join(import.meta.dirname, '..', 'public', 'animals');

const TRANSPARENT_SYMBOL = '.';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGBA_BYTES_PER_PIXEL = 4;
const ORTHOGONAL_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

type Rgba = number[];
type PixelArt = { widthPx: number; heightPx: number; rgbaPixels: Buffer };
type PixelArtSource = {
  colorsBySymbol: Map<string, Rgba>;
  outlineColor: Rgba | null;
  haloColor: Rgba | null;
  wrapsAtEdges: boolean;
  frames: string[][];
};

function parseHexColor(hex: string): Rgba {
  return [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2) || 'ff', 16));
}

function parsePixelArtSource(source: string, sourceName: string): PixelArtSource {
  const [headerBlock, ...frameBlocks] = source.trim().split(/\n\s*\n/);
  if (frameBlocks.length === 0) throw new Error(`${sourceName}: needs a palette block and at least one frame block`);
  const parsed: PixelArtSource = { colorsBySymbol: new Map(), outlineColor: null, haloColor: null, wrapsAtEdges: false, frames: [] };
  for (const line of headerBlock.split('\n')) {
    if (line === 'wrap') {
      parsed.wrapsAtEdges = true;
      continue;
    }
    const ringEntry = line.match(/^(outline|halo) #([0-9a-f]{6}(?:[0-9a-f]{2})?)$/i);
    if (ringEntry?.[1] === 'outline') {
      parsed.outlineColor = parseHexColor(ringEntry[2]);
      continue;
    }
    if (ringEntry?.[1] === 'halo') {
      parsed.haloColor = parseHexColor(ringEntry[2]);
      continue;
    }
    const paletteEntry = line.match(/^(\S) #([0-9a-f]{6})$/i);
    if (!paletteEntry) throw new Error(`${sourceName}: header line "${line}" is not "<symbol> #rrggbb", "outline #rrggbb", "halo #rrggbbaa" or "wrap"`);
    const [, symbol, hex] = paletteEntry;
    if (symbol === TRANSPARENT_SYMBOL) throw new Error(`${sourceName}: "${TRANSPARENT_SYMBOL}" is reserved for transparent pixels`);
    parsed.colorsBySymbol.set(symbol, parseHexColor(hex));
  }
  parsed.frames = frameBlocks.map((block) => block.split('\n'));
  const frameWidthPx = parsed.frames[0][0].length;
  const frameHeightPx = parsed.frames[0].length;
  for (const [frameIndex, rows] of parsed.frames.entries()) {
    if (rows.length !== frameHeightPx || rows.some((row) => row.length !== frameWidthPx)) {
      throw new Error(`${sourceName}: frame ${frameIndex + 1} is not ${frameWidthPx}x${frameHeightPx} like the first frame`);
    }
    for (const [y, row] of rows.entries()) {
      for (const symbol of row) {
        if (symbol !== TRANSPARENT_SYMBOL && !parsed.colorsBySymbol.has(symbol)) {
          throw new Error(`${sourceName}: symbol "${symbol}" at frame ${frameIndex + 1} row ${y + 1} is not in the palette`);
        }
      }
    }
  }
  return parsed;
}

function ringAround(isFilled: (x: number, y: number) => boolean, widthPx: number, heightPx: number, wrapsAtEdges: boolean): boolean[][] {
  return Array.from({ length: heightPx }, (_, y) => Array.from({ length: widthPx }, (_, x) => {
    if (isFilled(x, y)) return false;
    return ORTHOGONAL_STEPS.some(([stepX, stepY]) => {
      const neighborX = wrapsAtEdges ? (x + stepX + widthPx) % widthPx : x + stepX;
      const neighborY = wrapsAtEdges ? (y + stepY + heightPx) % heightPx : y + stepY;
      if (neighborX < 0 || neighborY < 0 || neighborX >= widthPx || neighborY >= heightPx) return false;
      return isFilled(neighborX, neighborY);
    });
  }));
}

function renderFrame(source: PixelArtSource, rows: string[]): (Rgba | null)[][] {
  const heightPx = rows.length;
  const widthPx = rows[0].length;
  const pixels: (Rgba | null)[][] = rows.map((row) => [...row].map((symbol) => source.colorsBySymbol.get(symbol) ?? null));
  for (const ringColor of [source.outlineColor, source.haloColor]) {
    if (!ringColor) continue;
    const ring = ringAround((x, y) => pixels[y][x] !== null, widthPx, heightPx, source.wrapsAtEdges);
    for (const [y, ringRow] of ring.entries()) {
      for (const [x, isRing] of ringRow.entries()) {
        if (isRing) pixels[y][x] = ringColor;
      }
    }
  }
  return pixels;
}

function renderPixelArt(source: PixelArtSource): PixelArt {
  const frameWidthPx = source.frames[0][0].length;
  const heightPx = source.frames[0].length;
  const widthPx = frameWidthPx * source.frames.length;
  const rgbaPixels = Buffer.alloc(widthPx * heightPx * RGBA_BYTES_PER_PIXEL);
  for (const [frameIndex, rows] of source.frames.entries()) {
    for (const [y, pixelRow] of renderFrame(source, rows).entries()) {
      for (const [x, color] of pixelRow.entries()) {
        if (color) rgbaPixels.set(color, (y * widthPx + frameIndex * frameWidthPx + x) * RGBA_BYTES_PER_PIXEL);
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

export function readAnimalSpriteSources(directory = ANIMAL_SPRITES_DIRECTORY): Map<string, PixelArtSource> {
  const sourcesByName = new Map<string, PixelArtSource>();
  for (const sourceFileName of fs.readdirSync(directory).filter((fileName) => fileName.endsWith('.txt')).sort()) {
    const source = fs.readFileSync(path.join(directory, sourceFileName), 'utf8');
    sourcesByName.set(sourceFileName.replace(/\.txt$/, ''), parsePixelArtSource(source, sourceFileName));
  }
  return sourcesByName;
}

export function renderAnimalSprites(directory = ANIMAL_SPRITES_DIRECTORY): Map<string, Buffer> {
  const pngBytesByFileName = new Map<string, Buffer>();
  for (const [name, source] of readAnimalSpriteSources(directory)) pngBytesByFileName.set(`${name}.png`, encodePng(renderPixelArt(source)));
  return pngBytesByFileName;
}

if (process.argv[1] === import.meta.filename) {
  const pngBytesByFileName = renderAnimalSprites();
  for (const [fileName, pngBytes] of pngBytesByFileName) fs.writeFileSync(path.join(ANIMAL_SPRITES_DIRECTORY, fileName), pngBytes);
  console.log(`Wrote ${pngBytesByFileName.size} sprites to ${path.relative(process.cwd(), ANIMAL_SPRITES_DIRECTORY)}`);
}
