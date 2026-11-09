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
import { QUESTION_TOOL_HOLD_HOOK_EVENT } from '../../shared/contracts/question-manager.ts';
import { sparseBoardReply } from '../../shared/contracts/whiteboard.ts';
import type { Session } from '../../session/sessions.ts';
import { refocusReplyFor, toolHookContextReplyOf } from '../../session/core/refocus-core.ts';
import type { RefocusContext } from '../../session/core/refocus-core.ts';
import type { ToolHookContextResponse, UserPromptSubmitHookResponse } from '../../shared/contracts/refocus.ts';
import type { AgentApiPort } from '../agent-api-wiring.ts';
import type { PrFlowsWiring } from '../github/pr-flows-wiring.ts';
import { PR_ACTION_REPORT_BODY_CAP_BYTES, PR_ACTION_REPORT_ROUTE, PrActionReportBody } from '../../shared/contracts/pr-flows.ts';
import { mountAgentMcp } from '../../mcp/server.ts';
import { decideAgentRequest, REFUSAL_REASON, REFUSAL_STATUS } from '../core/agent-api-core.ts';
import { SSH_SIGN_BODY_CAP_BYTES, SshSignRequest } from '../../shared/contracts/session.ts';
import { WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { decideHostAllowed } from '../core/host-policy.ts';
import { errorMessage } from '../../shared/text.ts';
import { isSignableGitObject, parseSshPublicKey } from '../core/ssh-signing-core.ts';
import type { SshSigner } from '../ssh-signing.ts';
import { decideOpenExternalRequest, OPEN_EXTERNAL_BODY_CAP_BYTES } from '../core/open-external-core.ts';
import { offsetAfterPagePrelude } from '../core/shown-files-core.ts';
import { decideLinkPreviewRequest } from '../core/link-preview-core.ts';
import type { LinkPreviewFetcher } from '../link-preview-fetcher.ts';
import { decideOriginAllowed } from '../core/origin-policy.ts';
import { classifyRequestOrigin } from '../core/request-trust.ts';
import type { HostUrlOpener } from '../host-url-opener.ts';
import type { OutcomeRecorder } from '../../shared/outcome-names.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { decideByteRange, resolveCustomSoundsDir } from '../core/custom-sounds-core.ts';
import { mountCustomSoundRoutes } from '../custom-sounds-routes.ts';
import { configSiblingPath } from '../pairings-store.ts';
import { clientDir } from '../runtime-paths.ts';
import type { WhiteboardAssetStore } from '../whiteboard/whiteboard-assets.ts';
import type { WhiteboardLayouts } from '../whiteboard/whiteboard-wiring.ts';
import { ASSET_INPUT_CAP_BYTES } from '../whiteboard/whiteboard-assets.ts';
import { BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_GESTURE_MESSAGE, BOARD_PAGE_PARAMS_MESSAGE, BOARD_PAGE_THEME_MESSAGE, BOARD_PAGE_ZOOMED_MESSAGE, WHITEBOARD_ASSET_ROUTE } from '../../shared/contracts/whiteboard.ts';
import { buildUploadFilename, decideUploadType, exceedsUploadCap, imageMimeForUploadFilename, isSafePathSegment } from '../core/upload-core.ts';
import { declaredContentLength, decodeHeaderText, parseJsonBody, readCappedBody } from './http/backend-http-body.ts';
import { UPLOAD_FAILURE_REPLIES, UPLOAD_OVER_CAP_ERROR, receiveUpload, streamRequestToFile } from './http/backend-http-uploads.ts';
import { servePackFile } from './http/backend-http-pack-files.ts';
import type { PackFileSource } from './http/backend-http-pack-files.ts';
import { serveClientDir } from './http/backend-http-static.ts';

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
  remoteListenerPort?: () => number | null;
  tokenMatches?: (presented: unknown) => boolean;
  openUrlOnHost?: HostUrlOpener;
  isLinkPreviewEnabled?: () => boolean;
  fetchLinkPreview?: LinkPreviewFetcher;
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
  getPackFile?: PackFileSource;
  getWhiteboardAssets?: () => WhiteboardAssetStore | null;
  getWhiteboardLayouts?: () => WhiteboardLayouts | null;
  getPrActionReports?: () => Pick<PrFlowsWiring, 'acceptPrActionReport'> | null;
  sshSigner?: Pick<SshSigner, 'signWithAgent'> | null;
  recordOutcome?: OutcomeRecorder;
  logger?: Pick<Console, 'warn'>;
}

