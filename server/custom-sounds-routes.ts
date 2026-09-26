import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { Express, Response } from 'express';
import { customSoundContentType, decideByteRange, isDirectChildOf, selectCustomSoundNames } from './core/custom-sounds-core.ts';

const CUSTOM_SOUNDS_ROUTE = '/custom-sounds';

async function listCustomSounds(soundsDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(soundsDir, { withFileTypes: true });
    return selectCustomSoundNames(entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() })));
  } catch {
    return [];
  }
}

async function resolveServableSound(soundsDir: string, name: string): Promise<{ realFile: string; sizeBytes: number } | null> {
  try {
    const realDirectory = await fsp.realpath(soundsDir);
    const realFile = await fsp.realpath(path.join(soundsDir, name));
    if (!isDirectChildOf(realDirectory, realFile)) return null;
    const linkStats = await fsp.lstat(path.join(soundsDir, name));
    if (!linkStats.isFile()) return null;
    return { realFile, sizeBytes: linkStats.size };
  } catch {
    return null;
  }
}

function refuseMissingSound(res: Response): void {
  res.status(404).type('text/plain').send('sound not found');
}

function mountCustomSoundRoutes(app: Express, { soundsDir }: { soundsDir: string }): void {
  app.get(CUSTOM_SOUNDS_ROUTE, (_req, res) => {
    void listCustomSounds(soundsDir).then((sounds) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ sounds });
    });
  });

  app.get(`${CUSTOM_SOUNDS_ROUTE}/:name`, (req, res) => {
    const name = req.params.name;
    const contentType = customSoundContentType(name);
    if (!contentType) {
      refuseMissingSound(res);
      return;
    }
    void resolveServableSound(soundsDir, name).then((servable) => {
      if (!servable) {
        refuseMissingSound(res);
        return;
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      const byteRange = decideByteRange(req.headers.range, servable.sizeBytes);
      if (byteRange.kind === 'unsatisfiable') {
        res.status(416).setHeader('Content-Range', `bytes */${servable.sizeBytes}`);
        res.end();
        return;
      }
      res.setHeader('Content-Type', contentType);
      if (byteRange.kind === 'partial') {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${byteRange.start}-${byteRange.end}/${servable.sizeBytes}`);
        res.setHeader('Content-Length', String(byteRange.end - byteRange.start + 1));
        pipeline(fs.createReadStream(servable.realFile, { start: byteRange.start, end: byteRange.end }), res, () => {});
        return;
      }
      res.setHeader('Content-Length', String(servable.sizeBytes));
      pipeline(fs.createReadStream(servable.realFile), res, () => {});
    });
  });
}

export { CUSTOM_SOUNDS_ROUTE, mountCustomSoundRoutes };
