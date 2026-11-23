import path from 'node:path';
import { z } from 'zod';
import { isSecretEnvName } from '../../../shared/secret-patterns.ts';
import { kimiLoginSource } from '../../../shared/kimi-login-core.ts';

const FRAME_LENGTH_BYTES = 4;
const MAX_FRAME_BYTES = 1024 * 1024;
const DECIDER_PROTOCOL_VERSION = 1;

type CredentialedAgentId = 'claude-code' | 'codex' | 'kimi';

interface ModelLoginLocation {
  fileSegments: readonly string[];
  modelHost: string;
}

interface ModelLoginLayout {
  homeEnvName: string;
  defaultHomeFolderName: string;
  loginEntryName: string;
  loginOf(loginConfigText: string | null, env: Readonly<Record<string, string | undefined>>): ModelLoginLocation | { refusal: string };
  loginConfigName: string | null;
  modelHosts: readonly string[];
  credentialClass: string;
  tokenKeyPath: readonly string[];
}

function kimiLoginLocation(loginConfigText: string | null, env: Readonly<Record<string, string | undefined>>): ModelLoginLocation | { refusal: string } {
  const login = kimiLoginSource(loginConfigText, env);
  if ('refusal' in login) return login;
  if (!URL.canParse(login.baseUrl)) return { refusal: `its Kimi Code base_url ${login.baseUrl} is not a URL` };
  return { fileSegments: login.tokenFileSegments, modelHost: new URL(login.baseUrl).hostname };
}

const MODEL_LOGIN_LAYOUTS: Readonly<Record<CredentialedAgentId, ModelLoginLayout>> = Object.freeze({
  'claude-code': { homeEnvName: 'CLAUDE_CONFIG_DIR', defaultHomeFolderName: '.claude', loginEntryName: '.credentials.json', loginOf: () => ({ fileSegments: ['.credentials.json'], modelHost: 'api.anthropic.com' }), loginConfigName: null, modelHosts: ['api.anthropic.com'], credentialClass: 'claude', tokenKeyPath: ['claudeAiOauth', 'accessToken'] },
  codex: { homeEnvName: 'CODEX_HOME', defaultHomeFolderName: '.codex', loginEntryName: 'auth.json', loginOf: () => ({ fileSegments: ['auth.json'], modelHost: 'chatgpt.com' }), loginConfigName: null, modelHosts: ['chatgpt.com'], credentialClass: 'codex', tokenKeyPath: ['tokens', 'access_token'] },
  kimi: { homeEnvName: 'KIMI_CODE_HOME', defaultHomeFolderName: '.kimi-code', loginEntryName: 'credentials', loginOf: kimiLoginLocation, loginConfigName: 'config.toml', modelHosts: ['api.kimi.com', 'api.kimi.ai'], credentialClass: 'kimi', tokenKeyPath: ['access_token'] },
});

const GITHUB_CREDENTIAL_CLASS_BY_HOST: Readonly<Record<string, string>> = Object.freeze({ 'github.com': 'github', 'api.github.com': 'api' });

function withoutInheritedCredentials(sessionEnv: Readonly<Record<string, string | undefined>>, launchSetEnvNames: readonly string[]): Record<string, string | undefined> {
  const isInheritedCredential = (name: string) => isSecretEnvName(name) && !launchSetEnvNames.includes(name);
  return Object.fromEntries(Object.entries(sessionEnv).filter(([name]) => !isInheritedCredential(name)));
}

const CREDENTIALED_HOSTS: readonly string[] = Object.freeze([...Object.values(MODEL_LOGIN_LAYOUTS).flatMap((layout) => layout.modelHosts), ...Object.keys(GITHUB_CREDENTIAL_CLASS_BY_HOST)]);

const ProxyHello = z.object({ t: z.literal('hello'), proto: z.literal(DECIDER_PROTOCOL_VERSION) }).strict();
const ProxyRequest = z.object({
  t: z.literal('req'),
  id: z.number().int().positive(),
  method: z.string(),
  host: z.string(),
  port: z.number().int(),
  path: z.string(),
}).passthrough();
const ProxyFrame = z.discriminatedUnion('t', [ProxyHello, ProxyRequest]);

type ProxyFrame = z.infer<typeof ProxyFrame>;
type ProxyRequest = z.infer<typeof ProxyRequest>;

interface LoginTokens {
  agent: string;
  modelToken: string | null;
  githubToken: string | null;
}

function isCredentialedAgent(agent: string): agent is CredentialedAgentId {
  return Object.hasOwn(MODEL_LOGIN_LAYOUTS, agent);
}

function modelLoginLayoutFor(agent: string): ModelLoginLayout | null {
  return isCredentialedAgent(agent) ? MODEL_LOGIN_LAYOUTS[agent] : null;
}

function modelLoginHomeFor(layout: ModelLoginLayout, env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolder: string | null): string {
  if (accountFolder !== null) return accountFolder;
  const configuredHome = env[layout.homeEnvName]?.trim();
  return configuredHome ? configuredHome : path.join(homeDir, layout.defaultHomeFolderName);
}

function modelLoginConfigFileFor(agent: string, env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolder: string | null = null): string | null {
  const layout = modelLoginLayoutFor(agent);
  if (layout === null || layout.loginConfigName === null) return null;
  return path.join(modelLoginHomeFor(layout, env, homeDir, accountFolder), layout.loginConfigName);
}

