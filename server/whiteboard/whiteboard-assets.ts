import { isUtf8 } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { execFileAsync } from '../child-process-safe.ts';
import { decideShownKind, SHOWN_SNIFF_BYTES } from '../core/shown-files-core.ts';
import { resolveFfmpegPath } from '../runtime-paths.ts';
import { SHOWN_FILE_CAP_BYTES } from '../../shared/contracts/session.ts';
import { BOARD_DOC_CAP_BYTES, BOARD_MEDIA_MAX_EDGE_PX } from '../../shared/contracts/whiteboard.ts';
import type { BoxMedia, Dial } from '../../shared/contracts/whiteboard.ts';
import { DIAL_MANIFEST_SCAN_BYTES, dialManifestOf } from '../core/dial-manifest-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { clock } from '../../shared/clock.ts';

const ASSETS_FOLDER_NAME = 'assets';
const ASSET_INPUT_CAP_BYTES = SHOWN_FILE_CAP_BYTES;
const PREVIEW_MAX_EDGE_PX = 1024;
const PREVIEW_WEBP_QUALITY = 85;
const MAX_INPUT_PIXELS = 16384 * 16384;
const PAGE_WIDTH_PX = 1280;
const PAGE_HEIGHT_PX = 800;
const DOC_WIDTH_PX = 800;
const DOC_HEIGHT_PX = 1000;
const UNPOSTERED_VIDEO_WIDTH_PX = 1280;
const UNPOSTERED_VIDEO_HEIGHT_PX = 720;
const VIDEO_POSTER_TIMEOUT_MS = 15_000;
const ASSET_FILE_MODE = 0o600;
const PREVIEW_SUFFIX = '.preview.webp';
const ORIGINAL_FILENAME_RE = /^([0-9a-f]{64})(\.png|\.jpg|\.gif|\.webp|\.svg|\.mp4|\.webm|\.html|\.md)$/;
const PREVIEW_FILENAME_RE = /^([0-9a-f]{64})\.preview\.webp$/;
const INCOMING_PREFIX = '.incoming-';
const ATTACH_HOLD_MS = 10 * 60_000;
const STILL_IMAGE_FTYP_BRANDS = new Set(['mif1', 'msf1', 'mif2', 'avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'avci', 'avcs', 'jpeg', 'j2ki', 'j2is', 'crx ']);
const FTYP_BRANDS_OFFSET = 16;
const ACCEPTED_TEXT = 'PNG, JPEG, WebP, GIF, SVG, MP4, WebM, HTML or Markdown';
const OPEN_WITHOUT_BLOCKING_ON_A_PIPE = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

interface MediaFormat {
  kind: BoxMedia['kind'];
  mime: BoxMedia['mime'];
  contentType: string;
  hasLargeRasterPreview: boolean;
}

const MEDIA_FORMAT_BY_EXTENSION: Record<string, MediaFormat> = {
  '.png': { kind: 'image', mime: 'image/png', contentType: 'image/png', hasLargeRasterPreview: true },
  '.jpg': { kind: 'image', mime: 'image/jpeg', contentType: 'image/jpeg', hasLargeRasterPreview: true },
  '.gif': { kind: 'image', mime: 'image/gif', contentType: 'image/gif', hasLargeRasterPreview: false },
  '.webp': { kind: 'image', mime: 'image/webp', contentType: 'image/webp', hasLargeRasterPreview: false },
  '.svg': { kind: 'image', mime: 'image/svg+xml', contentType: 'image/svg+xml', hasLargeRasterPreview: false },
  '.mp4': { kind: 'video', mime: 'video/mp4', contentType: 'video/mp4', hasLargeRasterPreview: false },
  '.webm': { kind: 'video', mime: 'video/webm', contentType: 'video/webm', hasLargeRasterPreview: false },
  '.html': { kind: 'page', mime: 'text/html', contentType: 'text/html; charset=utf-8', hasLargeRasterPreview: false },
  '.md': { kind: 'doc', mime: 'text/markdown', contentType: 'text/markdown; charset=utf-8', hasLargeRasterPreview: false },
};

interface StoredAsset {
  extension: string;
  hasPreview: boolean;
  dials: Dial[];
  media: BoxMedia | null;
}

interface ServableAsset {
  path: string;
  contentType: string;
}

type IngestOutcome = { ok: true; media: BoxMedia } | { ok: false; status: number; error: string };
type Refusal = Extract<IngestOutcome, { ok: false }>;
type MediaSize = { width: number; height: number; hasPreview: boolean };

interface WhiteboardAssetStore {
  loaded: Promise<void>;
  has(assetId: string): boolean;
  ingestFile(sourcePath: string, name?: string): Promise<IngestOutcome>;
  adoptIncoming(incomingPath: string, name: string): Promise<IngestOutcome>;
  reserveIncomingPath(): Promise<string>;
  hold(assetId: string, holdMs: number): void;
  sweep(referencedAssetIds: ReadonlySet<string>): Promise<number>;
  servableOf(filename: string): ServableAsset | null;
  mismatchOf(media: BoxMedia): string | null;
  dataUriOf(media: Pick<BoxMedia, 'kind' | 'asset'>, drawnWidth: number, drawnHeight: number): Promise<string | null>;
  readDocText(media: Pick<BoxMedia, 'kind' | 'asset'>): Promise<string | null>;
}

function ftypBrandsOf(firstChunk: Buffer): string[] {
  const ftypBoxEnd = Math.min(firstChunk.length, firstChunk.length >= 4 ? firstChunk.readUInt32BE(0) : 0);
  const compatibleBrands: string[] = [];
  for (let offset = FTYP_BRANDS_OFFSET; offset + 4 <= ftypBoxEnd; offset += 4) compatibleBrands.push(firstChunk.toString('latin1', offset, offset + 4));
  return [firstChunk.toString('latin1', 8, 12), ...compatibleBrands];
}

function isStillImageInVideoContainer(firstChunk: Buffer, sniffedExtension: string): boolean {
  if (sniffedExtension !== '.mp4') return false;
  return ftypBrandsOf(firstChunk).some((brand) => STILL_IMAGE_FTYP_BRANDS.has(brand));
}

function refusal(status: number, error: string): Refusal {
  return { ok: false, status, error };
}

function overCapRefusal(name: string): Refusal {
  return refusal(413, `${name} is larger than the ${ASSET_INPUT_CAP_BYTES / (1024 * 1024)} MB a board takes`);
}

function overDocCapRefusal(name: string): Refusal {
  return refusal(413, `${name} is larger than the ${BOARD_DOC_CAP_BYTES / 1024} KiB a board document takes`);
}

function notUtf8Refusal(name: string): Refusal {
  return refusal(415, `${name} is not UTF-8 text; a board document is UTF-8 Markdown`);
}

async function docRefusalOf(incomingPath: string, name: string): Promise<Refusal | null> {
  if ((await fsp.stat(incomingPath)).size > BOARD_DOC_CAP_BYTES) return overDocCapRefusal(name);
  if (!isUtf8(await fsp.readFile(incomingPath))) return notUtf8Refusal(name);
  return null;
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

async function readFirstChunk(filePath: string): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const firstChunk = Buffer.alloc(SHOWN_SNIFF_BYTES);
    const { bytesRead } = await handle.read(firstChunk, 0, SHOWN_SNIFF_BYTES, 0);
    return firstChunk.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyRegularFileCapped(sourcePath: string, incomingPath: string): Promise<Refusal | null> {
  const name = path.basename(sourcePath);
  const source = await fsp.open(sourcePath, OPEN_WITHOUT_BLOCKING_ON_A_PIPE).catch(() => null);
  if (!source) return refusal(404, `${sourcePath} is not a file this session can read`);
  try {
    const stats = await source.stat();
    if (!stats.isFile()) return refusal(404, `${sourcePath} is not a file this session can read`);
    if (stats.size > ASSET_INPUT_CAP_BYTES) return overCapRefusal(name);
    const incoming = await fsp.open(incomingPath, 'wx', ASSET_FILE_MODE);
    try {
      let copiedBytes = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        copiedBytes += chunk.byteLength;
        if (copiedBytes > ASSET_INPUT_CAP_BYTES) return overCapRefusal(name);
        await incoming.write(chunk);
      }
      return null;
    } finally {
      await incoming.close().catch(() => {});
    }
  } finally {
    await source.close().catch(() => {});
  }
}

async function isFileOpenPassingFailure(filePath: string): Promise<boolean> {
  return fsp.open(filePath).then(
    (handle) => handle.close().then(() => false, () => false),
    (failure: unknown) => failure instanceof Error && hasPassingErrorCode(failure),
  );
}

async function rasterSizeOf(filePath: string): Promise<{ width: number; height: number } | 'unreadable' | 'interrupted'> {
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(filePath, { animated: false, limitInputPixels: MAX_INPUT_PIXELS }).metadata().catch(async (failure: unknown) => (isPassingRasterFailure(failure) || await isFileOpenPassingFailure(filePath) ? 'interrupted' as const : null));
  if (metadata === 'interrupted') return 'interrupted';
  const width = metadata?.autoOrient.width ?? 0;
  const height = metadata?.autoOrient.height ?? 0;
  return width > 0 && height > 0 ? { width, height } : 'unreadable';
}

async function writeRasterPreview(sourcePath: string, previewPath: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp(sourcePath, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize(PREVIEW_MAX_EDGE_PX, PREVIEW_MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PREVIEW_WEBP_QUALITY })
    .toFile(previewPath);
}

type PosterOutcome = 'written' | 'undecodable' | 'interrupted';

const PASSING_FAILURE_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC']);
const STOPPING_SIGNALS = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP']);
const PASSING_OUTPUT_FAILURE_TEXT = /No space left on device|Too many open files|Resource temporarily unavailable/i;
const PASSING_RASTER_FAILURE_TEXT = /No space left on device|Too many open files|Resource temporarily unavailable|Cannot allocate memory|out of memory/i;

function failureTextOf(failure: Error): string {
  const stderr = 'stderr' in failure && typeof failure.stderr === 'string' ? failure.stderr : '';
  return `${failure.message}\n${stderr}`;
}

function hasPassingErrorCode(failure: Error): boolean {
  return 'code' in failure && typeof failure.code === 'string' && PASSING_FAILURE_CODES.has(failure.code);
}

function isPassingRasterFailure(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  return hasPassingErrorCode(failure) || PASSING_RASTER_FAILURE_TEXT.test(failureTextOf(failure));
}

function posterFailureOf(failure: unknown): PosterOutcome {
  if (!(failure instanceof Error)) return 'undecodable';
  const wasStoppedBySignal = ('killed' in failure && failure.killed === true) || ('signal' in failure && typeof failure.signal === 'string' && STOPPING_SIGNALS.has(failure.signal));
  if (wasStoppedBySignal || hasPassingErrorCode(failure) || PASSING_OUTPUT_FAILURE_TEXT.test(failureTextOf(failure))) return 'interrupted';
  return 'undecodable';
}

async function writeVideoPoster(sourcePath: string, posterPath: string): Promise<PosterOutcome> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return 'undecodable';
  const scaleFilter = `scale='min(${PREVIEW_MAX_EDGE_PX},iw)':'min(${PREVIEW_MAX_EDGE_PX},ih)':force_original_aspect_ratio=decrease`;
  return execFileAsync(ffmpegPath, ['-v', 'error', '-i', sourcePath, '-frames:v', '1', '-vf', scaleFilter, '-c:v', 'libwebp', '-quality', String(PREVIEW_WEBP_QUALITY), '-y', posterPath], { timeout: VIDEO_POSTER_TIMEOUT_MS })
    .then((): PosterOutcome => 'written', posterFailureOf);
}

function interruptedReadRefusal(name: string): Refusal {
  return refusal(503, `${name} could not be read while the machine was short of resources; attach it again`);
}

async function sizeImage(sourcePath: string, previewPath: string, format: MediaFormat, name: string): Promise<MediaSize | Refusal> {
  const size = await rasterSizeOf(sourcePath);
  if (size === 'interrupted') return interruptedReadRefusal(name);
  if (size === 'unreadable') return refusal(415, `${name} could not be read as an image`);
  if (Math.max(size.width, size.height) > BOARD_MEDIA_MAX_EDGE_PX) return refusal(413, `${name} is ${size.width}x${size.height} pixels; a board takes at most ${BOARD_MEDIA_MAX_EDGE_PX} on each edge`);
  if (!format.hasLargeRasterPreview || Math.max(size.width, size.height) <= PREVIEW_MAX_EDGE_PX) return { ...size, hasPreview: false };
  const previewFailure = await writeRasterPreview(sourcePath, previewPath).then(() => null, (failure: unknown) => failure);
  if (!previewFailure) return { ...size, hasPreview: true };
  if (isPassingRasterFailure(previewFailure)) return refusal(503, `${name} could not be shrunk for drawing while the machine was short of resources; attach it again`);
  return { ...size, hasPreview: false };
}

async function sizeVideo(sourcePath: string, previewPath: string, name: string): Promise<MediaSize | Refusal> {
  const posterOutcome = await writeVideoPoster(sourcePath, previewPath);
  if (posterOutcome === 'interrupted') return refusal(503, `${name}'s first frame could not be read before ffmpeg was stopped or the machine ran short of resources; attach it again`);
  const posterSize = posterOutcome === 'written' ? await rasterSizeOf(previewPath) : 'unreadable';
  if (posterSize === 'interrupted') return interruptedReadRefusal(name);
  if (posterSize === 'unreadable') return { width: UNPOSTERED_VIDEO_WIDTH_PX, height: UNPOSTERED_VIDEO_HEIGHT_PX, hasPreview: false };
  return { ...posterSize, hasPreview: true };
}

function fixedViewportSizeOf(format: MediaFormat): MediaSize | null {
  if (format.kind === 'page') return { width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX, hasPreview: false };
  if (format.kind === 'doc') return { width: DOC_WIDTH_PX, height: DOC_HEIGHT_PX, hasPreview: false };
  return null;
}

async function sizeStoredMedia(sourcePath: string, previewPath: string, format: MediaFormat, hasStoredPreview: boolean, name: string): Promise<MediaSize | Refusal> {
  const fixedViewportSize = fixedViewportSizeOf(format);
  if (fixedViewportSize) return fixedViewportSize;
  const drawnSize = await rasterSizeOf(format.kind === 'video' ? previewPath : sourcePath);
  if (drawnSize === 'interrupted') return interruptedReadRefusal(name);
  if (format.kind === 'video') return { ...(hasStoredPreview && drawnSize !== 'unreadable' ? drawnSize : { width: UNPOSTERED_VIDEO_WIDTH_PX, height: UNPOSTERED_VIDEO_HEIGHT_PX }), hasPreview: hasStoredPreview };
  if (drawnSize === 'unreadable') return refusal(415, `${name} could not be read as an image`);
  return { ...drawnSize, hasPreview: hasStoredPreview };
}

function sizeMedia(sourcePath: string, previewPath: string, format: MediaFormat, name: string): Promise<MediaSize | Refusal> {
  const fixedViewportSize = fixedViewportSizeOf(format);
  if (fixedViewportSize) return Promise.resolve(fixedViewportSize);
  if (format.kind === 'video') return sizeVideo(sourcePath, previewPath, name);
  return sizeImage(sourcePath, previewPath, format, name);
}

async function pageOpeningOf(pagePath: string): Promise<string | null> {
  const page = await fsp.open(pagePath, 'r').catch(() => null);
  if (!page) return null;
  const opening = Buffer.alloc(DIAL_MANIFEST_SCAN_BYTES);
  const read = await page.read(opening, 0, DIAL_MANIFEST_SCAN_BYTES, 0).catch(() => null);
  await page.close().catch(() => {});
  return read ? opening.subarray(0, read.bytesRead).toString('utf8') : null;
}

async function storedDialsOf(pagePath: string): Promise<Dial[]> {
  const pageHtml = await pageOpeningOf(pagePath);
  const manifest = pageHtml === null ? null : dialManifestOf(pageHtml);
  return manifest?.ok ? manifest.dials : [];
}

async function dialsOf(pagePath: string, format: MediaFormat, name: string): Promise<Dial[] | Refusal> {
  if (format.kind !== 'page') return [];
  const pageHtml = await pageOpeningOf(pagePath);
  if (pageHtml === null) return interruptedReadRefusal(name);
  const manifest = dialManifestOf(pageHtml);
  return manifest.ok ? manifest.dials : refusal(422, `${name} declares dials a board cannot take: ${manifest.error}`);
}

function createWhiteboardAssetStore({ boardsRoot, logger = console, now = clock.nowMs }: { boardsRoot: string; logger?: Pick<Console, 'warn'>; now?: () => number }): WhiteboardAssetStore {
  const assetsRoot = path.join(boardsRoot, ASSETS_FOLDER_NAME);
  const storedByAssetId = new Map<string, StoredAsset>();
  const heldUntilByAssetId = new Map<string, number>();
  const settledIngestByAssetId = new Map<string, Promise<void>>();
  const loaded = fsp.readdir(assetsRoot).then(async (filenames) => {
    const previewAssetIds = new Set(filenames.flatMap((filename) => PREVIEW_FILENAME_RE.exec(filename)?.[1] ?? []));
    for (const filename of filenames) {
      const match = ORIGINAL_FILENAME_RE.exec(filename);
      if (!match?.[1] || !match[2] || storedByAssetId.has(match[1])) continue;
      const isPage = MEDIA_FORMAT_BY_EXTENSION[match[2]]?.kind === 'page';
      const dials = isPage ? await storedDialsOf(path.join(assetsRoot, filename)) : [];
      if (!storedByAssetId.has(match[1])) storedByAssetId.set(match[1], { extension: match[2], hasPreview: previewAssetIds.has(match[1]), dials, media: null });
    }
    const abandonedIncomingNames = filenames.filter((filename) => filename.startsWith(INCOMING_PREFIX));
    await Promise.all(abandonedIncomingNames.map((filename) => fsp.rm(path.join(assetsRoot, filename), { force: true }).catch(() => {})));
  }, () => {});

  function originalPathOf(assetId: string, extension: string): string {
    return path.join(assetsRoot, `${assetId}${extension}`);
  }

  function previewPathOf(assetId: string): string {
    return path.join(assetsRoot, `${assetId}${PREVIEW_SUFFIX}`);
  }

  async function storeIncoming(incomingPath: string, assetId: string, sniffedExtension: string, name: string): Promise<IngestOutcome> {
    hold(assetId, ATTACH_HOLD_MS);
    const stored = storedByAssetId.get(assetId);
    const extension = stored?.extension ?? sniffedExtension;
    const format = MEDIA_FORMAT_BY_EXTENSION[extension];
    if (!format) return refusal(415, `${name} is not a file a board takes; a board takes ${ACCEPTED_TEXT}`);
    const finalPath = originalPathOf(assetId, extension);
    const isOnDisk = await fsp.access(finalPath).then(() => true, () => false);
    if (stored?.media && isOnDisk) return { ok: true, media: stored.media };
    const previewPath = previewPathOf(assetId);
    const draftPreviewPath = `${await reserveIncomingPath()}${PREVIEW_SUFFIX}`;
    try {
      const isOriginalStored = Boolean(stored) && isOnDisk;
      const sized = isOriginalStored ? await sizeStoredMedia(incomingPath, previewPath, format, stored?.hasPreview ?? false, name) : await sizeMedia(incomingPath, draftPreviewPath, format, name);
      if (isRefusal(sized)) return sized;
      const dials = await dialsOf(incomingPath, format, name);
      if (isRefusal(dials)) return dials;
      if (sized.hasPreview && !isOriginalStored) await fsp.rename(draftPreviewPath, previewPath);
      const { hasPreview } = sized;
      await fsp.rename(incomingPath, finalPath);
      const media: BoxMedia = { kind: format.kind, asset: assetId, mime: format.mime, width: sized.width, height: sized.height, alt: '', hasPreview, dials, link: null };
      storedByAssetId.set(assetId, { extension, hasPreview, dials, media });
      hold(assetId, ATTACH_HOLD_MS);
      return { ok: true, media };
    } finally {
      await fsp.rm(draftPreviewPath, { force: true }).catch(() => {});
    }
  }

  async function storeIncomingInTurn(incomingPath: string, assetId: string, sniffedExtension: string, name: string): Promise<IngestOutcome> {
    hold(assetId, ATTACH_HOLD_MS);
    const earlierIngest = settledIngestByAssetId.get(assetId) ?? Promise.resolve();
    const ingest = earlierIngest.then(() => storeIncoming(incomingPath, assetId, sniffedExtension, name));
    const settledIngest = ingest.then(() => {}, () => {});
    settledIngestByAssetId.set(assetId, settledIngest);
    try {
      return await ingest;
    } finally {
      if (settledIngestByAssetId.get(assetId) === settledIngest) settledIngestByAssetId.delete(assetId);
    }
  }

  async function adoptIncoming(incomingPath: string, name: string): Promise<IngestOutcome> {
    await loaded;
    try {
      const firstChunk = await readFirstChunk(incomingPath);
      const verdict = decideShownKind(firstChunk, name);
      const format = verdict.ok ? MEDIA_FORMAT_BY_EXTENSION[verdict.extension] : undefined;
      if (!verdict.ok || !format || isStillImageInVideoContainer(firstChunk, verdict.extension)) return refusal(415, `${name} is not a file a board takes; a board takes ${ACCEPTED_TEXT}`);
      const docRefusal = format.kind === 'doc' ? await docRefusalOf(incomingPath, name) : null;
      if (docRefusal) return docRefusal;
      return await storeIncomingInTurn(incomingPath, await hashFile(incomingPath), verdict.extension, name);
    } catch (error) {
      logger.warn(`[whiteboard] board media could not be stored: ${errorMessage(error)}`);
      return refusal(500, `${name} could not be stored`);
    } finally {
      await fsp.rm(incomingPath, { force: true }).catch(() => {});
    }
  }

  async function ingestFile(sourcePath: string, name = path.basename(sourcePath)): Promise<IngestOutcome> {
    const incomingPath = await reserveIncomingPath();
    const copyRefusal = await copyRegularFileCapped(sourcePath, incomingPath).catch((error: unknown) => {
      logger.warn(`[whiteboard] board media could not be copied: ${errorMessage(error)}`);
      return refusal(500, `${name} could not be stored`);
    });
    if (copyRefusal) {
      await fsp.rm(incomingPath, { force: true }).catch(() => {});
      return copyRefusal;
    }
    return adoptIncoming(incomingPath, name);
  }

  async function reserveIncomingPath(): Promise<string> {
    await loaded;
    await fsp.mkdir(assetsRoot, { recursive: true, mode: 0o700 });
    return path.join(assetsRoot, `${INCOMING_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
  }

  function hold(assetId: string, holdMs: number): void {
    const heldUntil = now() + holdMs;
    if ((heldUntilByAssetId.get(assetId) ?? 0) >= heldUntil) return;
    heldUntilByAssetId.set(assetId, heldUntil);
  }

  function isHeld(assetId: string): boolean {
    return (heldUntilByAssetId.get(assetId) ?? 0) > now();
  }

  async function removeStoredFiles(assetId: string, stored: StoredAsset): Promise<void> {
    const filePaths = [originalPathOf(assetId, stored.extension), previewPathOf(assetId)];
    await Promise.all(filePaths.map((filePath) => fsp.rm(filePath, { force: true }).catch((error: unknown) => {
      logger.warn(`[whiteboard] unused board media ${assetId} could not be deleted: ${errorMessage(error)}`);
    })));
  }

  async function sweep(referencedAssetIds: ReadonlySet<string>): Promise<number> {
    const swept = [...storedByAssetId].filter(([assetId]) => !referencedAssetIds.has(assetId) && !isHeld(assetId));
    for (const [assetId] of swept) {
      storedByAssetId.delete(assetId);
      heldUntilByAssetId.delete(assetId);
    }
    await Promise.all(swept.map(([assetId, stored]) => removeStoredFiles(assetId, stored)));
    return swept.length;
  }

  function servableOf(filename: string): ServableAsset | null {
    const previewAssetId = PREVIEW_FILENAME_RE.exec(filename)?.[1];
    if (previewAssetId) return storedByAssetId.get(previewAssetId)?.hasPreview ? { path: previewPathOf(previewAssetId), contentType: 'image/webp' } : null;
    const match = ORIGINAL_FILENAME_RE.exec(filename);
    const assetId = match?.[1];
    const extension = match?.[2];
    const format = extension ? MEDIA_FORMAT_BY_EXTENSION[extension] : undefined;
    if (!assetId || !extension || !format || storedByAssetId.get(assetId)?.extension !== extension) return null;
    return { path: originalPathOf(assetId, extension), contentType: format.contentType };
  }

  function mismatchOf(media: BoxMedia): string | null {
    const stored = storedByAssetId.get(media.asset);
    const format = stored ? MEDIA_FORMAT_BY_EXTENSION[stored.extension] : undefined;
    if (!stored || !format) return `media ${media.asset}, which no whiteboard attach stored`;
    const storedFields = { kind: format.kind, mime: format.mime, hasPreview: stored.hasPreview, dials: stored.dials };
    const isMatching = media.kind === storedFields.kind && media.mime === storedFields.mime && media.hasPreview === storedFields.hasPreview && JSON.stringify(media.dials) === JSON.stringify(stored.dials);
    return isMatching ? null : `media ${media.asset} as ${JSON.stringify({ kind: media.kind, mime: media.mime, hasPreview: media.hasPreview, dials: media.dials })}, but attach stored it as ${JSON.stringify(storedFields)}`;
  }

  function pictureSourceOf(media: Pick<BoxMedia, 'kind' | 'asset'>): string | null {
    const stored = storedByAssetId.get(media.asset);
    if (!stored) return null;
    if (stored.hasPreview) return previewPathOf(media.asset);
    return media.kind === 'image' ? originalPathOf(media.asset, stored.extension) : null;
  }

  async function readDocText(media: Pick<BoxMedia, 'kind' | 'asset'>): Promise<string | null> {
    const stored = storedByAssetId.get(media.asset);
    if (media.kind !== 'doc' || !stored || MEDIA_FORMAT_BY_EXTENSION[stored.extension]?.kind !== 'doc') return null;
    return fsp.readFile(originalPathOf(media.asset, stored.extension), 'utf8').catch(() => null);
  }

  async function dataUriOf(media: Pick<BoxMedia, 'kind' | 'asset'>, drawnWidth: number, drawnHeight: number): Promise<string | null> {
    const sourcePath = pictureSourceOf(media);
    if (!sourcePath) return null;
    const { default: sharp } = await import('sharp');
    const drawn = await sharp(sourcePath, { animated: false, autoOrient: true, limitInputPixels: MAX_INPUT_PIXELS })
      .resize(Math.max(1, Math.round(drawnWidth)), Math.max(1, Math.round(drawnHeight)), { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
      .catch(() => null);
    return drawn ? `data:image/png;base64,${drawn.toString('base64')}` : null;
  }

  return { loaded, has: (assetId) => storedByAssetId.has(assetId), ingestFile, adoptIncoming, reserveIncomingPath, hold, sweep, servableOf, mismatchOf, dataUriOf, readDocText };
}

export { ASSET_INPUT_CAP_BYTES, createWhiteboardAssetStore };
export type { WhiteboardAssetStore };
