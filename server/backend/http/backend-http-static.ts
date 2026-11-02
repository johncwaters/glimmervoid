import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type { Express, RequestHandler } from 'express';

const HASHED_ASSET_PREFIX = '/assets/';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function isHashedAssetPath(requestPath: string): boolean {
  return requestPath.startsWith(HASHED_ASSET_PREFIX);
}

function acceptsBrotli(acceptEncoding: string | string[] | undefined): boolean {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding ?? '';
  return header.split(',').some((entry) => {
    const [coding = '', ...parameters] = entry.trim().toLowerCase().split(';');
    if (coding.trim() !== 'br') return false;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith('q='));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

function resolveClientFile(rootDir: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0')) return null;
  const relativePath = decodedPath.endsWith('/') ? `${decodedPath}index.html` : decodedPath;
  const filePath = path.resolve(rootDir, `.${relativePath}`);
  if (!filePath.startsWith(path.resolve(rootDir) + path.sep)) return null;
  return filePath;
}

function createPrecompressedStatic(rootDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const filePath = resolveClientFile(rootDir, req.path);
    if (!filePath) return next();
    const compressedPath = `${filePath}.br`;
    fsp.stat(compressedPath)
      .then((compressedStat) => {
        if (!compressedStat.isFile()) return next();
        res.setHeader('Vary', 'Accept-Encoding');
        if (!acceptsBrotli(req.headers['accept-encoding'])) return next();
        res.type(path.extname(filePath));
        res.setHeader('Content-Encoding', 'br');
        const cacheOptions = isHashedAssetPath(req.path) ? { maxAge: ONE_YEAR_MS, immutable: true } : {};
        res.sendFile(path.relative(rootDir, compressedPath), { root: rootDir, ...cacheOptions }, (error) => {
          if (!error || res.headersSent) return;
          res.removeHeader('Content-Encoding');
          next();
        });
      })
      .catch(() => next());
  };
}

function serveClientDir(app: Express, rootDir: string): void {
  app.use(createPrecompressedStatic(rootDir));
  app.use(express.static(rootDir, {
    setHeaders: (res, filePath) => {
      if (!filePath.startsWith(path.join(path.resolve(rootDir), 'assets') + path.sep)) return;
      res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_MS / 1000}, immutable`);
    },
  }));
}

export { serveClientDir };
