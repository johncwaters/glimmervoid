import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { COHERENCE_CHECK_DETAIL_MAX_CHARS, ProjectCoherenceCheckResult } from '../../shared/contracts/coherence.ts';
import { AGENT_URL_ENV } from '../../shared/contracts/session.ts';
import { errorMessage } from '../../shared/text.ts';
import { AGENT_PATH_PREFIX, postToAgentIngress, verbEndpoint } from '../agent-api-cli.ts';
import { loadConfigFile } from '../config-store.ts';
import { decideConfigPath, glimmervoidHomeDir } from '../core/config-path-core.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { parseCoherenceCheckArgs, renderCoherenceCheckText } from './core/coherence-check-core.ts';

const DEFAULT_SERVER_PORT = 3000;
const CHECK_REPLY_TIMEOUT_MS = 120_000;
const GIT_PROBE_TIMEOUT_MS = 10_000;

const ControlTokenReply = z.looseObject({ token: z.string().min(1) });
const CheckReplyFrame = z.looseObject({ type: z.literal('project-coherence-check-response'), requestId: z.string().nullable().optional() });
const AgentRefusal = z.looseObject({ error: z.string().min(1) });

interface ConfiguredProjects {
  projects: { id: string; path: string }[];
  configPort: number | null;
}

function readConfiguredProjects(): ConfiguredProjects {
  const env = process.env;
  const decided = decideConfigPath({ env, homeDir: glimmervoidHomeDir(os.homedir(), env) }, (candidate) => fs.existsSync(candidate));
  if (!decided.path) throw new Error(`no Glimmervoid config at ${decided.source === 'env' ? decided.envPath : decided.homePath}`);
  const loaded = loadConfigFile(decided.path, { exitOnError: false });
  if ('error' in loaded) throw new Error(loaded.message);
  const projects = (loaded.config.projects ?? []).flatMap(({ id, path: projectPath }) => (id && projectPath ? [{ id, path: projectPath }] : []));
  return { projects, configPort: loaded.config.port ?? null };
}

function serverPort(configPort: number | null): number {
  const explicitPort = Number.parseInt(process.env.GLIMMERVOID_PORT ?? '', 10);
  if (Number.isInteger(explicitPort)) return explicitPort;
  return configPort ?? DEFAULT_SERVER_PORT;
}

async function mainCheckoutOf(directory: string): Promise<string | null> {
  try {
    const { stdout } = await runHardenedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: directory, timeout: GIT_PROBE_TIMEOUT_MS });
    return await realpath(path.dirname(stdout.trim()));
  } catch {
    return null;
  }
}

async function resolveProjectId(selector: string | null, projects: ConfiguredProjects['projects']): Promise<string> {
  const byId = projects.find((project) => project.id === selector);
  if (byId) return byId.id;
  const directory = path.resolve(selector ?? process.cwd());
  const checkout = await mainCheckoutOf(directory);
  if (checkout === null) throw new Error(`${selector === null ? 'this directory' : selector} is not a project id or a git repository; pass --project <id or path>`);
  for (const project of projects) {
    if (await realpath(project.path).catch(() => null) === checkout) return project.id;
  }
  throw new Error(`${checkout} is not a configured Glimmervoid project`);
}

async function fetchControlToken(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/control-token`, { signal: AbortSignal.timeout(GIT_PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`the server on port ${port} answered /control-token with ${response.status}`);
  return ControlTokenReply.parse(await response.json()).token;
}

function requestCheck(port: number, token: string, projectId: string): Promise<ProjectCoherenceCheckResult> {
  const requestId = randomUUID();
  const origin = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/control?token=${encodeURIComponent(token)}`, { origin });
  return new Promise<ProjectCoherenceCheckResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no check reply within ${CHECK_REPLY_TIMEOUT_MS / 1000} s`)), CHECK_REPLY_TIMEOUT_MS);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'project-coherence-check', projectId, requestId })));
    socket.on('error', (error) => reject(error));
    socket.on('close', () => reject(new Error('the server closed the control socket before replying')));
    socket.on('message', (data) => {
      const frame = CheckReplyFrame.safeParse(parseJsonOrNull(data.toString('utf8')));
      if (!frame.success || frame.data.requestId !== requestId) return;
      clearTimeout(timer);
      const result = ProjectCoherenceCheckResult.safeParse(frame.data);
      if (!result.success) return reject(new Error('the server sent a check reply that does not match the check result schema'));
      resolve(result.data);
    });
  }).finally(() => socket.terminate());
}

async function checkThroughOperatorControl(projectSelector: string | null): Promise<ProjectCoherenceCheckResult> {
  const configured = readConfiguredProjects();
  const projectId = await resolveProjectId(projectSelector, configured.projects);
  const port = serverPort(configured.configPort);
  return requestCheck(port, await fetchControlToken(port), projectId);
}

async function checkThroughSessionIngress(rawAgentUrl: string): Promise<ProjectCoherenceCheckResult> {
  const target = verbEndpoint(rawAgentUrl, 'coherence-check');
  if (!target.ok) throw new Error(`${AGENT_URL_ENV} must be a loopback http url under ${AGENT_PATH_PREFIX}, so nothing was sent`);
  const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body: {}, deadline: AbortSignal.timeout(CHECK_REPLY_TIMEOUT_MS) });
  const replyBody = parseJsonOrNull(reply.text);
  const result = ProjectCoherenceCheckResult.safeParse(replyBody);
  if (reply.hasSuccessStatus && result.success) return result.data;
  const refusal = AgentRefusal.safeParse(replyBody);
  throw new Error(refusal.success ? refusal.data.error : 'the session ingress sent a reply that does not match the check result schema');
}

function runCheck(projectSelector: string | null): Promise<ProjectCoherenceCheckResult> {
  const rawAgentUrl = process.env[AGENT_URL_ENV];
  if (!rawAgentUrl) return checkThroughOperatorControl(projectSelector);
  if (projectSelector !== null) throw new Error("inside a Glimmervoid session the check runs on this session's own project only, so drop --project");
  return checkThroughSessionIngress(rawAgentUrl);
}

async function runCoherenceCheckCli(args: string[]): Promise<number> {
  const parsed = parseCoherenceCheckArgs(args);
  if (!parsed.ok) {
    console.error(`glimmervoid coherence: ${parsed.error}`);
    return 1;
  }
  try {
    const result = await runCheck(parsed.projectSelector);
    console.log(parsed.isJson ? JSON.stringify(result, null, 2) : renderCoherenceCheckText(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`glimmervoid coherence check: ${errorMessage(error).slice(0, COHERENCE_CHECK_DETAIL_MAX_CHARS)}`);
    return 1;
  }
}

export { runCoherenceCheckCli };
