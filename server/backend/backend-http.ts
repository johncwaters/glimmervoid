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
import { refocusReplyFor } from '../../session/core/refocus-core.ts';
import type { RefocusContext } from '../../session/core/refocus-core.ts';
import type { FactoryDispatchResult } from '../../shared/contracts/factory.ts';
import type { AgentApiPort } from '../agent-api-wiring.ts';
import { decideAgentRequest, isOrchestratorAgentVerb, REFUSAL_REASON, REFUSAL_STATUS } from '../core/agent-api-core.ts';
import { AgentTicketRequest, SSH_SIGN_BODY_CAP_BYTES, SshSignRequest } from '../../shared/contracts/session.ts';
import type { AgentTicketReply, OrchestratorAgentVerb, TicketAgentVerb } from '../../shared/contracts/session.ts';
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
import {
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  framePathPaste,
  imageMimeForUploadFilename,
  isSafePathSegment,
  planUploadRetention,
} from '../core/upload-core.ts';

const HOOK_BODY_CAP_BYTES = 64 * 1024;
const UNNAMED_HOOK_EVENT = 'an unknown event';
const SILENT_OVERSIZE_HOOK_EVENTS: ReadonlySet<string> = new Set(['posttooluse', CONVERSATION_TOOL_RESULT_HOOK_EVENT]);
const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  ...HOOK_EVENTS.map((event) => event.toLowerCase()),
  'pretooluse',
  'posttooluse',
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
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const abandon = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    req.on('error', abandon);
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      chunks.push(chunk);
      if (receivedBytes <= capBytes) return;
      onOversize(String(req.headers['content-length'] || `at least ${receivedBytes}`));
      req.destroy();
      abandon();
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function parseJsonBody(body: string): Record<string, unknown> {
  return parseJsonRecord(body, { admitArrays: true }) ?? {};
}

type TicketVerbHandler = (sessionId: string, request: AgentTicketRequest) => Promise<AgentTicketReply>;

interface FactoryAgentPort {
  getLiveOrchestrator: (sessionId: string) => { projectId: string; intentId: string } | null;
  dispatch: (sessionId: string, payload: Record<string, unknown>) => Promise<FactoryDispatchResult>;
  reopen?: TicketVerbHandler;
  cancel?: TicketVerbHandler;
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
  hookRouter: { handle: (input: Record<string, unknown>) => HookRouterOutput };
  getSession: (id: string) => Session | null;
  getUsage: () => { ingestStatusline: (payload: object) => void };
  getPlanReview?: () => PlanReviewHookPort | null;
  refocusContextFor?: (glimmervoidId: string) => RefocusContext;
  getFactory?: () => FactoryAgentPort | null;
  getAgentApi?: () => AgentApiPort | null;
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

function receiveUpload({ req, res, sess, dir, filename, savedPath }: {
  req: Request;
  res: Response;
  sess: Session;
  dir: string;
  filename: string;
  savedPath: string;
}): void {
  const writeStream = fs.createWriteStream(savedPath);
  let bytesReceived = 0;
  let settled = false;

  const answer = (status: number, body: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) res.status(status).json(body);
  };
  let discardWanted = false;
  let streamClosed = false;
  const unlinkPartial = () => {
    fsp.unlink(savedPath).catch(() => {});
  };
  const discardPartial = () => {
    discardWanted = true;
    if (streamClosed) unlinkPartial();
  };
  writeStream.on('close', () => {
    streamClosed = true;
    if (discardWanted) unlinkPartial();
  });
  writeStream.on('error', () => {
    answer(500, { error: 'could not store the upload' });
    discardPartial();
  });
  req.on('data', (chunk: Buffer) => {
    bytesReceived += chunk.length;
    if (!exceedsUploadCap(bytesReceived)) return;
    answer(413, { error: 'file is too large' });
    req.destroy();
    writeStream.destroy();
    discardPartial();
  });
  pipeline(req, writeStream, (error) => {
    if (error) {
      answer(400, { error: 'upload failed' });
      discardPartial();
      return;
    }
    if (settled) {
      discardPartial();
      return;
    }
    if (!sess.hasLivePty) {
      answer(409, { error: 'session has no live terminal' });
      discardPartial();
      return;
    }
    sess.write(framePathPaste(savedPath));
    answer(200, { ok: true, path: savedPath });
    void sweepSessionUploads(dir, filename);
  });
}

function refuseAgentRequest(res: Response): void {
  res.status(REFUSAL_STATUS).json({ ok: false, error: REFUSAL_REASON });
}

