import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../../shared/text.ts';
import { panelActionDecision, panelActionsJsonSchemaText } from '../../shared/pack-action-core.ts';
import { readCappedBody } from '../backend/http/backend-http-body.ts';
import { parseJsonRecord } from '../core/json-core.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV } from '../../shared/contracts/session.ts';
import type { ParsedCommand } from '../core/cli-spec-core.ts';
import { glimmervoidHomeDir } from '../core/config-path-core.ts';
import { decideHostAllowed } from '../core/host-policy.ts';
import { examplePacksDir } from '../runtime-paths.ts';
import { packFileHeaders } from './core/pack-core.ts';
import { previewHostPage } from './core/pack-preview-core.ts';
import { packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
import { packJsonSchemaText } from '../../shared/contracts/pack.ts';
import { prFlowsOutputJsonSchemaText } from '../../shared/contracts/pr-flows.ts';
import { packGuideText } from './pack-agent.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { readApprovedPackFingerprints, readPackDir } from './pack-files.ts';

type ParsedRun = Extract<ParsedCommand, { kind: 'run' }>;
type PreviewResponse = { status: number; headers: Record<string, string>; body: string | Buffer };

const PREVIEW_HOST = '127.0.0.1';
const FILES_PREFIX = '/files/';
const ACTION_PATH = '/action';
const ACTION_BODY_MAX_BYTES = 16 * 1024 * 1024;

const PreviewActionBody = z.object({ panel: z.string(), request: z.unknown() });

function jsonResponse(body: unknown): PreviewResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function previewActionResponse(packDir: string, request: http.IncomingMessage, env: NodeJS.ProcessEnv): Promise<PreviewResponse> {
  const bodyText = await readCappedBody(request, ACTION_BODY_MAX_BYTES, () => {}, { drainBytes: ACTION_BODY_MAX_BYTES });
  const body = PreviewActionBody.safeParse(bodyText === null ? null : parseJsonRecord(bodyText));
  if (!body.success) return jsonResponse({ ok: false, error: `not sent: the request was not JSON of at most ${ACTION_BODY_MAX_BYTES} bytes` });
  const read = await readPackDir(packDir, env);
  const panel = read.ok && read.pack.ui?.ok ? read.pack.ui.value.panels.find((candidate) => candidate.id === body.data.panel) : undefined;
  if (!panel) return jsonResponse({ ok: false, error: `not sent: the pack has no panel ${body.data.panel}` });
  return jsonResponse(panelActionDecision(panel.acts, body.data.request));
}

async function runPackCheckCli({ packDir, isJson, env, homeDir }: { packDir: string; isJson: boolean; env: NodeJS.ProcessEnv; homeDir: string }): Promise<number> {
  const approvedFingerprints = readApprovedPackFingerprints(homeDir);
  const report = await checkPack(packDir, env, (fingerprint) => approvedFingerprints.has(fingerprint));
  process.stdout.write(`${isJson ? JSON.stringify(report, null, 2) : packReportText(report)}\n`);
  return packCheckHasProblem(report) ? 1 : 0;
}

const SCHEMA_TEXT_BY_NAME: Readonly<Record<string, () => string>> = { pack: packJsonSchemaText, bridge: packBridgeJsonSchemaText, actions: panelActionsJsonSchemaText, 'pr-flows': prFlowsOutputJsonSchemaText };

async function runGuide(homeDir: string, schemaName: string | null): Promise<number> {
  if (schemaName === null) {
    const schemaHint = 'The JSON Schemas, with what each field means: glimmervoid packs guide --schema pack (pack.json), --schema bridge (panel bridge messages), --schema actions (the request of each panel action) and --schema pr-flows (what a prFlows command prints).';
    process.stdout.write(`${await packGuideText({ homeDir, examplePacksDir }, [schemaHint])}\n`);
    return 0;
  }
  const schemaText = SCHEMA_TEXT_BY_NAME[schemaName];
  if (!schemaText) {
    process.stderr.write(`glimmervoid packs guide: --schema is pack, bridge, actions or pr-flows, not ${schemaName}\n`);
    return 1;
  }
  process.stdout.write(schemaText());
  return 0;
}

async function runList(): Promise<number> {
  if (!process.env[AGENT_URL_ENV]) {
    process.stderr.write('glimmervoid packs list reads the running Glimmervoid, so it works inside a Glimmervoid session; the operator sees the same list in Settings, Packs\n');
    return 1;
  }
  const { askAgentApi } = await import('../agent-api-cli.ts');
  const reply = AGENT_REPLY_SCHEMAS.packs.safeParse(await askAgentApi('packs', { command: 'list' }));
  if (!reply.success) {
    process.stderr.write('glimmervoid packs list: Glimmervoid did not answer with a pack list\n');
    return 1;
  }
  if (!reply.data.ok) {
    process.stderr.write(`glimmervoid packs list: ${reply.data.error}\n`);
    return 1;
  }
  process.stdout.write(`${reply.data.text}\n`);
  return 0;
}

function decodedFilePath(urlPath: string): string | null {
  try {
    return urlPath.slice(FILES_PREFIX.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

async function previewResponse(packDir: string, requestUrl: string, requestOrigin: string | undefined, env: NodeJS.ProcessEnv, homeDir: string): Promise<PreviewResponse> {
  const urlPath = new URL(requestUrl, `http://${PREVIEW_HOST}`).pathname;
  const read = await readPackDir(packDir, env);
  const pack = read.ok ? read.pack : null;
  if (urlPath.startsWith(FILES_PREFIX)) {
    const filePath = decodedFilePath(urlPath);
    const bytes = filePath === null ? undefined : pack?.filesByPath.get(filePath);
    if (filePath === null || bytes === undefined) return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not a file in the pack' };
    return { status: 200, headers: { ...packFileHeaders(filePath, requestOrigin), 'Cache-Control': 'no-store' }, body: bytes };
  }
  if (urlPath !== '/') return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };
  const approvedFingerprints = readApprovedPackFingerprints(homeDir);
  const report = await checkPack(packDir, env, (fingerprint) => approvedFingerprints.has(fingerprint));
  const page = previewHostPage({ title: `Pack preview: ${report.name ?? path.basename(packDir)}`, report: packReportText(report), hasProblem: packCheckHasProblem(report), pack, nowMs: Date.now() });
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: page };
}

async function runPreview(packDir: string, portText: string | null, env: NodeJS.ProcessEnv, homeDir: string): Promise<number> {
  const port = portText === null ? 0 : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`glimmervoid packs preview: --port must be a port number, not ${portText}\n`);
    return 1;
  }
  const server = http.createServer((request, response) => {
    if (!decideHostAllowed(request.headers.host)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Host not allowed');
      return;
    }
    const isAction = request.method === 'POST' && new URL(request.url ?? '/', `http://${PREVIEW_HOST}`).pathname === ACTION_PATH;
    const responding = isAction ? previewActionResponse(packDir, request, env) : previewResponse(packDir, request.url ?? '/', request.headers.origin, env, homeDir);
    responding.then(
      ({ status, headers, body }) => response.writeHead(status, headers).end(body),
      (error: unknown) => response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(errorMessage(error)),
    );
  });
  const listening = await new Promise<{ ok: true; port: number } | { ok: false; error: string }>((resolve) => {
    server.once('error', (error) => resolve({ ok: false, error: errorMessage(error) }));
    server.listen(port, PREVIEW_HOST, () => {
      const address = server.address();
      resolve({ ok: true, port: typeof address === 'object' && address !== null ? address.port : port });
    });
  });
  if (!listening.ok) {
    process.stderr.write(`glimmervoid packs preview: could not listen on ${PREVIEW_HOST}:${port}: ${listening.error}\n`);
    return 1;
  }
  process.stdout.write(`Previewing ${packDir} at http://${PREVIEW_HOST}:${listening.port}/ with sample data; each page load re-reads the pack. Stop with Ctrl-C.\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => server.close(() => resolve()));
    process.once('SIGTERM', () => server.close(() => resolve()));
  });
  return 0;
}

export async function runPacksCli(parsed: ParsedRun): Promise<number> {
  const env = process.env;
  const homeDir = glimmervoidHomeDir(os.homedir(), env);
  const [packFolder] = parsed.positionals;
  const subcommand = parsed.commandPath[1];
  if (subcommand === 'guide') return runGuide(homeDir, typeof parsed.values.schema === 'string' ? parsed.values.schema : null);
  if (subcommand === 'list') return runList();
  if (packFolder === undefined) return 1;
  const packDir = path.resolve(packFolder);
  if (subcommand === 'check') return runPackCheckCli({ packDir, isJson: parsed.values.json === true, env, homeDir });
  return runPreview(packDir, typeof parsed.values.port === 'string' ? parsed.values.port : null, env, homeDir);
}