function isStatuslineEvent(event: unknown): boolean {
  return String(event || '').toLowerCase() === 'statusline';
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
    (reply) => { res.status(reply.status).json(sparseBoardReply(reply.body)); },
    () => { res.status(500).json({ ok: false, error: 'could not answer the request' }); },
  );
}

const HOST_OPEN_FAILURE_STATUS = { 'unsupported-platform': 501, 'spawn-failed': 502 } as const;

function answerOpenExternal({ req, res, remoteListenerPort, listenerPortsFor, tokenMatches, openUrlOnHost, logger }: {
  req: Request;
  res: Response;
  remoteListenerPort: () => number | null;
  listenerPortsFor: BackendHttpDependencies['listenerPortsFor'];
  tokenMatches: (presented: unknown) => boolean;
  openUrlOnHost: HostUrlOpener;
  logger: Pick<Console, 'warn'>;
}): void {
  void readCappedBody(req, OPEN_EXTERNAL_BODY_CAP_BYTES, () => {}).then(async (body) => {
    if (body === null) return;
    const verdict = decideOpenExternalRequest({
      isLoopback: isLoopbackRequest(req),
      trust: classifyRequestOrigin({ localPort: req.socket.localPort, remoteListenerPort: remoteListenerPort() }),
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

function answerLinkPreview({ req, res, remoteListenerPort, listenerPortsFor, tokenMatches, isLinkPreviewEnabled, fetchLinkPreview }: {
  req: Request;
  res: Response;
  remoteListenerPort: () => number | null;
  listenerPortsFor: BackendHttpDependencies['listenerPortsFor'];
  tokenMatches: (presented: unknown) => boolean;
  isLinkPreviewEnabled: () => boolean;
  fetchLinkPreview: LinkPreviewFetcher;
}): void {
  void readCappedBody(req, OPEN_EXTERNAL_BODY_CAP_BYTES, () => {}).then(async (body) => {
    if (body === null) return;
    const verdict = decideLinkPreviewRequest({
      isLoopback: isLoopbackRequest(req),
      trust: classifyRequestOrigin({ localPort: req.socket.localPort, remoteListenerPort: remoteListenerPort() }),
      origin: req.headers.origin,
      listenerPorts: listenerPortsFor(req.socket),
      tokenOk: tokenMatches(req.headers['x-glimmervoid-page-token']),
      requestedUrl: parseJsonBody(body).url,
      isEnabled: isLinkPreviewEnabled(),
    });
    if (!verdict.ok) {
      res.status(verdict.status).json({ ok: false, error: verdict.error });
      return;
    }
    const preview = await fetchLinkPreview(verdict.url);
    res.setHeader('Cache-Control', 'no-store');
    res.json(preview);
  });
}

type AgentIngressDependencies = Pick<BackendHttpDependencies,
  'allowedHosts' | 'hookRouter' | 'getSession' | 'getUsage' | 'getPlanReview' | 'refocusContextFor' | 'takePromptSupervision' | 'getAgentApi' | 'getWhiteboardAssets' | 'getWhiteboardLayouts' | 'getPrActionReports' | 'sshSigner' | 'recordOutcome' | 'logger'>;

const BOARD_PAGE_SANDBOX_POLICY = 'sandbox allow-scripts allow-popups allow-modals allow-forms';
const BOARD_MEDIA_SANDBOX_POLICY = "default-src 'none'; sandbox";
const DASHBOARD_FRAME_POLICY = "frame-src 'self' blob: data:";
const BOARD_PAGE_INPUT_REPORTER = Buffer.from(`<script>(function(later,dashboard,root){
var gestureType=${JSON.stringify(BOARD_PAGE_GESTURE_MESSAGE)},zoomState="fit",pinch=null,press=null,mouseDrag=null,lastTap=null,lastTouchAt=0;
function post(gesture){gesture.type=gestureType;dashboard.postMessage(gesture,"*")}
function fingers(touches){var a=touches[0],b=touches[1];return{distance:Math.hypot(a.screenX-b.screenX,a.screenY-b.screenY),screenX:(a.screenX+b.screenX)/2,screenY:(a.screenY+b.screenY)/2,centerX:(a.clientX+b.clientX)/2,centerY:(a.clientY+b.clientY)/2}}
function holdTouches(){root.style.touchAction=zoomState==="zoomed"?"none":"pan-x pan-y"}
holdTouches();
addEventListener("keydown",function(event){if(event.key==="Escape")later(function(){if(!event.defaultPrevented)dashboard.postMessage(${JSON.stringify(BOARD_PAGE_ESCAPE_MESSAGE)},"*")})},true);
addEventListener("message",function(event){var data=event.data;if(event.source!==dashboard||!data||data.type!==${JSON.stringify(BOARD_PAGE_ZOOMED_MESSAGE)})return;zoomState=data.isZoomed===true?"zoomed":"fit";holdTouches()});
addEventListener("touchstart",function(event){lastTouchAt=Date.now();if(event.touches.length===2){pinch=fingers(event.touches);press=null;return}if(event.touches.length!==1)return;var touch=event.touches[0];press={screenX:touch.screenX,screenY:touch.screenY,clientX:touch.clientX,clientY:touch.clientY,startX:touch.screenX,startY:touch.screenY,travel:0}},{capture:true,passive:true});
addEventListener("touchmove",function(event){if(event.touches.length===2&&pinch){event.preventDefault();var next=fingers(event.touches);if(pinch.distance>0&&next.distance>0)post({gesture:"pinch",centerX:next.centerX,centerY:next.centerY,scaleFactor:next.distance/pinch.distance});post({gesture:"pan",deltaX:next.screenX-pinch.screenX,deltaY:next.screenY-pinch.screenY});pinch=next;return}if(event.touches.length!==1||!press)return;var touch=event.touches[0];press.travel=Math.max(press.travel,Math.hypot(touch.screenX-press.startX,touch.screenY-press.startY));if(zoomState!=="zoomed")return;event.preventDefault();post({gesture:"pan",deltaX:touch.screenX-press.screenX,deltaY:touch.screenY-press.screenY});press.screenX=touch.screenX;press.screenY=touch.screenY},{capture:true,passive:false});
addEventListener("touchend",function(event){lastTouchAt=Date.now();if(event.touches.length<2)pinch=null;if(event.touches.length!==0||!press)return;var tapped=press;press=null;if(tapped.travel>6)return;var now=Date.now();if(lastTap&&now-lastTap.at<300&&Math.hypot(tapped.clientX-lastTap.clientX,tapped.clientY-lastTap.clientY)<30){lastTap=null;post({gesture:"doubleTap",centerX:tapped.clientX,centerY:tapped.clientY});return}lastTap={at:now,clientX:tapped.clientX,clientY:tapped.clientY}},true);
addEventListener("touchcancel",function(){pinch=null;press=null},true);
addEventListener("gesturestart",function(event){event.preventDefault()},true);
addEventListener("mousedown",function(event){if(event.button!==0||zoomState!=="zoomed"||Date.now()-lastTouchAt<800)return;event.preventDefault();mouseDrag={screenX:event.screenX,screenY:event.screenY}},true);
addEventListener("mousemove",function(event){if(!mouseDrag)return;if((event.buttons&1)===0||zoomState!=="zoomed"){mouseDrag=null;return}event.preventDefault();post({gesture:"pan",deltaX:event.screenX-mouseDrag.screenX,deltaY:event.screenY-mouseDrag.screenY});mouseDrag={screenX:event.screenX,screenY:event.screenY}},true);
addEventListener("mouseup",function(){mouseDrag=null},true);
addEventListener("dblclick",function(event){if(Date.now()-lastTouchAt<800)return;post({gesture:"doubleTap",centerX:event.clientX,centerY:event.clientY})},true);
addEventListener("wheel",function(event){var isZoom=event.ctrlKey||event.metaKey;if(!isZoom&&zoomState!=="zoomed")return;event.preventDefault();post({gesture:"wheel",centerX:event.clientX,centerY:event.clientY,deltaX:event.deltaX,deltaY:event.deltaY,isZoom:isZoom})},{capture:true,passive:false});
})(setTimeout,parent,document.documentElement)</script>`.replaceAll('\n', ''));
const BOARD_PAGE_BASE_STYLE = Buffer.from('<style>:where(html){color-scheme:light dark;background:var(--glimmervoid-background,#15131b);color:var(--glimmervoid-text,#e8e5ef);font:16px/1.5 system-ui,sans-serif}:where(body){margin:0;padding:24px}:where(a){color:var(--glimmervoid-accent,#a78bfa)}:where(h1,h2,h3,h4){line-height:1.2;margin:0 0 .5em}:where(button,input,select,textarea){font:inherit;color:inherit}:where(button){background:var(--glimmervoid-accent,#a78bfa);color:var(--glimmervoid-background,#15131b);border:0;border-radius:6px;padding:6px 14px;cursor:pointer}:where(input,select,textarea){background:transparent;border:1px solid var(--glimmervoid-line,#3b3549);border-radius:6px;padding:4px 8px}:where(hr){border:0;border-top:1px solid var(--glimmervoid-line,#3b3549)}:where(code,pre){font-family:ui-monospace,monospace}</style>');
const BOARD_PAGE_PARAMS_BRIDGE = Buffer.from(`<script>(function(root,dashboard){addEventListener("message",function(event){var data=event.data;if(event.source!==dashboard||!data)return;if(data.type===${JSON.stringify(BOARD_PAGE_THEME_MESSAGE)}){for(var name in data.colors)root.style.setProperty("--glimmervoid-"+name,data.colors[name]);return}if(data.type===${JSON.stringify(BOARD_PAGE_PARAMS_MESSAGE)}){window.glimmervoidParams=data.values;dispatchEvent(new CustomEvent("glimmervoid:params",{detail:data.values}))}})})(document.documentElement,parent)</script>`);
async function pagePreludeOffsetOf(pagePath: string): Promise<number> {
  const page = await fsp.open(pagePath, 'r');
  try {
    return await offsetAfterPagePrelude(async (position, byteCount) => {
      const window = Buffer.alloc(byteCount);
      const { bytesRead } = await page.read(window, 0, byteCount, position);
      return window.subarray(0, bytesRead);
    });
  } finally {
    await page.close().catch(() => {});
  }
}

function sendBoardAssetBytes(req: Request, res: Response, servable: { path: string; contentType: string }, sizeBytes: number): void {
  res.setHeader('Content-Security-Policy', BOARD_MEDIA_SANDBOX_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  const byteRange = decideByteRange(req.headers.range, sizeBytes);
  if (byteRange.kind === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${sizeBytes}`);
    res.end();
    return;
  }
  res.setHeader('Content-Type', servable.contentType);
  if (byteRange.kind === 'partial') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${byteRange.start}-${byteRange.end}/${sizeBytes}`);
    res.setHeader('Content-Length', String(byteRange.end - byteRange.start + 1));
    pipeline(fs.createReadStream(servable.path, { start: byteRange.start, end: byteRange.end }), res, () => {});
    return;
  }
  res.setHeader('Content-Length', String(sizeBytes));
  pipeline(fs.createReadStream(servable.path), res, () => {});
}

const BOARD_PAGE_INJECTIONS = [BOARD_PAGE_BASE_STYLE, BOARD_PAGE_PARAMS_BRIDGE, BOARD_PAGE_INPUT_REPORTER];
const BOARD_PAGE_INJECTED_BYTES = BOARD_PAGE_INJECTIONS.reduce((total, injection) => total + injection.byteLength, 0);

function sendBoardPage(res: Response, servable: { path: string; contentType: string }, sizeBytes: number, preludeOffset: number): void {
  res.setHeader('Content-Security-Policy', BOARD_PAGE_SANDBOX_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', servable.contentType);
  res.setHeader('Content-Length', String(sizeBytes + BOARD_PAGE_INJECTED_BYTES));
  pipeline(async function* pageWithInjectionsAfterPrelude() {
    if (preludeOffset > 0) yield* fs.createReadStream(servable.path, { end: preludeOffset - 1 });
    yield* BOARD_PAGE_INJECTIONS;
    yield* fs.createReadStream(servable.path, { start: preludeOffset });
  }, res, () => {});
}

function isPage(servable: { contentType: string }): boolean {
  return servable.contentType.startsWith('text/html');
}

function serveBoardAsset(req: Request, res: Response, servable: { path: string; contentType: string }): void {
  const answerMissing = () => {
    if (!res.headersSent) res.status(404).end();
  };
  if (!isPage(servable)) {
    fsp.stat(servable.path).then((stats) => sendBoardAssetBytes(req, res, servable, stats.size), answerMissing);
    return;
  }
  Promise.all([fsp.stat(servable.path), pagePreludeOffsetOf(servable.path)]).then(([stats, preludeOffset]) => sendBoardPage(res, servable, stats.size, preludeOffset), answerMissing);
}

async function receiveBoardMedia({ req, assets, name }: { req: Request; assets: WhiteboardAssetStore; name: string }): ReturnType<WhiteboardAssetStore['adoptIncoming']> {
  const declaredBytes = declaredContentLength(req);
  const overCap = { ok: false as const, status: 413, error: `${name} is larger than the ${ASSET_INPUT_CAP_BYTES / (1024 * 1024)} MB a board takes` };
  if (declaredBytes !== null && declaredBytes > ASSET_INPUT_CAP_BYTES) {
    req.resume();
    return overCap;
  }
  let isAbortedBeforeReceive = false;
  const markAbortedBeforeReceive = () => { isAbortedBeforeReceive = true; };
  req.on('error', markAbortedBeforeReceive);
  const incomingPath = await assets.reserveIncomingPath();
  req.off('error', markAbortedBeforeReceive);
  if (isAbortedBeforeReceive || req.destroyed) return { ok: false, ...UPLOAD_FAILURE_REPLIES.aborted };
  try {
    const received = await streamRequestToFile({ req, savedPath: incomingPath, capBytes: ASSET_INPUT_CAP_BYTES });
    if (!received.ok) return received.reason === 'over-cap' ? overCap : { ok: false, ...UPLOAD_FAILURE_REPLIES[received.reason] };
    return await assets.adoptIncoming(incomingPath, name);
  } finally {
    await fsp.rm(incomingPath, { force: true }).catch(() => {});
  }
}

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
    getWhiteboardAssets = () => null,
    getWhiteboardLayouts = () => null,
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
      const isQuestionToolHold = output.status === 200 && req.params.event.toLowerCase() === QUESTION_TOOL_HOLD_HOOK_EVENT;
      const heldDecision = planDecision
        || (isConversationPermission ? getSession(req.params.glimmervoidId)?.holdClaudePermission(payload, abandonedByClaudeCode.signal) ?? null : null)
        || (isQuestionToolHold ? getSession(req.params.glimmervoidId)?.holdQuestionTool(payload, abandonedByClaudeCode.signal) ?? null : null);
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

  mountAgentMcp(app, {
    getSession, getAgentApi, getWhiteboardAssets, getWhiteboardLayouts, isLoopback: isLoopbackRequest, logger,
    isOriginAllowed: (req) => decideOriginAllowed(req.headers.origin, [], { listenerPorts: req.socket.localPort ?? [] }),
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

const PR_ACTION_REPORT_ERRORS: Record<401 | 404 | 409, string> = {
  401: 'the token does not match this run',
  404: 'no PR action run has that id',
  409: 'this run already has a final outcome',
};

function mountPrActionReportRoute(app: Express, { getPrActionReports, remoteListenerPort, logger }: {
  getPrActionReports: () => Pick<PrFlowsWiring, 'acceptPrActionReport'> | null;
  remoteListenerPort: () => number | null;
  logger: Pick<Console, 'warn'>;
}): void {
  app.post(PR_ACTION_REPORT_ROUTE, (req, res) => {
    if (classifyRequestOrigin({ localPort: req.socket.localPort, remoteListenerPort: remoteListenerPort() }) === 'remote') {
      refuseAgentRequest(res);
      return;
    }
    const overCap = (declaredBytes: string) => {
      logger.warn(`[pr-action] a ${declaredBytes} byte report is over the ${PR_ACTION_REPORT_BODY_CAP_BYTES} byte cap and was refused`);
    };
    void readCappedBody(req, PR_ACTION_REPORT_BODY_CAP_BYTES, overCap).then(async (bodyText) => {
      if (bodyText === null) return;
      const reports = getPrActionReports();
      const token = presentedToken(req);
      if (!isLoopbackRequest(req) || !reports) {
        refuseAgentRequest(res);
        return;
      }
      if (token === null) {
        res.status(401).json({ ok: false, error: PR_ACTION_REPORT_ERRORS[401] });
        return;
      }
      const report = PrActionReportBody.safeParse(parseJsonBody(bodyText));
      if (!report.success) {
        res.status(400).json({ ok: false, error: report.error.issues[0]?.message ?? 'invalid report' });
        return;
      }
      const status = await reports.acceptPrActionReport(req.params.runId ?? '', token, report.data);
      if (status === 200) {
        res.status(200).json({ ok: true });
        return;
      }
      res.status(status).json({ ok: false, error: PR_ACTION_REPORT_ERRORS[status] });
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
    remoteListenerPort = () => null,
    tokenMatches = () => false,
    openUrlOnHost = async () => 'unsupported-platform',
    isLinkPreviewEnabled = () => false,
    fetchLinkPreview = async () => ({}),
    getSession,
    logger = console,
  } = dependencies;
  const app = express();

  mountHostAllowList(app, allowedHosts);
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', DASHBOARD_FRAME_POLICY);
    next();
  });

  app.get('/packs/:packName/:accessKey/files/*filePath', (req, res) => {
    servePackFile(req, res, dependencies.getPackFile ?? null);
  });

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

  app.post('/link-preview', (req, res) => {
    answerLinkPreview({ req, res, remoteListenerPort, listenerPortsFor, tokenMatches, isLinkPreviewEnabled, fetchLinkPreview });
  });

  mountPrActionReportRoute(app, { getPrActionReports: dependencies.getPrActionReports ?? (() => null), remoteListenerPort, logger });

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

  app.post(WHITEBOARD_ASSET_ROUTE, (req, res) => {
    const assets = dependencies.getWhiteboardAssets?.() ?? null;
    const name = path.basename(decodeHeaderText(req.headers['x-glimmervoid-upload-name']) ?? '');
    const answer = (status: number, body: Record<string, unknown>) => {
      if (!res.headersSent) res.status(status).json(body);
    };
    const origin = req.headers.origin;
    if (origin && !decideOriginAllowed(origin, remote.allowedOrigins, { listenerPorts: listenerPortsFor(req.socket) })) {
      answer(403, { ok: false, error: 'origin not allowed' });
      req.resume();
      return;
    }
    if (!name) {
      answer(400, { ok: false, error: 'board media needs its file name in x-glimmervoid-upload-name' });
      req.resume();
      return;
    }
    if (!assets) {
      answer(503, { ok: false, error: 'boards are not ready yet' });
      req.resume();
      return;
    }
    void receiveBoardMedia({ req, assets, name }).then(
      (outcome) => outcome.ok ? answer(200, { ok: true, media: outcome.media }) : answer(outcome.status, { ok: false, error: outcome.error }),
      () => answer(500, { ok: false, error: `${name} could not be stored` }),
    );
  });

  app.get(`${WHITEBOARD_ASSET_ROUTE}/:filename`, (req, res) => {
    const servable = dependencies.getWhiteboardAssets?.()?.servableOf(req.params.filename) ?? null;
    if (!servable) {
      res.status(404).end();
      return;
    }
    serveBoardAsset(req, res, servable);
  });

  mountCustomSoundRoutes(app, { soundsDir: customSoundsDir });

  if (staticDir === null) return app;
  const servedClientDir = staticDir === 'auto' ? clientDir : staticDir;
  serveClientDir(app, servedClientDir);
  if (staticDir !== 'auto') return app;
  if (fs.existsSync(path.join(clientDir, 'index.html'))) return app;
  const dashboardBuildMissingHint = 'Dashboard build not found (dist/client). Run `npm run build` first, or use `npm run dev`.';
  console.error(dashboardBuildMissingHint);
  app.get('/', (_req, res) => {
    res.status(503).type('text').send(dashboardBuildMissingHint);
  });

  return app;
}

export { createAgentIngressApp, createBackendHttpApp };
export type { AgentIngressDependencies, BackendHttpDependencies };
