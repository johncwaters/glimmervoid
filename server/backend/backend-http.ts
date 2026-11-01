import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import { HOOK_EVENTS } from '../../detection/settings-injector.ts';
import { PLAN_HOOK_EVENT, PLAN_RESULT_HOOK_EVENT } from '../../shared/contracts/plan-review.ts';
import { CONVERSATION_PERMISSION_HOOK_EVENT, CONVERSATION_TOOL_RESULT_HOOK_EVENT } from '../../shared/contracts/session.ts';
import { parseJsonRecord } from '../core/json-core.ts';
import type { Session } from '../../session/sessions.ts';
import { refocusReplyFor, toolHookContextReplyOf } from '../../session/core/refocus-core.ts';
import type { RefocusContext } from '../../session/core/refocus-core.ts';
import type { ToolHookContextResponse, UserPromptSubmitHookResponse } from '../../shared/contracts/refocus.ts';
import type { AgentApiPort } from '../agent-api-wiring.ts';
import { checkAgentReply, decideAgentRequest, REFUSAL_REASON, REFUSAL_STATUS } from '../core/agent-api-core.ts';
import { SSH_SIGN_BODY_CAP_BYTES, SshSignRequest } from '../../shared/contracts/session.ts';
import { WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { decideHostAllowed } from '../core/host-policy.ts';
import { errorMessage } from '../../shared/text.ts';
import { isSignableGitObject, parseSshPublicKey } from '../core/ssh-signing-core.ts';
import type { SshSigner } from '../ssh-signing.ts';
import { decideOpenExternalRequest, OPEN_EXTERNAL_BODY_CAP_BYTES } from '../core/open-external-core.ts';
import { decideOriginAllowed } from '../core/origin-policy.ts';
import { classifyRequestOrigin } from '../core/request-trust.ts';
import type { HostUrlOpener } from '../host-url-opener.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { resolveCustomSoundsDir } from '../core/custom-sounds-core.ts';
import { mountCustomSoundRoutes } from '../custom-sounds-routes.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { clientDir } from '../runtime-paths.ts';
import { decideByteRange } from '../core/custom-sounds-core.ts';
import { describeOverCap, isShownPageMime, leavesVisibleRawTextOpen, SHOWN_PAGE_ZOOM_BRIDGE, SHOWN_SNIFF_BYTES } from '../core/shown-files-core.ts';
import { SHOWN_CAPTION_MAX_CHARS, SHOWN_FILE_CAP_BYTES } from '../../shared/contracts/session.ts';
import type { ServableShownFile, ShownFilesPort } from '../session/shown-files-wiring.ts';
import {
  MAX_UPLOAD_BYTES,
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  framePathPaste,
  imageMimeForUploadFilename,
  isSafePathSegment,
  planUploadRetention,
} from '../core/upload-core.ts';

const HOOK_BODY_CAP_BYTES = 64 * 1024;
const AGENT_OVERSIZE_DRAIN_BYTES = 4 * 1024 * 1024;
const AGENT_BODY_CAP_BYTES_BY_VERB: Readonly<Record<string, number>> = { whiteboard: WHITEBOARD_LIMITS.putBytes + HOOK_BODY_CAP_BYTES };
const UNNAMED_HOOK_EVENT = 'an unknown event';
const SILENT_OVERSIZE_HOOK_EVENTS: ReadonlySet<string> = new Set(['posttooluse', 'posttoolusefailure', CONVERSATION_TOOL_RESULT_HOOK_EVENT]);
const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  ...HOOK_EVENTS.map((event) => event.toLowerCase()),
  'pretooluse',
  'posttooluse',
  'posttoolusefailure',
  'statusline',
  PLAN_HOOK_EVENT,
  PLAN_RESULT_HOOK_EVENT,
  CONVERSATION_PERMISSION_HOOK_EVENT,
  CONVERSATION_TOOL_RESULT_HOOK_EVENT,
]);

function knownHookEventName(event: string): string {
  const name = event.toLowerCase();
  return KNOWN_HOOK_EVENTS.has(name) ? name : UNNAMED_HOOK_EVENT;
}

