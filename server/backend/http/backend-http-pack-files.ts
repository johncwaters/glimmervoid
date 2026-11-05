import type { Request, Response } from 'express';
import { PACK_PANEL_CONTENT_POLICY, packFileMime } from '../../packs/core/pack-core.ts';

export type PackFileSource = (packName: string, accessKey: string, filePath: string) => Buffer | null;

function requestedFilePath(splat: unknown): string | null {
  if (!Array.isArray(splat) || splat.length === 0) return null;
  return splat.every((segment) => typeof segment === 'string') ? splat.join('/') : null;
}

export function servePackFile(req: Request, res: Response, packFileSource: PackFileSource | null): void {
  const filePath = requestedFilePath(req.params.filePath);
  const bytes = filePath === null ? null : packFileSource?.(String(req.params.packName), String(req.params.accessKey), filePath) ?? null;
  if (filePath === null || bytes === null) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Security-Policy', PACK_PANEL_CONTENT_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.setHeader('Content-Type', packFileMime(filePath));
  res.setHeader('Content-Length', String(bytes.byteLength));
  res.end(bytes);
}
