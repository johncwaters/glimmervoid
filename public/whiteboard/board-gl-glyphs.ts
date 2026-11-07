import type { GlyphCell, GlyphSource } from './board-gl-scene.ts';

const ATLAS_SIZE = 2048;
const RASTER_PX = 48;
const PAD_PX = 4;
const CELL_WIDTH_PX = Math.ceil(RASTER_PX * 0.6) + PAD_PX * 2;
const CELL_HEIGHT_PX = Math.ceil(RASTER_PX * 1.35) + PAD_PX * 2;
const BASELINE_PX = PAD_PX + Math.round(RASTER_PX * 1.02);
const COLUMNS_PER_PAGE = Math.floor(ATLAS_SIZE / CELL_WIDTH_PX);
const ROWS_PER_PAGE = Math.floor(ATLAS_SIZE / CELL_HEIGHT_PX);
const CELLS_PER_PAGE = COLUMNS_PER_PAGE * ROWS_PER_PAGE;
const MIP_LEVELS = Math.log2(ATLAS_SIZE) + 1;
const PREBUILT_FIRST_CODE = 33;
const PREBUILT_LAST_CODE = 126;
const MAX_PAGES = 8;
const MAX_GLYPHS = MAX_PAGES * CELLS_PER_PAGE;
const REPLACEMENT_CHARACTER = '?';

interface PlacedGlyph {
  cell: GlyphCell;
  index: number;
  character: string;
  isBold: boolean;
  coverage: Uint8Array;
}

interface GlyphAtlas extends GlyphSource {
  bind: (gl: WebGL2RenderingContext, unit: number) => void;
  forgetTexture: () => void;
  release: (gl: WebGL2RenderingContext) => void;
  rasterizeAgain: () => void;
  isFull: () => boolean;
  forgetUnusedGlyphs: () => void;
}

function createScratchContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(CELL_WIDTH_PX, CELL_HEIGHT_PX) : Object.assign(document.createElement('canvas'), { width: CELL_WIDTH_PX, height: CELL_HEIGHT_PX });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('this browser cannot draw text for the whiteboard');
  return context;
}

function createGlyphAtlas(fontFamily: string): GlyphAtlas {
  const scratch = createScratchContext();
  const placedByKey = new Map<string, PlacedGlyph>();
  const placedInOrder: PlacedGlyph[] = [];
  let pendingUploads: PlacedGlyph[] = [];
  let texture: WebGLTexture | null = null;
  let texturePageCapacity = 0;

  function coverageOf(character: string, isBold: boolean): Uint8Array {
    scratch.clearRect(0, 0, CELL_WIDTH_PX, CELL_HEIGHT_PX);
    scratch.font = `${isBold ? 700 : 400} ${RASTER_PX}px ${fontFamily}`;
    scratch.textBaseline = 'alphabetic';
    scratch.fillStyle = '#fff';
    scratch.fillText(character, PAD_PX, BASELINE_PX);
    const pixels = scratch.getImageData(0, 0, CELL_WIDTH_PX, CELL_HEIGHT_PX).data;
    const coverage = new Uint8Array(CELL_WIDTH_PX * CELL_HEIGHT_PX);
    for (let pixel = 0; pixel < coverage.length; pixel += 1) coverage[pixel] = pixels[pixel * 4 + 3] ?? 0;
    return coverage;
  }

  function place(character: string, isBold: boolean): PlacedGlyph {
    const index = placedInOrder.length;
    const page = Math.floor(index / CELLS_PER_PAGE);
    const slot = index % CELLS_PER_PAGE;
    const left = (slot % COLUMNS_PER_PAGE) * CELL_WIDTH_PX;
    const top = Math.floor(slot / COLUMNS_PER_PAGE) * CELL_HEIGHT_PX;
    const cell = { u0: left / ATLAS_SIZE, v0: top / ATLAS_SIZE, u1: (left + CELL_WIDTH_PX) / ATLAS_SIZE, v1: (top + CELL_HEIGHT_PX) / ATLAS_SIZE, page };
    const placed = { cell, index, character, isBold, coverage: coverageOf(character, isBold) };
    placedByKey.set(`${isBold ? 'b' : 'r'}${character}`, placed);
    placedInOrder.push(placed);
    pendingUploads.push(placed);
    return placed;
  }

  function cellOf(character: string, isBold: boolean): GlyphCell {
    const placed = placedByKey.get(`${isBold ? 'b' : 'r'}${character}`);
    if (placed) return placed.cell;
    if (placedInOrder.length >= MAX_GLYPHS) return cellOf(REPLACEMENT_CHARACTER, isBold);
    return place(character, isBold).cell;
  }

  function placePrebuilt(): void {
    for (let code = PREBUILT_FIRST_CODE; code <= PREBUILT_LAST_CODE; code += 1) {
      cellOf(String.fromCharCode(code), false);
      cellOf(String.fromCharCode(code), true);
    }
  }

  function forgetUnusedGlyphs(): void {
    placedByKey.clear();
    placedInOrder.length = 0;
    pendingUploads = [];
    placePrebuilt();
  }

  function allocateTexture(gl: WebGL2RenderingContext, pageCount: number): void {
    if (texture) gl.deleteTexture(texture);
    texture = gl.createTexture();
    texturePageCapacity = Math.max(1, pageCount);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, MIP_LEVELS, gl.R8, ATLAS_SIZE, ATLAS_SIZE, texturePageCapacity);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    pendingUploads = [...placedInOrder];
  }

  function bind(gl: WebGL2RenderingContext, unit: number): void {
    const pageCount = Math.ceil(placedInOrder.length / CELLS_PER_PAGE);
    if (!texture || pageCount > texturePageCapacity) allocateTexture(gl, Math.min(pageCount * 2, MAX_PAGES));
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    if (pendingUploads.length === 0) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const placed of pendingUploads) {
      const slot = placed.index % CELLS_PER_PAGE;
      const left = (slot % COLUMNS_PER_PAGE) * CELL_WIDTH_PX;
      const top = Math.floor(slot / COLUMNS_PER_PAGE) * CELL_HEIGHT_PX;
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, left, top, placed.cell.page, CELL_WIDTH_PX, CELL_HEIGHT_PX, 1, gl.RED, gl.UNSIGNED_BYTE, placed.coverage);
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    pendingUploads = [];
  }

  function rasterizeAgain(): void {
    for (const placed of placedInOrder) placed.coverage = coverageOf(placed.character, placed.isBold);
    pendingUploads = [...placedInOrder];
  }

  placePrebuilt();

  return {
    cellOf,
    cellWidthEm: CELL_WIDTH_PX / RASTER_PX,
    cellHeightEm: CELL_HEIGHT_PX / RASTER_PX,
    padLeftEm: PAD_PX / RASTER_PX,
    ascentEm: BASELINE_PX / RASTER_PX,
    bind,
    forgetTexture: () => {
      texture = null;
      texturePageCapacity = 0;
    },
    release: (gl) => {
      if (texture) gl.deleteTexture(texture);
      texture = null;
      texturePageCapacity = 0;
    },
    rasterizeAgain,
    isFull: () => placedInOrder.length >= MAX_GLYPHS,
    forgetUnusedGlyphs,
  };
}

export { createGlyphAtlas, RASTER_PX };
export type { GlyphAtlas };