function isLoopbackRequest(req: Request): boolean {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function presentedToken(req: Request): string | null {
  const queryToken = req.query?.t;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
}

function readCappedBody(
  req: Request,
  capBytes: number,
  onOversize: (declaredBytes: string) => void,
  { drainBytes = 0 }: { drainBytes?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    let isOversize = false;
    const abandon = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    const declaredBytes = () => String(req.headers['content-length'] || `at least ${receivedBytes}`);
    req.on('error', abandon);
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes <= capBytes) {
        chunks.push(chunk);
        return;
      }
      isOversize = true;
      chunks.length = 0;
      if (receivedBytes <= capBytes + drainBytes) return;
      onOversize(declaredBytes());
      req.destroy();
      abandon();
    });
    req.on('end', () => {
      if (settled) return;
      if (isOversize) {
        onOversize(declaredBytes());
        abandon();
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function parseJsonBody(body: string): Record<string, unknown> {
  return parseJsonRecord(body, { admitArrays: true }) ?? {};
}

interface HookRouterOutput {
  status: number;
  reason: string;
}

interface PlanReviewHookPort {
  hookBodyCapBytes(event: string): number;
  onHookEvent(event: {
    glimmervoidId: string;
    event: string;
    payload: Record<string, unknown>;
    accepted: boolean;
    signal: AbortSignal;
  }): Promise<Record<string, unknown> | null> | null;
}

function hookBodyCapBytes(event: string, planReview: PlanReviewHookPort | null): number {
  return Math.max(HOOK_BODY_CAP_BYTES, planReview?.hookBodyCapBytes(event) ?? 0);
}

interface BackendHttpDependencies {
  staticDir: string | null;
  customSoundsDir?: string;
  configStore: { configPath: string };
  remote: { allowedOrigins: string[] };
  remoteAuth: { httpMiddleware: RequestHandler; mountPairRoutes: (app: Express) => void } | null;
  allowedHosts: string[];
  listenerPortsFor: (socket: { localPort?: number | null } | null) => number[];
  pageToken: string;
  remoteListenerPort?: number | null;
  tokenMatches?: (presented: unknown) => boolean;
  openUrlOnHost?: HostUrlOpener;
  hookRouter: {
    handle: (input: Record<string, unknown>) => HookRouterOutput;
    enrich?: (input: { glimmervoidId: string; event: string; token: string | null; payload: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  };
  getSession: (id: string) => Session | null;
  getUsage: () => { ingestStatusline: (payload: object) => void };
  getPlanReview?: () => PlanReviewHookPort | null;
  refocusContextFor?: (glimmervoidId: string) => RefocusContext;
  takePromptSupervision?: (glimmervoidId: string) => UserPromptSubmitHookResponse | null;
  getAgentApi?: () => AgentApiPort | null;
  getShownFiles?: () => ShownFilesPort | null;
  sshSigner?: Pick<SshSigner, 'signWithAgent'> | null;
  recordOutcome?: OutcomeRecorder;
  logger?: Pick<Console, 'warn'>;
}

function isStatuslineEvent(event: unknown): boolean {
  return String(event || '').toLowerCase() === 'statusline';
}

async function sweepSessionUploads(dir: string, justWritten: string): Promise<void> {
  let entries: string[] | null = null;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of planUploadRetention(entries, { justWritten })) {
    try {
      await fsp.unlink(path.join(dir, name));
    } catch {}
  }
}

type StreamToFileOutcome =
  | { ok: true; sizeBytes: number }
  | { ok: false; reason: 'over-cap' | 'write-failed' | 'aborted'; bytesReceived: number };

function streamRequestToFile({ req, savedPath, capBytes }: {
  req: Request;
  savedPath: string;
  capBytes: number;
}): Promise<StreamToFileOutcome> {
  return new Promise((resolve) => {
    const writeStream = fs.createWriteStream(savedPath, { mode: 0o600 });
    const writeStreamClosed = new Promise((resolveClosed) => writeStream.once('close', resolveClosed));
    let bytesReceived = 0;
    let settled = false;
    const fail = (reason: 'over-cap' | 'write-failed' | 'aborted') => {
      if (settled) return;
      settled = true;
      const outcome: StreamToFileOutcome = { ok: false, reason, bytesReceived };
      void writeStreamClosed
        .then(() => fsp.unlink(savedPath).catch(() => {}))
        .then(() => resolve(outcome));
    };
    const stopWritingAndDrain = () => {
      req.unpipe(writeStream);
      writeStream.destroy();
      req.resume();
    };
    writeStream.on('error', () => {
      stopWritingAndDrain();
      fail('write-failed');
    });
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, sizeBytes: bytesReceived });
    });
    req.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (settled || !exceedsUploadCap(bytesReceived, capBytes)) return;
      stopWritingAndDrain();
      fail('over-cap');
    });
    req.on('error', () => {
      writeStream.destroy();
      fail('aborted');
    });
    req.on('close', () => {
      if (req.complete) return;
      writeStream.destroy();
      fail('aborted');
    });
    req.pipe(writeStream);
  });
}

