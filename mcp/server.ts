import path from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Express, Request, Response } from 'express';

import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import { REFUSAL_REASON, REFUSAL_STATUS, decideAgentRequest } from '../server/core/agent-api-core.ts';
import type { WhiteboardAssetStore } from '../server/whiteboard/whiteboard-assets.ts';
import type { WhiteboardLayouts } from '../server/whiteboard/whiteboard-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { parsePresentedCredential } from './core/credentials.ts';
import { boardReplyWithoutCommandGuide, settingsListForMcp, spawnReplyForMcp } from './core/replies.ts';
import { SERVER_INSTRUCTIONS } from './core/instructions.ts';
import { boardPictureResult, boardReplyWithReading } from './whiteboard.ts';
import type { ToolImageResult } from './core/tool-result.ts';
import { toolErrorResult, toolResultFromReply } from './core/tool-result.ts';
import { GROUPED_TOOLS, allowedActionNames, combinedAnnotations, inputSchemaFor, routeToolCall } from './core/tools.ts';
import type { CallContext, GroupedTool, Presenter, ToolArguments } from './core/tools.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';

const MCP_ROUTE = '/mcp';
const SERVER_NAME = 'glimmervoid';
const TOOL_SURFACE_VERSION = '1';
const LOADS_UPFRONT_META_KEY = 'anthropic/alwaysLoad';

interface FileStores {
  getWhiteboardAssets(): WhiteboardAssetStore | null;
  getWhiteboardLayouts(): WhiteboardLayouts | null;
}

interface AgentMcpDependencies extends FileStores {
  getSession(id: string): Session | null;
  getAgentApi(): AgentApiPort | null;
  isLoopback(req: Request): boolean;
  isOriginAllowed(req: Request): boolean;
  logger: Pick<Console, 'warn'>;
}

type AgentReply = { status: number; body: Record<string, unknown> };

type AuthenticatedRequest = Request & { auth?: { token: string; clientId: string; scopes: string[] } };

function refuse(res: Response): void {
  res.status(REFUSAL_STATUS).json({ ok: false, error: REFUSAL_REASON });
}

function callContextFor(session: Session, agentApi: AgentApiPort): CallContext {
  return {
    resolveSessionPath: (requestedPath) => path.resolve(session.effectiveCwd(), requestedPath),
    ownsSpawnedSessions: agentApi.refuseRole(session, 'close') === null,
  };
}

interface CallTarget extends FileStores {
  session: Session;
  agentApi: AgentApiPort;
}

type PresentedReply = AgentReply | ToolImageResult;

function reshapedReply(reshape: (body: Record<string, unknown>) => Record<string, unknown>) {
  return async ({ session, agentApi }: CallTarget, verb: AgentApiVerb, payload: Record<string, unknown>): Promise<AgentReply> => {
    const reply = await agentApi.handle(session, verb, payload);
    return { status: reply.status, body: reshape(reply.body) };
  };
}

const PRESENTERS: Readonly<Record<Presenter, (target: CallTarget, verb: AgentApiVerb, payload: Record<string, unknown>) => Promise<PresentedReply>>> = {
  'agent-reply': ({ session, agentApi }, verb, payload) => agentApi.handle(session, verb, payload),
  'board-with-reading': ({ session, agentApi, getWhiteboardLayouts }, _verb, payload) => boardReplyWithReading(session, agentApi, getWhiteboardLayouts(), payload),
  'board-picture': ({ session, agentApi, getWhiteboardAssets, getWhiteboardLayouts }, _verb, payload) => boardPictureResult(session, agentApi, getWhiteboardAssets(), getWhiteboardLayouts(), payload),
  'spawn-reply': reshapedReply(spawnReplyForMcp),
  'board-without-command-guide': reshapedReply(boardReplyWithoutCommandGuide),
  'settings-list': reshapedReply(settingsListForMcp),
  'reply-text': async ({ session, agentApi }, verb, payload) => {
    const reply = await agentApi.handle(session, verb, payload);
    return reply.body.ok === true && typeof reply.body.text === 'string' ? { content: [{ type: 'text', text: reply.body.text }] } : reply;
  },
};

function toolResultOf(presented: PresentedReply) {
  return 'content' in presented ? presented : toolResultFromReply(presented);
}

function registerGroupedTool(server: McpServer, tool: GroupedTool, session: Session, agentApi: AgentApiPort, stores: FileStores): void {
  const actionNames = allowedActionNames(tool, (verb) => agentApi.refuseRole(session, verb) === null);
  if (actionNames.length === 0) return;
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaFor(tool, actionNames),
    annotations: combinedAnnotations(tool, actionNames),
    _meta: { [LOADS_UPFRONT_META_KEY]: tool.loadsUpfront },
  }, async (toolArguments: ToolArguments) => {
    const route = routeToolCall(tool, toolArguments, callContextFor(session, agentApi));
    if (!route.ok) return toolErrorResult(route.error);
    return toolResultOf(await PRESENTERS[route.presenter]({ session, agentApi, getWhiteboardAssets: stores.getWhiteboardAssets, getWhiteboardLayouts: stores.getWhiteboardLayouts }, route.verb, route.payload));
  });
}

function buildSessionServer(session: Session, agentApi: AgentApiPort, stores: FileStores): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: TOOL_SURFACE_VERSION }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: false } } });
  for (const tool of GROUPED_TOOLS) registerGroupedTool(server, tool, session, agentApi, stores);
  return server;
}

function authenticatedSession(req: Request, dependencies: AgentMcpDependencies): Session | null {
  const credential = parsePresentedCredential(req.headers.authorization);
  const session = credential ? dependencies.getSession(credential.sessionId) : null;
  const verdict = decideAgentRequest({
    sessionId: credential?.sessionId ?? null,
    presentedToken: credential?.secret ?? null,
    expectedToken: session?.agentToken ?? null,
    isLoopback: dependencies.isLoopback(req),
  });
  return verdict.ok ? session : null;
}

function mountAgentMcp(app: Express, dependencies: AgentMcpDependencies): void {
  const handler = createMcpHandler(({ authInfo }) => {
    const session = authInfo ? dependencies.getSession(authInfo.clientId) : null;
    const agentApi = dependencies.getAgentApi();
    if (!session || !agentApi) throw new Error('the MCP request lost its session');
    return buildSessionServer(session, agentApi, dependencies);
  }, { onerror: (error) => dependencies.logger.warn(`[mcp] ${error.message}`) });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => dependencies.logger.warn(`[mcp] ${error.message}`) });
  const answer = (req: AuthenticatedRequest, res: Response) => {
    const session = dependencies.isOriginAllowed(req) ? authenticatedSession(req, dependencies) : null;
    if (!session || !dependencies.getAgentApi()) {
      req.resume();
      refuse(res);
      return;
    }
    req.auth = { token: session.id, clientId: session.id, scopes: [] };
    void nodeHandler(req, res);
  };
  app.post(MCP_ROUTE, answer);
  app.get(MCP_ROUTE, answer);
}

export { MCP_ROUTE, mountAgentMcp };
export type { AgentMcpDependencies };
