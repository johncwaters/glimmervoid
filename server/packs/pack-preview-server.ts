import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { errorMessage } from '../../shared/text.ts';
import { panelActionDecision } from '../../shared/pack-action-core.ts';
import { readCappedBody } from '../backend/http/backend-http-body.ts';
import { parseJsonRecord } from '../core/json-core.ts';
import { decideHostAllowed } from '../core/host-policy.ts';
import { packFileHeaders } from './core/pack-core.ts';
import { servedPackFile } from './core/pack-page-core.ts';
import { previewHostPage } from './core/pack-preview-core.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { readApprovedPackFingerprints, readPackDir } from './pack-files.ts';
import { clock } from '../../shared/clock.ts';

type PreviewResponse = { status: number; headers: Record<string, string>; body: string | Buffer };
type PreviewServer = { url: string; close(): Promise<void>; unref(): void };
type PreviewServerStart = { ok: true; server: PreviewServer } | { ok: false; error: string };

const PREVIEW_HOST = '127.0.0.1';
const FILES_PREFIX = 'files/';
const ACTION_PATH = 'action';
const ACTION_BODY_MAX_BYTES = 16 * 1024 * 1024;
const OPAQUE_ORIGIN = 'null';
const PACK_PREVIEW_ROUTE = '/pack-previews';
const PREVIEW_ID_HEX_CHARS = 32;
const PREVIEW_ID_PATTERN = /^[0-9a-f]{32}$/;
const SALT_FILE_NAME = 'salt';
const PACK_DIR_FILE_NAME = 'pack-dir';
const HOST_PAGE_POLICY = "sandbox allow-scripts allow-forms; frame-src 'self'";
const BOARD_PREVIEW_PAGE_NAME = 'preview.html';

const PreviewActionBody = z.object({ panel: z.string(), request: z.unknown() });

function jsonResponse(body: unknown, requestOrigin: string | undefined): PreviewResponse {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  return { status: 200, headers: requestOrigin === OPAQUE_ORIGIN ? { ...headers, 'Access-Control-Allow-Origin': OPAQUE_ORIGIN } : headers, body: JSON.stringify(body) };
}

async function previewActionResponse(packDir: string, request: http.IncomingMessage, env: NodeJS.ProcessEnv): Promise<PreviewResponse> {
  const requestOrigin = request.headers.origin;
  const bodyText = await readCappedBody(request, ACTION_BODY_MAX_BYTES, () => {}, { drainBytes: ACTION_BODY_MAX_BYTES });
  const body = PreviewActionBody.safeParse(bodyText === null ? null : parseJsonRecord(bodyText));
  if (!body.success) return jsonResponse({ ok: false, error: `not sent: the request was not JSON of at most ${ACTION_BODY_MAX_BYTES} bytes` }, requestOrigin);
  const read = await readPackDir(packDir, env);
  const pack = read.ok ? read.pack : null;
  const panel = pack?.ui?.ok ? pack.ui.value.panels.find((candidate) => candidate.id === body.data.panel) : undefined;
  if (!pack || !panel) return jsonResponse({ ok: false, error: `not sent: the pack has no panel ${body.data.panel}` }, requestOrigin);
  return jsonResponse(panelActionDecision({ pack: pack.header.name, panelId: panel.id, acts: panel.acts }, body.data.request), requestOrigin);
}