const UPLOAD_OVER_CAP_ERROR = `file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)}mb`;

const UPLOAD_FAILURE_REPLIES = {
  'over-cap': { status: 413, error: UPLOAD_OVER_CAP_ERROR },
  'write-failed': { status: 500, error: 'could not store the upload' },
  aborted: { status: 400, error: 'upload failed' },
} as const;

function receiveUpload({ req, res, sess, dir, filename, savedPath, logger }: {
  req: Request;
  res: Response;
  sess: Session;
  dir: string;
  filename: string;
  savedPath: string;
  logger: Pick<Console, 'warn'>;
}): void {
  const answer = (status: number, body: Record<string, unknown>) => {
    if (!res.headersSent) res.status(status).json(body);
  };
  void streamRequestToFile({ req, savedPath, capBytes: MAX_UPLOAD_BYTES }).then((outcome) => {
    if (!outcome.ok) {
      logger.warn(`[upload] session ${sess.id} refused: ${outcome.reason} after ${outcome.bytesReceived} bytes`);
      const failure = UPLOAD_FAILURE_REPLIES[outcome.reason];
      answer(failure.status, { error: failure.error });
      return;
    }
    if (!sess.hasLivePty) {
      logger.warn(`[upload] session ${sess.id} refused: session has no live terminal, after ${outcome.sizeBytes} bytes`);
      answer(409, { error: 'session has no live terminal' });
      fsp.unlink(savedPath).catch(() => {});
      return;
    }
    sess.write(framePathPaste(savedPath));
    sess.noteOperatorDraft();
    answer(200, { ok: true, path: savedPath });
    void sweepSessionUploads(dir, filename);
  });
}

function decodeHeaderText(header: unknown): string | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return null;
  }
}

function declaredContentLength(req: Request): number | null {
  const declared = Number(req.headers['content-length']);
  return Number.isFinite(declared) && declared >= 0 ? declared : null;
}

function sendShowReply({ res, logger }: { res: Response; logger: Pick<Console, 'warn'> }, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  const checked = checkAgentReply('show', { status, body });
  if (!checked.ok) logger.warn(`[agent-api] show reply broke its contract: ${checked.issue}`);
  res.status(checked.reply.status).json(checked.reply.body);
}