function modelLoginFileFor(agent: string, env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolder: string | null, loginConfigText: string | null, sessionEnv: Readonly<Record<string, string | undefined>> = env): { loginFile: string | null } | { refusal: string } {
  const layout = modelLoginLayoutFor(agent);
  if (layout === null) return { loginFile: null };
  const location = layout.loginOf(loginConfigText, sessionEnv);
  if ('refusal' in location) return location;
  if (!layout.modelHosts.includes(location.modelHost)) return { refusal: `the ${agent} login talks to ${location.modelHost}, and the sandbox places a login only on ${layout.modelHosts.join(' and ')}` };
  return { loginFile: path.join(modelLoginHomeFor(layout, env, homeDir, accountFolder), ...location.fileSegments) };
}

function modelLoginHomeOf(agent: string, env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolder: string | null = null): string | null {
  const layout = modelLoginLayoutFor(agent);
  return layout === null ? null : modelLoginHomeFor(layout, env, homeDir, accountFolder);
}

function sessionAgentHomeOf(agent: string, sessionEnv: Readonly<Record<string, string | undefined>>): string | null {
  const layout = modelLoginLayoutFor(agent);
  const sessionHome = layout === null ? undefined : sessionEnv[layout.homeEnvName]?.trim();
  return sessionHome ? sessionHome : null;
}

function modelLoginEntryFor(agent: string, env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolder: string | null = null): string | null {
  const layout = modelLoginLayoutFor(agent);
  if (layout === null) return null;
  return path.join(modelLoginHomeFor(layout, env, homeDir, accountFolder), layout.loginEntryName);
}

function everyModelLoginEntry(env: Readonly<Record<string, string | undefined>>, homeDir: string, accountFolders: readonly string[]): string[] {
  const agents = Object.keys(MODEL_LOGIN_LAYOUTS);
  const realLogins = agents.flatMap((agent) => modelLoginEntryFor(agent, env, homeDir) ?? []);
  const accountLogins = accountFolders.flatMap((accountFolder) => agents.flatMap((agent) => modelLoginEntryFor(agent, env, homeDir, accountFolder) ?? []));
  return [...realLogins, ...accountLogins];
}

function valueAtKeyPath(parsed: unknown, keyPath: readonly string[]): unknown {
  let current = parsed;
  for (const key of keyPath) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return null;
    current = Reflect.get(current, key);
  }
  return current;
}

function modelTokenFrom(agent: string, loginFileText: string): string | null {
  const layout = modelLoginLayoutFor(agent);
  if (layout === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(loginFileText);
  } catch {
    return null;
  }
  const token = valueAtKeyPath(parsed, layout.tokenKeyPath);
  return typeof token === 'string' && token !== '' ? token : null;
}

function encodeFrame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(FRAME_LENGTH_BYTES);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function createFrameReader(onFrame: (frame: ProxyFrame) => void, onViolation: (reason: string) => void): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);
  let isBroken = false;
  return (chunk) => {
    if (isBroken) return;
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= FRAME_LENGTH_BYTES) {
      const frameBytes = buffered.readUInt32BE(0);
      if (frameBytes > MAX_FRAME_BYTES) {
        isBroken = true;
        onViolation(`a ${frameBytes} byte frame is over the ${MAX_FRAME_BYTES} byte cap`);
        return;
      }
      if (buffered.length < FRAME_LENGTH_BYTES + frameBytes) return;
      const frameText = buffered.subarray(FRAME_LENGTH_BYTES, FRAME_LENGTH_BYTES + frameBytes).toString('utf8');
      buffered = buffered.subarray(FRAME_LENGTH_BYTES + frameBytes);
      const frame = parseProxyFrame(frameText);
      if (frame === null) {
        isBroken = true;
        onViolation('the proxy sent a frame the decider does not read');
        return;
      }
      onFrame(frame);
    }
  };
}

function parseProxyFrame(frameText: string): ProxyFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    return null;
  }
  const frame = ProxyFrame.safeParse(parsed);
  return frame.success ? frame.data : null;
}

function helloReply(): object {
  return { t: 'hello', proto: DECIDER_PROTOCOL_VERSION, allowedDomains: [...CREDENTIALED_HOSTS], deniedDomains: [] };
}

function credentialFor(host: string, tokens: LoginTokens): { credentialClass: string; token: string | null } | null {
  const githubClass = GITHUB_CREDENTIAL_CLASS_BY_HOST[host];
  if (githubClass !== undefined) return { credentialClass: githubClass, token: tokens.githubToken };
  const layout = modelLoginLayoutFor(tokens.agent);
  if (layout === null || !layout.modelHosts.includes(host)) return null;
  return { credentialClass: layout.credentialClass, token: tokens.modelToken };
}

function credentialSourceFor(host: string, agent: string): 'github' | 'model' | null {
  if (Object.hasOwn(GITHUB_CREDENTIAL_CLASS_BY_HOST, host)) return 'github';
  return modelLoginLayoutFor(agent)?.modelHosts.includes(host) ? 'model' : null;
}

function verdictFor(request: ProxyRequest, tokens: LoginTokens): object {
  const allow = { t: 'verdict', id: request.id, action: 'allow' };
  const credential = credentialFor(request.host, tokens);
  if (credential === null || credential.token === null) return allow;
  return { ...allow, cred: credential.credentialClass, credential: credential.token };
}

export { CREDENTIALED_HOSTS, createFrameReader, withoutInheritedCredentials, credentialSourceFor, encodeFrame, everyModelLoginEntry, helloReply, modelLoginHomeOf, sessionAgentHomeOf, modelLoginConfigFileFor, modelLoginFileFor, modelTokenFrom, verdictFor };
export type { ProxyFrame, ProxyRequest };
