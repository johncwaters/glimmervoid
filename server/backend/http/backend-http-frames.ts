import type { Express, Request, Response } from 'express';
import { keyedFramePath, verifiedFrameRequest } from '../../core/frame-capability-core.ts';
import { packFileHeaders } from '../../packs/core/pack-core.ts';
import { FRAME_OPEN_ROUTE, FRAME_ROUTE } from '../../../shared/contracts/whiteboard.ts';

export type PackFileSource = (packName: string, accessKey: string, filePath: string) => Buffer | null;
const FRAME_OPEN_KEY = FRAME_OPEN_ROUTE.slice(FRAME_ROUTE.length + 1);

type BoardPageFileServer = (req: Request, res: Response, assetId: string, memberPath: string) => void;

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
  for (const [name, value] of Object.entries(packFileHeaders(filePath, req.headers.origin))) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.setHeader('Content-Length', String(bytes.byteLength));
  res.end(bytes);
}

export function mountKeyedFrameRoutes(app: Express, { secret, serveBoardPageFile }: { secret: Buffer; serveBoardPageFile: BoardPageFileServer }): void {
  app.get(`${FRAME_ROUTE}/:key/*innerPath`, (req, res, next) => {
    const innerPath = requestedFilePath(req.params.innerPath);
    const frame = innerPath === null ? null : verifiedFrameRequest(secret, String(req.params.key), innerPath);
    if (frame === null && req.params.key === FRAME_OPEN_KEY) {
      next();
      return;
    }
    if (frame === null) {
      res.status(404).end();
      return;
    }
    const [family, kind, scopeId] = frame.scope;
    if (family === 'whiteboards' && kind === 'pages' && scopeId !== undefined) {
      serveBoardPageFile(req, res, scopeId, frame.restPath);
      return;
    }
    res.status(404).end();
  });
}

export function mountFrameOpenRoute(app: Express, secret: Buffer): void {
  app.get(`${FRAME_OPEN_ROUTE}/*innerPath`, (req, res) => {
    const innerPath = requestedFilePath(req.params.innerPath);
    const keyedPath = innerPath === null ? null : keyedFramePath(secret, innerPath);
    if (keyedPath === null) {
      res.status(404).end();
      return;
    }
    const requestUrl = req.url ?? '';
    const queryStart = requestUrl.indexOf('?');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, queryStart === -1 ? keyedPath : `${keyedPath}${requestUrl.slice(queryStart)}`);
  });
}
