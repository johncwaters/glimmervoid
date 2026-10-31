import fsp from 'node:fs/promises';

import { execFileAsync } from '../child-process-safe.ts';
import { SHOWN_THUMBNAIL_MAX_EDGE_PX } from '../core/shown-files-core.ts';
import type { ThumbnailRecipe } from '../core/shown-files-core.ts';
import { resolveFfmpegPath } from '../runtime-paths.ts';

const VIDEO_POSTER_TIMEOUT_MS = 15_000;
const THUMBNAIL_WEBP_QUALITY = 80;

async function writeImageThumbnail(sourcePath: string, thumbnailPath: string): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp(sourcePath, { animated: false })
    .resize(SHOWN_THUMBNAIL_MAX_EDGE_PX, SHOWN_THUMBNAIL_MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toFile(thumbnailPath);
}

async function writeVideoPoster(sourcePath: string, thumbnailPath: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg-static has no binary for this platform');
  const scaleFilter = `scale='min(${SHOWN_THUMBNAIL_MAX_EDGE_PX},iw)':'min(${SHOWN_THUMBNAIL_MAX_EDGE_PX},ih)':force_original_aspect_ratio=decrease`;
  await execFileAsync(ffmpegPath, ['-v', 'error', '-i', sourcePath, '-frames:v', '1', '-vf', scaleFilter, '-c:v', 'libwebp', '-quality', String(THUMBNAIL_WEBP_QUALITY), '-y', thumbnailPath], { timeout: VIDEO_POSTER_TIMEOUT_MS });
}

const THUMBNAIL_WRITERS: Record<Exclude<ThumbnailRecipe, 'none'>, (sourcePath: string, thumbnailPath: string) => Promise<void>> = {
  image: writeImageThumbnail,
  'video-poster': writeVideoPoster,
};

async function makeShownThumbnail(recipe: ThumbnailRecipe, sourcePath: string, thumbnailPath: string): Promise<boolean> {
  if (recipe === 'none') return false;
  try {
    await THUMBNAIL_WRITERS[recipe](sourcePath, thumbnailPath);
    return true;
  } catch {
    await fsp.unlink(thumbnailPath).catch(() => {});
    return false;
  }
}

export { makeShownThumbnail };