function answerTicketVerb({ res, factory, sessionId, verb, payload }: {
  res: Response;
  factory: FactoryAgentPort;
  sessionId: string;
  verb: TicketAgentVerb;
  payload: Record<string, unknown>;
}): void {
  const handler = factory[verb];
  if (!handler) {
    res.status(501).json({ ok: false, reason: `this Glimmervoid cannot ${verb} tickets` });
    return;
  }
  const request = AgentTicketRequest.safeParse(payload);
  if (!request.success) {
    res.status(400).json({ ok: false, reason: request.error.issues[0]?.message || 'invalid request' });
    return;
  }
  void handler(sessionId, request.data).then(
    (reply) => { res.status(200).json(reply); },
    () => { res.status(500).json({ ok: false, reason: `could not ${verb} the ticket` }); },
  );
}

function answerOrchestratorVerb({ res, factory, sessionId, verb, payload }: {
  res: Response;
  factory: FactoryAgentPort;
  sessionId: string;
  verb: OrchestratorAgentVerb;
  payload: Record<string, unknown>;
}): void {
  if (verb !== 'dispatch') {
    answerTicketVerb({ res, factory, sessionId, verb, payload });
    return;
  }
  void factory.dispatch(sessionId, payload).then(
    (reply) => { res.status(200).json(reply); },
    () => { res.status(500).json({ ok: false, reason: 'could not dispatch the ticket' }); },
  );
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
  'allowedHosts' | 'hookRouter' | 'getSession' | 'getUsage' | 'getPlanReview' | 'refocusContextFor' | 'getFactory' | 'getAgentApi' | 'sshSigner' | 'recordOutcome' | 'logger'>;

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
    getAgentApi = () => null,
    getFactory = () => null,
    recordOutcome = () => {},
    logger = console,
  } = dependencies;

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
    void readCappedBody(req, bodyCapBytes, overCap).then((body) => {
      if (body === null) return;
      const payload = parseJsonBody(body);
      const token = presentedToken(req);
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
      });
      const reply: Record<string, unknown> = { ok: output.status === 200, reason: output.reason, ...refocusReply };
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

  app.post('/agent/:glimmervoidId/:verb', (req, res) => {
    const agentApi = getAgentApi();
    const session = getSession(req.params.glimmervoidId);
    const factory = getFactory();
    const isOrchestrator = factory?.getLiveOrchestrator(req.params.glimmervoidId) != null;
    const verb = req.params.verb;
    const isOrchestratorVerb = isOrchestratorAgentVerb(verb);
    const verdict = decideAgentRequest({
      sessionId: req.params.glimmervoidId,
      presentedToken: presentedToken(req),
      expectedToken: session?.agentToken ?? null,
      isLoopback: isLoopbackRequest(req),
    });
    const overCap = (declaredBytes: string) => {
      logger.warn(`[agent] a ${declaredBytes} byte body is over the ${HOOK_BODY_CAP_BYTES} byte cap and was refused`);
    };
    void readCappedBody(req, HOOK_BODY_CAP_BYTES, overCap).then((body) => {
      if (body === null) return;
      if (!verdict.ok || !session) {
        refuseAgentRequest(res);
        return;
      }
      if (session.factoryRole === 'orchestrator' && !isOrchestratorVerb) {
        res.status(403).json({ ok: false, reason: 'only live factory orchestrators may dispatch, reopen or cancel, and they may do nothing else' });
        return;
      }
      if (isOrchestratorVerb !== isOrchestrator) {
        res.status(403).json({ ok: false, reason: 'only live factory orchestrators may dispatch, reopen or cancel, and they may do nothing else' });
        return;
      }
      if (isOrchestratorAgentVerb(verb) && factory) {
        answerOrchestratorVerb({ res, factory, sessionId: session.id, verb, payload: parseJsonBody(body) });
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
    const sess = getSession(req.params.sessionId);
    if (!sess || !isSafePathSegment(sess.id)) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    const typeVerdict = decideUploadType(req.headers['content-type'], req.headers['x-glimmervoid-upload-name']);
    if (!typeVerdict.ok) {
      res.status(typeVerdict.status).json({ error: typeVerdict.error });
      return;
    }
    if (!sess.hasLivePty) {
      res.status(409).json({ error: 'session has no live terminal' });
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
        if (abortedBeforeReceive || req.destroyed) return;
        req.off('error', markAbortedBeforeReceive);
        receiveUpload({ req, res, sess, dir, filename, savedPath });
      })
      .catch(() => {
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

  mountCustomSoundRoutes(app, { soundsDir: customSoundsDir });

  if (staticDir === 'auto') {
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
      throw Object.assign(
        new Error('Dashboard build not found (dist/client). Run `npm run build` first, or use `npm run dev`.'),
        { glimmervoidBoot: true },
      );
    }
    app.use(express.static(clientDir));
  }
  if (staticDir !== 'auto' && typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }

  return app;
}

export { createAgentIngressApp, createBackendHttpApp };
export type { AgentIngressDependencies, BackendHttpDependencies };
