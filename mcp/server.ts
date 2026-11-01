import path from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Express, Request, Response } from 'express';

import type { AgentApiPort } from '../server/agent-api-wiring.ts';
import { REFUSAL_REASON, REFUSAL_STATUS, decideAgentRequest } from '../server/core/agent-api-core.ts';
import type { Session } from '../session/sessions.ts';
import { parsePresentedCredential } from './core/credentials.ts';
import { SERVER_INSTRUCTIONS } from './core/instructions.ts';
import { toolErrorResult, toolResultFromReply } from './core/tool-result.ts';
import { GROUPED_TOOLS, allowedActionNames, inputSchemaFor, routeToolCall } from './core/tools.ts';
import type { CallContext, GroupedTool, ToolArguments } from './core/tools.ts';

const MCP_ROUTE = '/mcp';
const SERVER_NAME = 'glimmervoid';
const TOOL_SURFACE_VERSION = '1';
const LOADS_UPFRONT_META_KEY = 'anthropic/alwaysLoad';

interface AgentMcpDependencies {
  getSession(id: string): Session | null;
  getAgentApi(): AgentApiPort | null;
  isLoopback(req: Request): boolean;
  logger: Pick<Console, 'warn'>;
}

type AuthenticatedRequest = Request & { auth?: { token: string; clientId: string; scopes: string[] } };

function refuse(res: Response): void {
  res.status(REFUSAL_STATUS).json({ ok: false, error: REFUSAL_REASON });
}

function callContextFor(session: Session): CallContext {
  return { resolveSessionPath: (requestedPath) => path.resolve(session.effectiveCwd(), requestedPath) };
}

function registerGroupedTool(server: McpServer, tool: GroupedTool, session: Session, agentApi: AgentApiPort): void {
  const actionNames = allowedActionNames(tool, (verb) => agentApi.refuseRole(session, verb) === null);
  if (actionNames.length === 0) return;
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaFor(tool, actionNames),
    annotations: tool.annotations,
    _meta: { [LOADS_UPFRONT_META_KEY]: tool.loadsUpfront },
  }, async (toolArguments: ToolArguments) => {
    const route = routeToolCall(tool, toolArguments, callContextFor(session));
    if (!route.ok) return toolErrorResult(route.error);
    const reply = await agentApi.handle(session, route.verb, route.payload);
    return toolResultFromReply(reply);
  });
}

function buildSessionServer(session: Session, agentApi: AgentApiPort): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: TOOL_SURFACE_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of GROUPED_TOOLS) registerGroupedTool(server, tool, session, agentApi);
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
    return buildSessionServer(session, agentApi);
  }, { onerror: (error) => dependencies.logger.warn(`[mcp] ${error.message}`) });
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => dependencies.logger.warn(`[mcp] ${error.message}`) });
  const answer = (req: AuthenticatedRequest, res: Response) => {
    const session = authenticatedSession(req, dependencies);
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
