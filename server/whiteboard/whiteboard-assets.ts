import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sniffRasterImageMime } from '../core/shown-files-core.ts';
import { errorMessage } from '../../shared/text.ts';

const ASSETS_FOLDER_NAME = 'assets';
const ASSET_INPUT_CAP_BYTES = 25 * 1024 * 1024;
const ASSET_MAX_EDGE_PX = 1600;
const ASSET_WEBP_QUALITY = 85;
const ASSET_FILE_MODE = 0o600;
const ASSET_EXTENSION = '.webp';
const ASSET_FILENAME_RE = /^([0-9a-f]{64})\.webp$/;
const INCOMING_PREFIX = '.incoming-';
const ACCEPTED_TEXT = 'PNG, JPEG, WebP or GIF';
const OPEN_WITHOUT_BLOCKING_ON_A_PIPE = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

type IngestOutcome = { ok: true; asset: string; width: number; height: number } | { ok: false; status: number; error: string };

interface WhiteboardAssetStore {
  loaded: Promise<void>;
  has(assetId: string): boolean;
  ingestFile(sourcePath: string, name?: string): Promise<IngestOutcome>;
  reserveIncomingPath(): Promise<string>;
  ingestBuffer(bytes: Buffer, name: string): Promise<IngestOutcome>;
  filePathOf(assetId: string): string | null;
  dataUriOf(assetId: string, drawnWidth: number, drawnHeight: number): Promise<string | null>;
}

function assetIdOfFilename(filename: string): string | null {
  return ASSET_FILENAME_RE.exec(filename)?.[1] ?? null;
}

function overCapRefusal(name: string): IngestOutcome {
  return refusal(413, `${name} is larger than the ${ASSET_INPUT_CAP_BYTES / (1024 * 1024)} MB a board image takes`);
}

function refusal(status: number, error: string): IngestOutcome {
  return { ok: false, status, error };
}

async function readRegularFileCapped(sourcePath: string): Promise<Buffer | IngestOutcome> {
  const name = path.basename(sourcePath);
  const handle = await fsp.open(sourcePath, OPEN_WITHOUT_BLOCKING_ON_A_PIPE).catch(() => null);
  if (!handle) return refusal(404, `${sourcePath} is not a file this session can read`);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return refusal(404, `${sourcePath} is not a file this session can read`);
    if (stats.size > ASSET_INPUT_CAP_BYTES) return overCapRefusal(name);
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

function createWhiteboardAssetStore({ boardsRoot, logger = console }: { boardsRoot: string; logger?: Pick<Console, 'warn'> }): WhiteboardAssetStore {
  const assetsRoot = path.join(boardsRoot, ASSETS_FOLDER_NAME);
  const storedAssetIds = new Set<string>();
  const loaded = fsp.readdir(assetsRoot).then(async (filenames) => {
    for (const filename of filenames) {
      const assetId = assetIdOfFilename(filename);
      if (assetId) storedAssetIds.add(assetId);
    }
    const abandonedIncomingNames = filenames.filter((filename) => filename.startsWith(INCOMING_PREFIX));
    await Promise.all(abandonedIncomingNames.map((filename) => fsp.rm(path.join(assetsRoot, filename), { force: true }).catch(() => {})));
  }, () => {});

  async function store(normalized: Buffer): Promise<string> {
    const assetId = crypto.createHash('sha256').update(normalized).digest('hex');
    const finalPath = path.join(assetsRoot, `${assetId}${ASSET_EXTENSION}`);
    const isOnDisk = await fsp.access(finalPath).then(() => true, () => false);
    if (storedAssetIds.has(assetId) && isOnDisk) return assetId;
    await fsp.mkdir(assetsRoot, { recursive: true, mode: 0o700 });
    const partialPath = `${finalPath}.${crypto.randomBytes(4).toString('hex')}.partial`;
    try {
      await fsp.writeFile(partialPath, normalized, { mode: ASSET_FILE_MODE });
      await fsp.rename(partialPath, finalPath);
    } catch (error) {
      await fsp.rm(partialPath, { force: true }).catch(() => {});
      throw error;
    }
    storedAssetIds.add(assetId);
    return assetId;
  }

  async function ingestBuffer(bytes: Buffer, name: string): Promise<IngestOutcome> {
    await loaded;
    if (bytes.byteLength > ASSET_INPUT_CAP_BYTES) return overCapRefusal(name);
    if (!sniffRasterImageMime(bytes.subarray(0, 64))) return refusal(415, `${name} is not an image a board takes; a board takes ${ACCEPTED_TEXT}`);
    const { default: sharp } = await import('sharp');
    const normalized = await sharp(bytes, { animated: false })
      .rotate()
      .resize(ASSET_MAX_EDGE_PX, ASSET_MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: ASSET_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true })
      .catch(() => null);
    if (!normalized) return refusal(415, `${name} could not be read as an image`);
    try {
      const assetId = await store(normalized.data);
      return { ok: true, asset: assetId, width: normalized.info.width, height: normalized.info.height };
    } catch (error) {
      logger.warn(`[whiteboard] an image could not be stored: ${errorMessage(error)}`);
      return refusal(500, `${name} could not be stored`);
    }
  }

  async function ingestFile(sourcePath: string, name = path.basename(sourcePath)): Promise<IngestOutcome> {
    const bytes = await readRegularFileCapped(sourcePath);
    if (!Buffer.isBuffer(bytes)) return bytes;
    return ingestBuffer(bytes, name);
  }

  async function reserveIncomingPath(): Promise<string> {
    await loaded;
    await fsp.mkdir(assetsRoot, { recursive: true, mode: 0o700 });
    return path.join(assetsRoot, `${INCOMING_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  }

  function filePathOf(assetId: string): string | null {
    if (!storedAssetIds.has(assetId)) return null;
    return path.join(assetsRoot, `${assetId}${ASSET_EXTENSION}`);
  }

  async function dataUriOf(assetId: string, drawnWidth: number, drawnHeight: number): Promise<string | null> {
    const assetPath = filePathOf(assetId);
    if (!assetPath) return null;
    const { default: sharp } = await import('sharp');
    const drawn = await sharp(assetPath)
      .resize(Math.max(1, Math.round(drawnWidth)), Math.max(1, Math.round(drawnHeight)), { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
      .catch(() => null);
    return drawn ? `data:image/png;base64,${drawn.toString('base64')}` : null;
  }

  return { loaded, has: (assetId) => storedAssetIds.has(assetId), ingestFile, ingestBuffer, reserveIncomingPath, filePathOf, dataUriOf };
}

export { ASSET_INPUT_CAP_BYTES, assetIdOfFilename, createWhiteboardAssetStore };
export type { WhiteboardAssetStore };