function answerShow({ req, res, session, shownFiles, logger }: {
  req: Request;
  res: Response;
  session: Session;
  shownFiles: ShownFilesPort;
  logger: Pick<Console, 'warn'>;
}): void {
  const answer = (status: number, body: Record<string, unknown>) => sendShowReply({ res, logger }, status, body);
  const name = path.basename(decodeHeaderText(req.headers['x-glimmervoid-show-name']) ?? '');
  if (!name) {
    answer(400, { ok: false, error: 'show needs the file name in x-glimmervoid-show-name' });
    return;
  }
  const caption = decodeHeaderText(req.headers['x-glimmervoid-show-caption'])?.slice(0, SHOWN_CAPTION_MAX_CHARS) ?? null;
  const declaredBytes = declaredContentLength(req);
  if (declaredBytes !== null && declaredBytes > SHOWN_FILE_CAP_BYTES) {
    answer(413, { ok: false, error: describeOverCap(name, declaredBytes) });
    req.resume();
    return;
  }
  void shownFiles.reserveIncomingPath(session.id).then(async (incomingPath) => {
    const outcome = await streamRequestToFile({ req, savedPath: incomingPath, capBytes: SHOWN_FILE_CAP_BYTES });
    if (!outcome.ok) {
      const failure = UPLOAD_FAILURE_REPLIES[outcome.reason];
      answer(failure.status, { ok: false, error: outcome.reason === 'over-cap' ? describeOverCap(name, declaredBytes) : failure.error });
      return;
    }
    const admitted = await shownFiles.admit(session, { incomingPath, name, caption, sizeBytes: outcome.sizeBytes });
    if (!admitted.ok) {
      answer(admitted.status, { ok: false, error: admitted.error });
      return;
    }
    answer(200, { ok: true, shown: { name: admitted.file.name, kind: admitted.file.kind } });
  }).catch(() => {
    answer(500, { ok: false, error: 'could not store the file' });
  });
}

const SHOWN_FILE_SANDBOX_POLICY = 'sandbox allow-scripts allow-popups allow-modals allow-forms';

async function* withZoomBridgeAppended(pageChunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  yield* pageChunks;
  yield SHOWN_PAGE_ZOOM_BRIDGE;
}