function decodedFilePath(restPath: string): string | null {
  try {
    return restPath.slice(FILES_PREFIX.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

async function previewResponse(packDir: string, restPath: string, requestOrigin: string | undefined, env: NodeJS.ProcessEnv, homeDir: string): Promise<PreviewResponse> {
  const read = await readPackDir(packDir, env);
  const pack = read.ok ? read.pack : null;
  if (restPath.startsWith(FILES_PREFIX)) {
    const filePath = decodedFilePath(restPath);
    const bytes = filePath === null || pack === null ? null : servedPackFile(filePath, pack.filesByPath);
    if (filePath === null || bytes === null) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not a file in the pack' };
    return { status: 200, headers: { ...packFileHeaders(filePath, requestOrigin), 'Cache-Control': 'no-store' }, body: bytes };
  }
  if (restPath !== '') return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
  const approvedFingerprints = readApprovedPackFingerprints(homeDir);
  const report = await checkPack(packDir, env, (fingerprint) => approvedFingerprints.has(fingerprint));
  const page = previewHostPage({ title: `Pack preview: ${report.name ?? path.basename(packDir)}`, report: packReportText(report), hasProblem: packCheckHasProblem(report), pack, nowMs: clock.nowMs() });
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HOST_PAGE_POLICY }, body: page };
}

function previewAnswer(packDir: string, request: http.IncomingMessage, restPath: string, env: NodeJS.ProcessEnv, homeDir: string): Promise<PreviewResponse> {
  const isAction = request.method === 'POST' && restPath === ACTION_PATH;
  return isAction ? previewActionResponse(packDir, request, env) : previewResponse(packDir, restPath, request.headers.origin, env, homeDir);
}

function sendPreview(response: http.ServerResponse, answering: Promise<PreviewResponse>): void {
  answering.then(
    ({ status, headers, body }) => response.writeHead(status, headers).end(body),
    (error: unknown) => response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(errorMessage(error)),
  );
}

export async function startPackPreviewServer({ packDir, port, env, homeDir }: { packDir: string; port: number; env: NodeJS.ProcessEnv; homeDir: string }): Promise<PreviewServerStart> {
  const server = http.createServer((request, response) => {
    if (!decideHostAllowed(request.headers.host)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Host not allowed');
      return;
    }
    const restPath = new URL(request.url ?? '/', `http://${PREVIEW_HOST}`).pathname.slice(1);
    sendPreview(response, previewAnswer(packDir, request, restPath, env, homeDir));
  });
  const listening = await new Promise<{ ok: true; port: number } | { ok: false; error: string }>((resolve) => {
    server.once('error', (error) => resolve({ ok: false, error: errorMessage(error) }));
    server.listen(port, PREVIEW_HOST, () => {
      const address = server.address();
      resolve({ ok: true, port: typeof address === 'object' && address !== null ? address.port : port });
    });
  });
  if (!listening.ok) return { ok: false, error: `could not listen on ${PREVIEW_HOST}:${port}: ${listening.error}` };
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { ok: true, server: { url: `http://${PREVIEW_HOST}:${listening.port}/`, close, unref: () => void server.unref() } };
}

function boardPreviewPage(packName: string, previewPath: string): string {
  const title = `Pack preview: ${packName}`.replace(/[<&"]/g, '');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>html, body { margin: 0; padding: 0; height: 100%; } iframe { display: block; width: 100%; height: 100vh; border: 0; }</style></head>
<body><iframe id="preview" title="${title}"></iframe><script>document.getElementById('preview').src = ${JSON.stringify(previewPath)};</script></body></html>
`;
}

export function createBoardPackPreviews({ env, homeDir, pagesDir }: { env: NodeJS.ProcessEnv; homeDir: string; pagesDir: string }) {
  let readingSalt: Promise<string> | null = null;

  async function readOrCreateSalt(): Promise<string> {
    const saltPath = path.join(pagesDir, SALT_FILE_NAME);
    await fsp.mkdir(pagesDir, { recursive: true });
    await fsp.writeFile(saltPath, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    return fsp.readFile(saltPath, 'utf8');
  }

  async function previewIdOf(realPackDir: string): Promise<string> {
    readingSalt ??= readOrCreateSalt();
    const salt = await readingSalt.catch((error: unknown) => {
      readingSalt = null;
      throw error;
    });
    return crypto.createHash('sha256').update(`${salt}\0${realPackDir}`).digest('hex').slice(0, PREVIEW_ID_HEX_CHARS);
  }

  async function pageFor(packDir: string, packName: string): Promise<{ ok: true; pagePath: string; url: string } | { ok: false; error: string }> {
    const realPackDir = await fsp.realpath(packDir).catch(() => null);
    if (realPackDir === null) return { ok: false, error: `${packDir} is not a folder on this machine` };
    try {
      const previewId = await previewIdOf(realPackDir);
      const previewPath = `${PACK_PREVIEW_ROUTE}/${previewId}/`;
      const pageDir = path.join(pagesDir, previewId);
      const pagePath = path.join(pageDir, BOARD_PREVIEW_PAGE_NAME);
      await fsp.mkdir(pageDir, { recursive: true });
      await fsp.writeFile(path.join(pageDir, PACK_DIR_FILE_NAME), realPackDir);
      await fsp.writeFile(pagePath, boardPreviewPage(packName, previewPath));
      return { ok: true, pagePath, url: previewPath };
    } catch (error: unknown) {
      return { ok: false, error: `could not write the preview page under ${pagesDir}: ${errorMessage(error)}` };
    }
  }

  async function packDirOf(previewId: string): Promise<string | null> {
    if (!PREVIEW_ID_PATTERN.test(previewId)) return null;
    return fsp.readFile(path.join(pagesDir, previewId, PACK_DIR_FILE_NAME), 'utf8').catch(() => null);
  }

  async function answer(request: http.IncomingMessage, previewId: string, restPath: string): Promise<PreviewResponse> {
    const packDir = await packDirOf(previewId);
    if (packDir === null) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'No such pack preview' };
    return previewAnswer(packDir, request, restPath, env, homeDir);
  }

  return { pageFor, answer };
}

export type BoardPackPreviews = ReturnType<typeof createBoardPackPreviews>;

function restPathOf(splat: unknown): string | null {
  if (splat === undefined) return '';
  if (!Array.isArray(splat)) return null;
  return splat.every((segment) => typeof segment === 'string') ? splat.join('/') : null;
}

export function mountPackPreviewRoutes(app: Express, previews: BoardPackPreviews | null): void {
  if (previews === null) return;
  const routePath = `${PACK_PREVIEW_ROUTE}/:previewId{/*restPath}`;
  const servePreview: RequestHandler = (request, response) => {
    const restPath = restPathOf(request.params.restPath);
    if (restPath === null) {
      response.status(404).end();
      return;
    }
    sendPreview(response, previews.answer(request, String(request.params.previewId), restPath));
  };
  app.get(routePath, servePreview);
  app.post(routePath, servePreview);
}