async function readPageTail(servable: ServableShownFile): Promise<string> {
  const handle = await fsp.open(servable.path, 'r');
  try {
    const tailStart = Math.max(0, servable.sizeBytes - SHOWN_SNIFF_BYTES);
    const tailBuffer = Buffer.alloc(servable.sizeBytes - tailStart);
    const { bytesRead } = await handle.read(tailBuffer, 0, tailBuffer.byteLength, tailStart);
    return tailBuffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

function streamPage(res: Response, servable: ServableShownFile, pageTail: string): void {
  res.setHeader('Content-Type', servable.mime);
  if (leavesVisibleRawTextOpen(pageTail)) {
    res.setHeader('Content-Length', String(servable.sizeBytes));
    pipeline(fs.createReadStream(servable.path), res, () => {});
    return;
  }
  res.setHeader('Content-Length', String(servable.sizeBytes + SHOWN_PAGE_ZOOM_BRIDGE.byteLength));
  pipeline(fs.createReadStream(servable.path), withZoomBridgeAppended, res, () => {});
}

function servePageWithZoomBridge(res: Response, servable: ServableShownFile): void {
  readPageTail(servable)
    .then((pageTail) => streamPage(res, servable, pageTail))
    .catch(() => {
      if (!res.headersSent) res.status(404).end();
    });
}

function serveShownFile(req: Request, res: Response, shownFiles: ShownFilesPort | null): void {
  const servable = shownFiles?.findServable(req.params.sessionId, req.params.filename) ?? null;
  if (!servable) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Security-Policy', SHOWN_FILE_SANDBOX_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  if (isShownPageMime(servable.mime)) {
    servePageWithZoomBridge(res, servable);
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  const byteRange = decideByteRange(req.headers.range, servable.sizeBytes);
  if (byteRange.kind === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${servable.sizeBytes}`);
    res.end();
    return;
  }
  res.setHeader('Content-Type', servable.mime);
  if (byteRange.kind === 'partial') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${byteRange.start}-${byteRange.end}/${servable.sizeBytes}`);
    res.setHeader('Content-Length', String(byteRange.end - byteRange.start + 1));
    pipeline(fs.createReadStream(servable.path, { start: byteRange.start, end: byteRange.end }), res, () => {});
    return;
  }
  res.setHeader('Content-Length', String(servable.sizeBytes));
  pipeline(fs.createReadStream(servable.path), res, () => {});
}

function refuseAgentRequest(res: Response): void {
  res.status(REFUSAL_STATUS).json({ ok: false, error: REFUSAL_REASON });
}

function answerAgentVerb({ res, agentApi, session, verb, payload }: {
  res: Response;
  agentApi: AgentApiPort;
  session: Session;
  verb: string;
  payload: Record<string, unknown>;
}): void {
  void agentApi.handle(session, verb, payload).then(
    (reply) => { res.status(reply.status).json(reply.body); },
    () => { res.status(500).json({ ok: false, error: 'could not answer the request' }); },
  );
}

const HOST_OPEN_FAILURE_STATUS = { 'unsupported-platform': 501, 'spawn-failed': 502 } as const;

function answerOpenExternal({ req, res, remoteListenerPort, listenerPortsFor, tokenMatches, openUrlOnHost, logger }: {
  req: Request;
  res: Response;
  remoteListenerPort: number | null;
  listenerPortsFor: BackendHttpDependencies['listenerPortsFor'];
  tokenMatches: (presented: unknown) => boolean;
  openUrlOnHost: HostUrlOpener;
  logger: Pick<Console, 'warn'>;
}): void {
  void readCappedBody(req, OPEN_EXTERNAL_BODY_CAP_BYTES, () => {}).then(async (body) => {
    if (body === null) return;
    const verdict = decideOpenExternalRequest({
      isLoopback: isLoopbackRequest(req),
      trust: classifyRequestOrigin({ localPort: req.socket.localPort, remoteListenerPort }),
      origin: req.headers.origin,
      listenerPorts: listenerPortsFor(req.socket),
      tokenOk: tokenMatches(req.headers['x-glimmervoid-page-token']),
      requestedUrl: parseJsonBody(body).url,
    });
    if (!verdict.ok) {
      res.status(verdict.status).json({ ok: false, error: verdict.error });
      return;
    }
    const outcome = await openUrlOnHost(verdict.url);
    if (outcome === 'opened') {
      res.status(204).end();
      return;
    }
    logger.warn(`[open-external] could not open a link on the host: ${outcome}`);
    res.status(HOST_OPEN_FAILURE_STATUS[outcome]).json({ ok: false, error: outcome });
  });
}

type AgentIngressDependencies = Pick<BackendHttpDependencies,
  'allowedHosts' | 'hookRouter' | 'getSession' | 'getUsage' | 'getPlanReview' | 'refocusContextFor' | 'takePromptSupervision' | 'getAgentApi' | 'getShownFiles' | 'sshSigner' | 'recordOutcome' | 'logger'>;

function mountHostAllowList(app: Express, allowedHosts: string[]): void {
  app.use((req, res, next) => {
    if (decideHostAllowed(req.headers.host, allowedHosts)) {
      next();
      return;
    }
    res.status(403).type('text/plain').send('Host not allowed');
  });
}

function mountAgentIngressRoutes(app: Express, dependencies: AgentIngressDependencies): void {
  const {
    hookRouter,
    getSession,
    getUsage,
    getPlanReview = () => null,
    refocusContextFor = () => ({ taskTitle: null, latestPlanTitle: null }),
    takePromptSupervision = () => null,
    getAgentApi = () => null,
    getShownFiles = () => null,
    recordOutcome = () => {},
    logger = console,
  } = dependencies;

  function toolHookHintReply(glimmervoidId: string, event: string, payload: Record<string, unknown>): ToolHookContextResponse | null {
    const session = getSession(glimmervoidId);
    const agentApi = getAgentApi();
    if (!session || !agentApi) return null;
    const hint = session.takeCommandHint(event, payload, (command) => agentApi.refuseRole(session, command) === null);
    return hint === null ? null : toolHookContextReplyOf(hint);
  }

  app.post('/hook/:glimmervoidId/:event', (req, res) => {
    if (!isLoopbackRequest(req)) {
      recordOutcome('hookRejectedNonLoopback');
      res.status(403).end();
      return;
    }
    const bodyCapBytes = hookBodyCapBytes(req.params.event, getPlanReview());
    const hookEventName = knownHookEventName(req.params.event);
    const overCap = (declaredBytes: string) => {
      if (SILENT_OVERSIZE_HOOK_EVENTS.has(hookEventName)) return;
      logger.warn(`[hook] ${hookEventName} body of ${declaredBytes} bytes is over the ${bodyCapBytes} byte cap and was refused`);
    };
    void readCappedBody(req, bodyCapBytes, overCap).then(async (body) => {
      if (body === null) return;
      const token = presentedToken(req);
      const parsedPayload = parseJsonBody(body);
      const payload = hookRouter.enrich
        ? await hookRouter.enrich({ glimmervoidId: req.params.glimmervoidId, event: req.params.event, token, payload: parsedPayload })
        : parsedPayload;
      const output = hookRouter.handle({
        glimmervoidId: req.params.glimmervoidId,
        event: req.params.event,
        token,
        payload,
      });
      if (output.status === 200 && isStatuslineEvent(req.params.event)) {
        getUsage().ingestStatusline(payload);
      }
      const refocusReply = refocusReplyFor({
        accepted: output.status === 200,
        event: req.params.event,
        payload,
        readContext: () => refocusContextFor(req.params.glimmervoidId),
        takePromptSupervision: () => takePromptSupervision(req.params.glimmervoidId),
      });
      const toolHint = output.status === 200 ? toolHookHintReply(req.params.glimmervoidId, req.params.event, payload) : null;
      const reply: Record<string, unknown> = { ok: output.status === 200, reason: output.reason, ...refocusReply, ...toolHint };
      const answer = (decision: Record<string, unknown> | null) => {
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        res.status(output.status).json(decision ? { ...reply, ...decision } : reply);
      };
      const abandonedByClaudeCode = new AbortController();
      const planDecision = getPlanReview()?.onHookEvent({
        glimmervoidId: req.params.glimmervoidId,
        event: req.params.event,
        payload,
        accepted: output.status === 200,
        signal: abandonedByClaudeCode.signal,
      }) || null;
      const isConversationPermission = output.status === 200 && req.params.event.toLowerCase() === CONVERSATION_PERMISSION_HOOK_EVENT;
      const heldDecision = planDecision
        || (isConversationPermission ? getSession(req.params.glimmervoidId)?.holdClaudePermission(payload, abandonedByClaudeCode.signal) ?? null : null);
      if (!heldDecision) {
        answer(null);
        return;
      }
      res.on('close', () => {
        if (res.writableFinished) return;
        abandonedByClaudeCode.abort();
      });
      heldDecision.then(answer, () => { answer(null); });
    });
  });

  app.post('/agent/:glimmervoidId/show', (req, res) => {
    const agentApi = getAgentApi();
    const shownFiles = getShownFiles();
    const session = getSession(req.params.glimmervoidId);
    const verdict = decideAgentRequest({
      sessionId: req.params.glimmervoidId,
      presentedToken: presentedToken(req),
      expectedToken: session?.agentToken ?? null,
      isLoopback: isLoopbackRequest(req),
    });
    if (!verdict.ok || !session || !agentApi || !shownFiles) {
      req.resume();
      refuseAgentRequest(res);
      return;
    }
    const roleRefusal = agentApi.refuseRole(session, 'show');
    if (roleRefusal) {
      req.resume();
      sendShowReply({ res, logger }, roleRefusal.status, roleRefusal.body);
      return;
    }
    session.noteCommandRan('show');
    answerShow({ req, res, session, shownFiles, logger });
  });

  app.post('/agent/:glimmervoidId/:verb', (req, res) => {
    const agentApi = getAgentApi();
    const session = getSession(req.params.glimmervoidId);
    const verb = req.params.verb;
    const verdict = decideAgentRequest({
      sessionId: req.params.glimmervoidId,
      presentedToken: presentedToken(req),
      expectedToken: session?.agentToken ?? null,
      isLoopback: isLoopbackRequest(req),
    });
    const bodyCapBytes = AGENT_BODY_CAP_BYTES_BY_VERB[verb] ?? HOOK_BODY_CAP_BYTES;
    const overCap = (declaredBytes: string) => {
      logger.warn(`[agent] a ${declaredBytes} byte body is over the ${bodyCapBytes} byte cap and was refused`);
      if (res.headersSent || req.destroyed) return;
      if (!verdict.ok || !session) {
        refuseAgentRequest(res);
        return;
      }
      res.status(413).json({ ok: false, error: `a ${verb} request carries at most ${bodyCapBytes} bytes, so nothing changed` });
    };
    void readCappedBody(req, bodyCapBytes, overCap, { drainBytes: AGENT_OVERSIZE_DRAIN_BYTES }).then((body) => {
      if (body === null) return;
      if (!verdict.ok || !session) {
        refuseAgentRequest(res);
        return;
      }
      if (!agentApi) { refuseAgentRequest(res); return; }
      answerAgentVerb({ res, agentApi, session, verb, payload: parseJsonBody(body) });
    });
  });
}

function mountCommitSigningRoute(app: Express, { getSession, sshSigner, logger }: {
  getSession: (id: string) => Session | null;
  sshSigner: Pick<SshSigner, 'signWithAgent'> | null;
  logger: Pick<Console, 'warn'>;
}): void {
  app.post('/sign/:glimmervoidId', (req, res) => {
    const session = getSession(req.params.glimmervoidId);
    const verdict = decideAgentRequest({
      sessionId: req.params.glimmervoidId,
      presentedToken: presentedToken(req),
      expectedToken: session?.commitSigningToken ?? null,
      isLoopback: isLoopbackRequest(req),
    });
    const overCap = (declaredBytes: string) => {
      logger.warn(`[sign] a ${declaredBytes} byte body is over the ${SSH_SIGN_BODY_CAP_BYTES} byte cap and was refused`);
    };
    void readCappedBody(req, SSH_SIGN_BODY_CAP_BYTES, overCap).then(async (body) => {
      if (body === null) return;
      if (!verdict.ok || !session || !sshSigner) {
        refuseAgentRequest(res);
        return;
      }
      const request = SshSignRequest.safeParse(parseJsonBody(body));
      const publicKey = request.success ? parseSshPublicKey(request.data.publicKey) : null;
      if (!request.success || !publicKey) {
        res.status(400).json({ ok: false, error: request.success ? 'publicKey is not an ssh public key' : request.error.issues[0]?.message ?? 'invalid request' });
        return;
      }
      const payload = Buffer.from(request.data.payload, 'base64');
      if (!isSignableGitObject(payload)) {
        res.status(400).json({ ok: false, error: 'only a git commit or tag object can be signed' });
        return;
      }
      const outcome = await sshSigner.signWithAgent({ publicKey, namespace: request.data.namespace, payload })
        .catch((error: unknown) => ({ ok: false as const, error: `could not sign: ${errorMessage(error)}` }));
      res.status(outcome.ok ? 200 : 503).json(outcome);
    });
  });
}

function createAgentIngressApp(dependencies: AgentIngressDependencies): Express {
  const app = express();
  mountHostAllowList(app, dependencies.allowedHosts);
  mountAgentIngressRoutes(app, dependencies);
  mountCommitSigningRoute(app, { getSession: dependencies.getSession, sshSigner: dependencies.sshSigner ?? null, logger: dependencies.logger ?? console });
  return app;
}

function createBackendHttpApp(dependencies: BackendHttpDependencies): Express {
  const {
    staticDir,
    customSoundsDir = resolveCustomSoundsDir(glimmervoidHomeDir()),
    configStore,
    remote,
    remoteAuth,
    allowedHosts,
    listenerPortsFor,
    pageToken,
    remoteListenerPort = null,
    tokenMatches = () => false,
    openUrlOnHost = async () => 'unsupported-platform',
    getSession,
    logger = console,
  } = dependencies;
  const app = express();

  mountHostAllowList(app, allowedHosts);

  if (remoteAuth) {
    app.use(remoteAuth.httpMiddleware);
    remoteAuth.mountPairRoutes(app);
  }

  app.get('/control-token', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !decideOriginAllowed(origin, remote.allowedOrigins, { listenerPorts: listenerPortsFor(req.socket) })) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: pageToken });
  });

  app.post('/open-external', (req, res) => {
    answerOpenExternal({ req, res, remoteListenerPort, listenerPortsFor, tokenMatches, openUrlOnHost, logger });
  });

  mountAgentIngressRoutes(app, dependencies);

  const uploadsRoot = configSiblingPath(configStore.configPath, 'uploads');
  app.post('/upload/:sessionId', (req, res) => {
    const declaredBytes = declaredContentLength(req);
    const refuse = (sessionLabel: string, status: number, error: string) => {
      logger.warn(`[upload] session ${sessionLabel} refused: ${error}, declared ${declaredBytes ?? 'unknown'} bytes`);
      res.status(status).json({ error });
    };
    const sess = getSession(req.params.sessionId);
    if (!sess || !isSafePathSegment(sess.id)) {
      refuse(JSON.stringify(req.params.sessionId), 404, 'unknown session');
      return;
    }
    const typeVerdict = decideUploadType(req.headers['content-type'], req.headers['x-glimmervoid-upload-name']);
    if (!typeVerdict.ok) {
      refuse(sess.id, typeVerdict.status, typeVerdict.error);
      return;
    }
    if (!sess.hasLivePty) {
      refuse(sess.id, 409, 'session has no live terminal');
      return;
    }
    if (declaredBytes !== null && exceedsUploadCap(declaredBytes)) {
      refuse(sess.id, 413, UPLOAD_OVER_CAP_ERROR);
      req.resume();
      return;
    }

    const dir = path.join(uploadsRoot, sess.id);
    const filename = buildUploadFilename({
      now: Date.now(),
      randomSuffix: crypto.randomBytes(4).toString('hex'),
      extension: typeVerdict.extension,
    });
    const savedPath = path.join(dir, filename);
    let abortedBeforeReceive = false;
    const markAbortedBeforeReceive = () => { abortedBeforeReceive = true; };
    req.on('error', markAbortedBeforeReceive);
    fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => {
        if (abortedBeforeReceive || req.destroyed) {
          logger.warn(`[upload] session ${sess.id} refused: aborted before any bytes`);
          return;
        }
        req.off('error', markAbortedBeforeReceive);
        receiveUpload({ req, res, sess, dir, filename, savedPath, logger });
      })
      .catch(() => {
        logger.warn(`[upload] session ${sess.id} refused: could not create ${dir}`);
        if (!res.headersSent) res.status(500).json({ error: 'could not store the upload' });
      });
  });

  app.get('/upload/:sessionId/:filename', (req, res) => {
    const { sessionId, filename } = req.params;
    const imageMime = imageMimeForUploadFilename(filename);
    if (!imageMime || !isSafePathSegment(sessionId)) {
      res.status(404).end();
      return;
    }
    const savedPath = path.join(uploadsRoot, sessionId, filename);
    fsp.lstat(savedPath)
      .then((savedStat) => {
        if (!savedStat.isFile()) {
          res.status(404).end();
          return;
        }
        res.setHeader('Content-Type', imageMime);
        res.setHeader('Content-Length', String(savedStat.size));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
        pipeline(fs.createReadStream(savedPath), res, () => {});
      })
      .catch(() => {
        if (!res.headersSent) res.status(404).end();
      });
  });

  app.get('/shown/:sessionId/:filename', (req, res) => {
    serveShownFile(req, res, dependencies.getShownFiles?.() ?? null);
  });

  mountCustomSoundRoutes(app, { soundsDir: customSoundsDir });

  if (staticDir === 'auto') {
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
      throw Object.assign(
        new Error('Dashboard build not found (dist/client). Run `npm run build` first, or use `npm run dev`.'),
        { glimmervoidBoot: true },
      );
    }
    serveClientDir(app, clientDir);
  }
  if (staticDir !== 'auto' && typeof staticDir === 'string') {
    serveClientDir(app, staticDir);
  }

  return app;
}

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

export { createAgentIngressApp, createBackendHttpApp };
export type { AgentIngressDependencies, BackendHttpDependencies };
